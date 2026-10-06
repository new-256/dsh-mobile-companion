/**
 * lib/forward.mjs — 插件内 LAN 透明代理（v3.1 方案 B）。
 *
 * 职责：监听局域网可访问端口，把 HTTP/WS 请求透明转发到本地 DSH 主服务，
 *       并把 Host/Origin/Referer 改写为环回 authority，从而自然穿过
 *       DSH 信任栅栏与 Cookie 签名口径。
 */

import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { rewriteHeaders, stripSetCookieDomain } from './rewrite.mjs'

/**
 * 创建透明转发器。
 *
 * @param {object} options
 * @param {string} [options.listenHost='::']  监听地址（'::' = IPv4/IPv6 双栈）
 * @param {number} [options.listenPort=47896]
 * @param {string} [options.targetHost='127.0.0.1']
 * @param {number} options.targetPort
 * @param {object} [options.log=console]
 * @param {number} [options.maxPortScan=20]
 * @returns {Promise<{port:number, close:function}>}
 */
export function createForwarder({
  listenHost = '::',
  listenPort = 47896,
  targetHost = '127.0.0.1',
  targetPort,
  log = console,
  maxPortScan = 20,
} = {}) {
  if (!targetPort || !Number.isFinite(targetPort)) {
    return Promise.reject(new Error('targetPort 必须指定'))
  }

  const targetAuthority = `${targetHost}:${targetPort}`

  const server = createServer()
  const activeSockets = new Set()
  let closed = false
  let actualPort = listenPort

  // ── HTTP 转发 ───────────────────────────────────────────────────
  server.on('request', (clientReq, clientRes) => {
    if (closed) {
      clientRes.writeHead(503)
      clientRes.end('forwarder closed')
      return
    }

    const headers = rewriteHeaders(clientReq.headers, targetAuthority)
    const options = {
      hostname: targetHost,
      port: targetPort,
      method: clientReq.method,
      path: clientReq.url,
      headers,
    }

    const proxyReq = request(options, (proxyRes) => {
      // 剥除响应 Set-Cookie 里的 Domain 属性，避免浏览器按代理 authority 拒收
      const rawHeaders = stripSetCookieDomain(proxyRes.rawHeaders)
      clientRes.writeHead(proxyRes.statusCode, proxyRes.statusMessage, rawHeaders)
      proxyRes.pipe(clientRes)
    })

    proxyReq.on('error', (err) => {
      log.warn?.(`转发 HTTP 请求失败: ${err.message}`)
      if (!clientRes.headersSent) {
        clientRes.writeHead(502)
        clientRes.end('Bad Gateway')
      }
    })

    clientReq.pipe(proxyReq)
  })

  // ── WebSocket 升级 ─────────────────────────────────────────────
  server.on('upgrade', (clientReq, clientSocket, head) => {
    if (closed) {
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      return
    }

    activeSockets.add(clientSocket)
    clientSocket.on('close', () => activeSockets.delete(clientSocket))

    const targetSocket = connect({ host: targetHost, port: targetPort }, () => {
      activeSockets.add(targetSocket)
      targetSocket.on('close', () => activeSockets.delete(targetSocket))

      // 构造原始请求行 + 改写后的头
      const headers = rewriteHeaders(clientReq.headers, targetAuthority)
      const lines = [
        `${clientReq.method} ${clientReq.url} HTTP/1.1`,
      ]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const v of value) lines.push(`${key}: ${v}`)
        } else if (value != null) {
          lines.push(`${key}: ${value}`)
        }
      }
      lines.push('', '')
      targetSocket.write(lines.join('\r\n'))
      if (head?.length) targetSocket.write(head)

      // 先读目标的 101 响应头，原样回写；之后裸 pipe
      let buffer = Buffer.alloc(0)
      let headerParsed = false

      function onData(chunk) {
        buffer = Buffer.concat([buffer, chunk])
        if (headerParsed) return

        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1) return

        headerParsed = true
        const headerBytes = buffer.slice(0, end + 4)
        const bodyRemainder = buffer.slice(end + 4)
        targetSocket.pause()

        clientSocket.write(headerBytes, () => {
          clientSocket.pipe(targetSocket)
          targetSocket.pipe(clientSocket)
          targetSocket.resume()
          if (bodyRemainder.length) targetSocket.unshift(bodyRemainder)
        })
      }

      targetSocket.on('data', onData)
    })

    targetSocket.on('error', (err) => {
      log.warn?.(`转发 WS 目标连接失败: ${err.message}`)
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      }
    })

    clientSocket.on('error', (err) => {
      log.warn?.(`WS 客户端连接错误: ${err.message}`)
      targetSocket.destroy()
    })
  })

  // ── 启动并处理端口占用漂移 ─────────────────────────────────────
  return tryListen(server, listenHost, listenPort, maxPortScan)
    .then((port) => {
      actualPort = port
      return {
        port,
        close() {
          if (closed) return
          closed = true
          for (const s of activeSockets) {
            try { s.destroy() } catch {}
          }
          activeSockets.clear()
          server.closeAllConnections?.()
          return new Promise((resolve) => {
            server.close(() => resolve())
          })
        },
      }
    })
}

function tryListen(server, host, startPort, maxScan) {
  return new Promise((resolve, reject) => {
    let attempts = 0

    function attempt(port) {
      attempts++
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts <= maxScan) {
          attempt(port + 1)
        } else {
          reject(err)
        }
      })
      server.listen(port, host, () => {
        resolve(server.address().port)
      })
    }

    attempt(startPort)
  })
}

