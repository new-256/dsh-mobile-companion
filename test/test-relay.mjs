// test-relay.mjs — 中继服务器 + 宿主隧道端到端测试
//
// 覆盖：HTTP 经 /i/<id> 透传、头改写、POST 体、WS echo、离线 502、错误 key 拒绝。

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY_ROOT = join(HERE, '..', '..', '..', 'relay')
const { createRelay } = await import(pathToFileURL(join(RELAY_ROOT, 'lib', 'relay.mjs')).href)
const { createTunnel } = await import(pathToFileURL(join(HERE, '..', 'lib', 'tunnel.mjs')).href)
const { clientWSConnect, encodeText, parseFrames } = await import(pathToFileURL(join(HERE, '..', 'lib', 'ws-framing.mjs')).href)

const KEY = 'test-relay-key-' + randomBytes(8).toString('hex')
const INSTANCE = 'test-instance-01'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

let failed = 0
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++ }

async function waitConnected(tunnel, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('隧道连接超时')), timeoutMs)
    const iv = setInterval(() => {
      if (tunnel.status().state === 'connected') {
        clearInterval(iv); clearTimeout(deadline); resolve()
      }
    }, 50)
  })
}

async function main() {
  // ── 假目标 HTTP 服务器 ──────────────────────────────────────────────────
  const target = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        referer: req.headers.referer,
        body,
      }))
    })
  })
  await new Promise(r => target.listen(0, '127.0.0.1', r))
  const targetPort = target.address().port

  // ── 启动中继 ─────────────────────────────────────────────────────────────
  const relay = await createRelay({ port: 0, host: '127.0.0.1', key: KEY, log: { info() {}, warn() {} } })
  const relayPort = relay.port

  // ── 启动隧道 ─────────────────────────────────────────────────────────────
  const tunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    key: KEY,
    instanceId: INSTANCE,
    targetHost: '127.0.0.1',
    targetPort,
    log: { info() {}, warn() {} },
  })
  await waitConnected(tunnel)

  // ── 1. HTTP GET 经 /i/<id>/path ───────────────────────────────────────────
  const r1 = await fetch(`http://127.0.0.1:${relayPort}/i/${INSTANCE}/api/foo?bar=1`, {
    headers: {
      'host': `relay.example.com`,
      'origin': `http://relay.example.com`,
      'referer': `http://relay.example.com/m/page`,
    },
  })
  const j1 = await r1.json()
  ok(r1.status === 200, 'HTTP GET 返回 200')
  ok(j1.url === '/api/foo?bar=1', '路径与查询串透传')
  ok(j1.host === `127.0.0.1:${targetPort}`, 'Host 已改写为环回')
  ok(j1.origin === `http://127.0.0.1:${targetPort}`, 'Origin 已改写为环回')
  ok(j1.referer === `http://127.0.0.1:${targetPort}/m/page`, 'Referer 只改 authority、保留路径')

  // ── 2. POST 体透传 ────────────────────────────────────────────────────────
  const r2 = await fetch(`http://127.0.0.1:${relayPort}/i/${INSTANCE}/api/post`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello-relay',
  })
  const j2 = await r2.json()
  ok(j2.method === 'POST' && j2.body === 'hello-relay', 'POST 体透传')

  // ── 3. 实例不在线 → 502 ───────────────────────────────────────────────────
  const r3 = await fetch(`http://127.0.0.1:${relayPort}/i/offline-instance/api/x`)
  const t3 = await r3.text()
  ok(r3.status === 502, '离线实例返回 502')
  ok(t3.includes('宿主未连接'), '502 页面含中文说明')

  // ── 4. 错误 key 的隧道被拒绝 ───────────────────────────────────────────────
  const badTunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    key: 'wrong-key',
    instanceId: 'bad-instance',
    targetHost: '127.0.0.1',
    targetPort,
    log: { info() {}, warn() {} },
  })
  await new Promise(r => setTimeout(r, 300))
  const badStatus = badTunnel.status()
  ok(badStatus.state === 'error' || badStatus.state === 'idle', `错误 key 隧道连接失败（状态 ${badStatus.state}）`)
  badTunnel.close()

  // ── 5. WS echo 经中继双向透传 ──────────────────────────────────────────────
  const wsTarget = createServer()
  await new Promise(r => wsTarget.listen(0, '127.0.0.1', r))
  const wsTargetPort = wsTarget.address().port

  wsTarget.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    )
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = parseFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.opcode === 0x01) {
          const text = f.payload.toString('utf8')
          socket.write(encodeText('echo:' + text))
        }
      }
    })
  })

  const wsTunnel = createTunnel({
    relayUrl: `ws://127.0.0.1:${relayPort}`,
    key: KEY,
    instanceId: 'ws-instance',
    targetHost: '127.0.0.1',
    targetPort: wsTargetPort,
    log: { info() {}, warn() {} },
  })
  await waitConnected(wsTunnel)

  const { socket: wsClient, head } = await clientWSConnect(`ws://127.0.0.1:${relayPort}/i/ws-instance/ws`)
  if (head && head.length) wsClient.unshift(head)

  const echoed = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    wsClient.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = parseFrames(buf)
      buf = rest
      for (const f of frames) {
        if (f.opcode === 0x01) return resolve(f.payload.toString('utf8'))
      }
    })
    wsClient.write(encodeText('hello-relay-ws'))
    setTimeout(() => reject(new Error('WS echo 超时')), 5000)
  })
  ok(echoed === 'echo:hello-relay-ws', 'WS 文本帧经中继双向透传并回显')

  // 清理
  wsClient.destroy()
  wsTunnel.close()
  tunnel.close()
  await relay.close()
  target.close()
  target.closeAllConnections?.()
  wsTarget.close()
  wsTarget.closeAllConnections?.()
  await new Promise(r => setTimeout(r, 100))

  console.log(failed === 0 ? '\n中继测试全部通过' : `\n${failed} 例失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
