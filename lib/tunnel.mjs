/**
 * lib/tunnel.mjs — 宿主隧道客户端（outbound WSS → 中继）。
 *
 * 职责：
 *   1. 通过 WSS 接入 dsh-mobile-relay。
 *   2. 在单条 WSS 上承载多路复用流，把流量透明转发到本地 DSH。
 *   3. 自动重连（指数退避 1s → 30s）。
 *
 * 与 lib/forward.mjs 共用 rewrite.mjs 的 Host/Origin/Referer 改写逻辑，
 * 确保 DSH 信任栅栏与 Cookie 签名口径一致。
 */

import { request } from 'node:http'
import { connect } from 'node:net'
import { rewriteHeaders } from './rewrite.mjs'
import { clientWSConnect, encodeText, encodeBinary, encodePong, parseFrames, encodeClose } from './ws-framing.mjs'

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const IDLE_TIMEOUT_MS = 120_000

export function createTunnel({
  relayUrl,
  key,
  instanceId,
  targetHost = '127.0.0.1',
  targetPort,
  log = console,
  reconnect = true,
} = {}) {
  if (!relayUrl || !key || !instanceId) {
    throw new Error('tunnel 需要 relayUrl、key、instanceId')
  }
  if (!targetPort) throw new Error('targetPort 必须指定')

  const targetAuthority = `${targetHost}:${targetPort}`
  let state = 'idle' // idle / connecting / connected / error / closed
  let stateSince = Date.now()
  let socket = null
  let wrap = null
  let closed = false
  let streams = new Map()
  let reconnectTimer = null
  let backoff = INITIAL_BACKOFF_MS
  let bytes = { in: 0, out: 0 }

  function setState(s) {
    state = s
    stateSince = Date.now()
  }

  function connectUrl() {
    const u = new URL(relayUrl)
    u.pathname = '/tunnel'
    u.search = `?instance=${encodeURIComponent(instanceId)}&key=${encodeURIComponent(key)}`
    return u.toString()
  }

  async function doConnect() {
    if (closed) return
    setState('connecting')
    try {
      const { socket: s, head } = await clientWSConnect(connectUrl())
      socket = s
      if (head && head.length) s.unshift(head)
      setupSocket(s)
      backoff = INITIAL_BACKOFF_MS
      setState('connected')
      log.info?.(`隧道已连接: ${instanceId} -> ${new URL(relayUrl).host}`)
    } catch (e) {
      log.warn?.(`隧道连接失败: ${e.message}`)
      setState('error')
      scheduleReconnect()
    }
  }

  function setupSocket(s) {
    let buffer = Buffer.alloc(0)
    s.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const { frames, rest } = parseFrames(buffer)
      buffer = rest
      for (const f of frames) {
        if (f.opcode === 0x01) {
          try {
            handleControl(JSON.parse(f.payload.toString('utf8')))
          } catch (err) {
            log.warn?.(`控制帧解析失败: ${err.message}`)
          }
        } else if (f.opcode === 0x02) {
          handleBinary(f.payload)
        } else if (f.opcode === 0x08) {
          closeSocket(1000, 'remote close')
        } else if (f.opcode === 0x09) {
          s.write(encodePong(f.payload))
        }
      }
    })
    s.on('close', () => {
      closeSocket(1006, 'socket closed')
      if (!closed && reconnect) scheduleReconnect()
    })
    s.on('error', (err) => {
      log.warn?.(`隧道 socket 错误: ${err.message}`)
      closeSocket(1011, err.message)
      if (!closed && reconnect) scheduleReconnect()
    })

    wrap = {
      sendControl(obj) {
        try { s.write(encodeText(JSON.stringify(obj))) } catch {}
      },
      sendData(sid, buf) {
        const frame = Buffer.allocUnsafe(1 + 4 + buf.length)
        frame[0] = 0x01
        frame.writeUInt32BE(sid, 1)
        buf.copy(frame, 5)
        try { s.write(encodeBinary(frame)) } catch {}
      },
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || closed) return
    setState('error')
    log.info?.(`隧道将在 ${backoff}ms 后重连`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!closed) doConnect()
    }, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  function closeSocket(code, reason) {
    if (!socket) return
    try { socket.write(encodeClose(code, reason)) } catch {}
    try { socket.destroy() } catch {}
    socket = null
    wrap = null
    for (const [sid, stream] of streams) resetStream(sid, reason)
    streams.clear()
    setState('error')
  }

  function handleControl(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'hello') return // 预留 E2E
    if (msg.t === 'reset') {
      if (msg.sid && streams.has(msg.sid)) resetStream(msg.sid, msg.reason || 'remote reset')
      return
    }
    if (msg.t === 'ping') {
      wrap?.sendControl({ t: 'pong' })
      return
    }
    if (msg.t === 'reqend') {
      const stream = streams.get(msg.sid)
      if (stream && stream.type === 'http' && stream.targetReq && !stream.reqEnded) {
        stream.reqEnded = true
        try { stream.targetReq.end() } catch {}
      }
      return
    }
    if (msg.t !== 'open') return

    const sid = msg.sid
    if (streams.has(sid)) resetStream(sid, 'collision')
    const stream = {
      sid,
      timer: setTimeout(() => resetStream(sid, 'idle timeout'), IDLE_TIMEOUT_MS),
    }
    streams.set(sid, stream)

    const isWS = String(msg.method).toUpperCase() === 'GET' && /websocket/i.test(msg.headers?.upgrade || '')
    if (isWS) {
      handleTargetWS(stream, msg.path, msg.headers)
    } else {
      handleTargetHttp(stream, msg.method, msg.path, msg.headers)
    }
  }

  function handleTargetHttp(stream, method, path, headers) {
    const rewritten = rewriteHeaders(headers, targetAuthority)
    const targetReq = request({
      hostname: targetHost,
      port: targetPort,
      method,
      path,
      headers: rewritten,
    }, (targetRes) => {
      clearTimeout(stream.timer)
      stream.timer = setTimeout(() => resetStream(stream.sid, 'idle timeout'), IDLE_TIMEOUT_MS)
      wrap.sendControl({
        t: 'head',
        sid: stream.sid,
        status: targetRes.statusCode,
        headers: targetRes.headers,
      })
      targetRes.on('data', (chunk) => {
        bytes.in += chunk.length
        clearTimeout(stream.timer)
        stream.timer = setTimeout(() => resetStream(stream.sid, 'idle timeout'), IDLE_TIMEOUT_MS)
        wrap.sendData(stream.sid, chunk)
      })
      targetRes.on('end', () => {
        clearTimeout(stream.timer)
        wrap.sendControl({ t: 'end', sid: stream.sid })
        streams.delete(stream.sid)
      })
      targetRes.on('error', (err) => resetStream(stream.sid, err.message))
    })

    targetReq.on('error', (err) => {
      resetStream(stream.sid, `target error: ${err.message}`)
    })

    stream.targetReq = targetReq
    stream.type = 'http'
    stream.pendingBody = []

    // 若数据帧已提前到达，先排队；若 reqend 已收到，立即 end
    flushPendingBody(stream)
    if (stream.reqEnded) {
      try { targetReq.end() } catch {}
    }
  }

  function handleTargetWS(stream, path, headers) {
    const rewritten = rewriteHeaders(headers, targetAuthority)
    const lines = [`GET ${path} HTTP/1.1\r\n`]
    for (const [k, v] of Object.entries(rewritten)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}\r\n`)
      else if (v != null) lines.push(`${k}: ${v}\r\n`)
    }
    lines.push('\r\n')
    const headBuf = Buffer.from(lines.join(''), 'utf8')

    const targetSocket = connect({ host: targetHost, port: targetPort }, () => {
      log.info?.(`目标 WS 已连接: ${targetHost}:${targetPort}`)
      targetSocket.write(headBuf)
      stream.targetSocket = targetSocket
      stream.type = 'ws'
      stream.handshaked = false
      stream.pendingBody = []

      let buffer = Buffer.alloc(0)
      function onData(chunk) {
        buffer = Buffer.concat([buffer, chunk])
        if (!stream.handshaked) {
          const end = buffer.indexOf('\r\n\r\n')
          if (end === -1) return
          const headerBytes = buffer.slice(0, end + 4)
          const rest = buffer.slice(end + 4)
          const { status, headers } = parseResponseHeaders(headerBytes)
          wrap.sendControl({ t: 'head', sid: stream.sid, status, headers })
          stream.handshaked = true
          buffer = rest
          bytes.in += headerBytes.length
          if (rest.length) forwardRawToRelay(stream, rest)
        } else {
          forwardRawToRelay(stream, chunk)
        }
      }
      targetSocket.on('data', onData)
      targetSocket.on('close', () => resetStream(stream.sid, 'target ws closed'))
      targetSocket.on('error', (err) => resetStream(stream.sid, err.message))

      flushPendingBody(stream)
    })

    targetSocket.on('error', (err) => {
      log.warn?.(`目标 WS 连接错误: ${err.message}`)
      resetStream(stream.sid, `target ws connect error: ${err.message}`)
    })
  }

  function forwardRawToRelay(stream, chunk) {
    bytes.in += chunk.length
    clearTimeout(stream.timer)
    stream.timer = setTimeout(() => resetStream(stream.sid, 'idle timeout'), IDLE_TIMEOUT_MS)
    wrap.sendData(stream.sid, chunk)
  }

  function flushPendingBody(stream) {
    if (!stream.pendingBody?.length) return
    for (const chunk of stream.pendingBody) {
      if (stream.type === 'http' && stream.targetReq && !stream.targetReq.destroyed) {
        stream.targetReq.write(chunk)
      } else if (stream.type === 'ws' && stream.targetSocket && stream.handshaked) {
        stream.targetSocket.write(chunk)
      }
    }
    stream.pendingBody = []
    if (stream.type === 'http' && stream.reqEnded && stream.targetReq && !stream.targetReq.destroyed) {
      try { stream.targetReq.end() } catch {}
    }
  }

  function handleBinary(payload) {
    if (payload.length < 5) return
    const sid = payload.readUInt32BE(1)
    const data = payload.slice(5)
    bytes.out += payload.length
    const stream = streams.get(sid)
    if (!stream) return

    clearTimeout(stream.timer)
    stream.timer = setTimeout(() => resetStream(sid, 'idle timeout'), IDLE_TIMEOUT_MS)

    if (stream.type === 'http' && stream.targetReq && !stream.targetReq.destroyed) {
      stream.targetReq.write(data)
    } else if (stream.type === 'ws') {
      if (!stream.targetSocket) {
        stream.pendingBody = stream.pendingBody || []
        stream.pendingBody.push(data)
      } else if (stream.handshaked) {
        stream.targetSocket.write(data)
      } else {
        stream.pendingBody = stream.pendingBody || []
        stream.pendingBody.push(data)
      }
    }
  }

  function resetStream(sid, reason) {
    const stream = streams.get(sid)
    if (!stream) return
    clearTimeout(stream.timer)
    if (stream.targetReq && !stream.targetReq.destroyed) {
      try { stream.targetReq.destroy() } catch {}
    }
    if (stream.targetSocket && !stream.targetSocket.destroyed) {
      try { stream.targetSocket.destroy() } catch {}
    }
    try { wrap?.sendControl({ t: 'reset', sid, reason: reason || 'closed' }) } catch {}
    streams.delete(sid)
  }

  function parseResponseHeaders(buf) {
    const text = buf.toString('utf8')
    const lines = text.split('\r\n')
    const first = lines[0]
    const m = /HTTP\/1\.\d\s+(\d+)/.exec(first)
    const status = m ? Number(m[1]) : 502
    const headers = {}
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) break
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const k = line.slice(0, colon).trim().toLowerCase()
      const v = line.slice(colon + 1).trim()
      if (headers[k] !== undefined) {
        if (!Array.isArray(headers[k])) headers[k] = [headers[k]]
        headers[k].push(v)
      } else {
        headers[k] = v
      }
    }
    return { status, headers }
  }

  // 启动
  doConnect()

  return {
    close() {
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      closeSocket(1000, 'client close')
      setState('closed')
    },
    status() {
      return {
        enabled: true,
        state,
        since: stateSince,
        instanceId,
        relayUrl,
        targetAuthority,
        streams: streams.size,
        bytes,
      }
    },
  }
}
