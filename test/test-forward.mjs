// test-forward.mjs — 透明转发器单元测试
// 校验：HTTP 头改写、请求/响应体透传、Set-Cookie Domain 剥离、WS 裸转发、端口漂移
import { createServer, get } from 'node:http'
import { createServer as createNetServer, connect } from 'node:net'
import { createHash } from 'node:crypto'
import { createForwarder } from '../lib/forward.mjs'

let failed = 0
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++ }

async function closeServer(server) {
  server.close()
  server.closeAllConnections?.()
  await Promise.race([
    new Promise(r => server.once('close', r)),
    new Promise(r => setTimeout(r, 200)),
  ])
}

// ── 1. HTTP 转发：头改写 + 体透传 ───────────────────────────────────────
const target = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': [
        'session=abc; Domain=example.com; Path=/',
        'token=xyz; Domain=lan-ip; Secure',
      ],
    })
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

const fwd = await createForwarder({
  listenHost: '127.0.0.1',
  listenPort: 0, // 让系统分配，避免冲突
  targetHost: '127.0.0.1',
  targetPort,
  log: { warn() {}, info() {} },
})

// 1.1 GET 请求
const getRes = await fetch(`http://127.0.0.1:${fwd.port}/api/foo?bar=1`, {
  headers: {
    'host': `192.168.1.100:${fwd.port}`,
    'origin': `http://192.168.1.100:${fwd.port}`,
    'referer': `http://192.168.1.100:${fwd.port}/m/page`,
  },
})
const getJson = await getRes.json()
ok(getJson.host === `127.0.0.1:${targetPort}`, 'Host 已改写为环回 authority')
ok(getJson.origin === `http://127.0.0.1:${targetPort}`, 'Origin 已改写')
ok(getJson.referer === `http://127.0.0.1:${targetPort}/m/page`, 'Referer 只改 scheme+authority、保留路径')
ok(getRes.status === 200 && getJson.url === '/api/foo?bar=1', '路径与查询串透传')

// 1.2 Set-Cookie Domain 剥离
const cookies = getRes.headers.getSetCookie()
ok(!cookies.some(c => /domain=/i.test(c)), 'Set-Cookie 中 Domain 属性已被剥离')
ok(cookies.some(c => c.includes('session=abc')), 'Cookie 本体仍保留')

// 1.3 POST 体透传
const postRes = await fetch(`http://127.0.0.1:${fwd.port}/api/post`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: 'hello-forward',
})
const postJson = await postRes.json()
ok(postJson.method === 'POST' && postJson.body === 'hello-forward', 'POST 请求体透传')

await fwd.close()
await closeServer(target)

// ── 2. WebSocket 双向裸转发 ─────────────────────────────────────────────
const wsTarget = createServer()
await new Promise(r => wsTarget.listen(0, '127.0.0.1', r))
const wsTargetPort = wsTarget.address().port

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
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

  // 解析一帧文本并原样发回
  let buf = Buffer.alloc(0)
  function parse() {
    if (buf.length < 2) return
    const first = buf[0]
    const second = buf[1]
    const opcode = first & 0x0f
    const masked = second & 0x80
    let len = second & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < 4) return
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) return
      len = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    let maskKey
    if (masked) {
      if (buf.length < offset + 4) return
      maskKey = buf.slice(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + len) return
    let payload = buf.slice(offset, offset + len)
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4]
      }
    }
    buf = buf.slice(offset + len)

    if (opcode === 0x1) {
      const text = payload.toString('utf8')
      // 回写同样文本（服务器到客户端无需掩码）
      const out = Buffer.from(text, 'utf8')
      const header = Buffer.allocUnsafe(2 + (out.length < 126 ? 0 : 2))
      header[0] = 0x81 // FIN + text
      if (out.length < 126) {
        header[1] = out.length
      } else {
        header[1] = 126
        header.writeUInt16BE(out.length, 2)
      }
      socket.write(Buffer.concat([header, out]))
    }
    parse()
  }
  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); parse() })
})

const wsFwd = await createForwarder({
  listenHost: '127.0.0.1',
  listenPort: 0,
  targetHost: '127.0.0.1',
  targetPort: wsTargetPort,
  log: { warn() {}, info() {} },
})

const wsKey = createHash('sha1').update(String(Date.now())).digest('base64')
const wsReq = get({
  host: '127.0.0.1',
  port: wsFwd.port,
  path: '/ws',
  headers: {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Key': wsKey,
    'Sec-WebSocket-Version': '13',
    'Host': `lan:${wsFwd.port}`,
    'Origin': `http://lan:${wsFwd.port}`,
  },
})

const { socket: wsSocket, headers: wsHeaders } = await new Promise((resolve, reject) => {
  wsReq.on('upgrade', (res, socket, head) => resolve({ headers: res.headers, socket, head }))
  wsReq.on('error', reject)
})

ok(wsHeaders['sec-websocket-accept'] != null, 'WS 握手 101 响应头透传')

// 发送一帧文本（客户端必须掩码）
const msg = 'hello-ws'
const payload = Buffer.from(msg, 'utf8')
const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
const masked = Buffer.from(payload)
for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
const frame = Buffer.concat([
  Buffer.from([0x81, 0x80 | payload.length]),
  mask,
  masked,
])
wsSocket.write(frame)

const echoed = await new Promise((resolve) => {
  const chunks = []
  wsSocket.on('data', (chunk) => {
    chunks.push(chunk)
    // 帧头最多 2 字节，长度 126 时 +2，这里 len=8，帧总长 10 字节
    const all = Buffer.concat(chunks)
    if (all.length >= 2) {
      const len = all[1] & 0x7f
      if (all.length >= 2 + len) {
        resolve(all.slice(2, 2 + len).toString('utf8'))
      }
    }
  })
})
ok(echoed === msg, 'WS 文本帧经转发器双向透传并回显')

wsSocket.destroy()
await wsFwd.close()
await closeServer(wsTarget)

// ── 3. EADDRINUSE 端口自动 +1 ──────────────────────────────────────────
const dummyTarget = createServer()
await new Promise(r => dummyTarget.listen(0, '127.0.0.1', r))
const dummyPort = dummyTarget.address().port

const occupier = createNetServer()
await new Promise((resolve, reject) => {
  occupier.once('error', reject)
  occupier.listen(47896, '127.0.0.1', () => resolve())
})

const driftFwd = await createForwarder({
  listenHost: '127.0.0.1',
  listenPort: 47896,
  targetHost: '127.0.0.1',
  targetPort: dummyPort,
  log: { warn() {}, info() {} },
})

ok(driftFwd.port === 47897, `端口 47896 被占用时自动漂移至 47897（实际 ${driftFwd.port}）`)
await driftFwd.close()
occupier.close()
await closeServer(dummyTarget)

console.log(failed === 0 ? `\n转发器测试全部通过` : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
