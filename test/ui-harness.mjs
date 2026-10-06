/**
 * ui-harness.mjs — 移动 UI 回归测试台。
 *
 * 把插件挂在本地端口上，并用**模拟 DSH 后端**满足 /m/ UI 的全部调用：
 *   /api/mobile/*             → 插件自身路由（无鉴权，测试台专用）
 *   /api/<rpc>                → 一元 RPC 信封（{type:'server-response', result:{ok:true,value}}）
 *   /api/remote.mux (WS)      → 流式模拟（workspace/follow 快照 + 心跳）
 *   /api/session-cleaner/*    → 回收站模拟
 *
 * 用途：配合 Playwright 打真实浏览器，验证各 Tab 渲染不出现
 * 「[object HTMLDivElement]」这类结构性 bug（历史上出现过 replaceChildren(array)）。
 *
 * 用法：node test/ui-harness.mjs [port]
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PORT = Number(process.argv[2]) || 47899

// ── 模拟数据 ────────────────────────────────────────────────────────────
const WORKSPACE = {
  workspaceId: 'ws-demo-1',
  path: 'C:/demo/workspace',
  title: '演示工作区',
  sessionIds: ['sess-demo-1', 'sess-demo-2'],
  updatedAt: Date.now(),
}
const SESSIONS = [
  { sessionId: 'sess-demo-1', updatedAt: Date.now(), projections: { title: '演示会话一' }, blank: false },
  { sessionId: 'sess-demo-2', updatedAt: Date.now() - 60000, projections: { title: '演示会话二' }, blank: false },
]
const TRASH = [
  { sessionId: 'sess-trash-1', title: '已删除的会话', workspaceTitle: '演示工作区', deletedAt: Date.now() - 3600000, dirSize: 20480 },
]

/** 最近一次 session/prompt 的入参（供附件回执断言） */
let lastPrompt = null
/** 最近一次上传（供附件断言） */
let lastUpload = null

const RPC = {
  'session/list': () => ({ items: SESSIONS }),
  'session/page': () => ({ items: [], hasMore: false }),
  'session/create': () => ({ sessionId: 'sess-new-1' }),
  'session/prompt': (args) => { lastPrompt = args; return { ok: true } },
  'session/cancel': () => ({ ok: true }),
  'pluginInventory/list': () => ({ entries: [
    { entryId: 'mobile-companion', moduleName: 'dsh-mobile-companion', enabled: true, fiberPhase: 'active' },
    { entryId: 'bot-gateway', moduleName: 'dsh-bot-gateway', enabled: true, fiberPhase: 'active' },
  ] }),
  'settings/describe': () => ({ namespaces: [
    { ns: 'dsh-mobile-companion', schema: { type: 'object', props: { proxy: { type: 'boolean' }, proxyPort: { type: 'number' }, lanIps: { type: 'string' } } }, value: { proxy: true, proxyPort: 47896, lanIps: '' }, revision: 1, secrets: { list: [] } },
  ] }),
  'settings/update': () => ({ ok: true }),
  'workspace/archiveSession': () => ({ ok: true }),
  'workspace/list': () => ({ items: [WORKSPACE] }),
}

// ── 挂载插件（mock cordis ctx）──────────────────────────────────────────
const exact = new Map()
const prefixes = new Map()
const fetchRoutes = new Map()
const disposers = []
const services = new Map()
const mockWebServer = {
  host: '0.0.0.0',
  port: PORT,
  register(route) {
    const table = route.kind === 'exact' ? exact : prefixes
    table.set(route.path, route)
    return () => table.delete(route.path)
  },
}
const mockCtx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  provide(n, v) { services.set(n, v) },
  get: (n) => services.get(n),
  webServer: mockWebServer,
  connection: {
    authenticatedUrl: (base) => `${base}/?token=harness`,
    requestRejection: () => undefined,
    fetch: { register(route) { fetchRoutes.set(route.path, route); return () => fetchRoutes.delete(route.path) } },
  },
}

const { apply } = await import(`file:///${PLUGIN_DIR.replace(/\\/g, '/')}/index.mjs`)
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-mc-ui-'))
apply(mockCtx, { dataPath: dataDir, proxy: false })

// ── 最小 WebSocket（RFC6455）服务端 ─────────────────────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}
function encodeText(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, payload])
}
function decodeFrames(buf) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f
    const masked = (buf[offset + 1] & 0x80) !== 0
    let len = buf[offset + 1] & 0x7f
    let p = offset + 2
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    const maskKey = masked ? buf.subarray(p, p + 4) : null
    if (masked) p += 4
    if (p + len > buf.length) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    frames.push({ opcode, text: payload.toString('utf8') })
    offset = p + len
  }
  return { frames, rest: buf.subarray(offset) }
}

// ── HTTP 服务器 ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  try {
    // 测试台自省接口（只在本 harness 存在）
    if (path === '/__last-prompt') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt: lastPrompt, upload: lastUpload }))
      return
    }
    // 附件原始字节上传（复刻 dsh-client-file-upload 的 FILE_UPLOAD_PATH 契约）
    if (path === '/api/session/uploadFileBinary') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const bytes = Buffer.concat(chunks)
      const name = url.searchParams.get('name') || 'file'
      const sessionId = url.searchParams.get('sessionId')
      lastUpload = { sessionId, name, bytes: bytes.length, mediaType: req.headers['content-type'] }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        receiptId: `rcpt-${sessionId}-${bytes.length}`,
        file: { attachmentId: `att-${bytes.length}`, name, bytes: bytes.length },
      }))
      return
    }
    // 模拟 DSH RPC
    if (path.startsWith('/api/') && !path.startsWith('/api/mobile/') && !path.startsWith('/api/session-cleaner/')) {
      const ep = path.slice('/api/'.length)
      const chunks = []
      for await (const c of req) chunks.push(c)
      let args = {}
      try { args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
      const handler = RPC[ep]
      const value = handler ? handler(args) : {}
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: args.rpcId, result: { ok: true, value } }))
      return
    }
    // 回收站模拟（session-cleaner 插件不在测试台内）
    if (path === '/api/session-cleaner/trash') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, trash: TRASH }))
      return
    }
    if (path.startsWith('/api/session-cleaner/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
      return
    }
    // 插件 fetch 路由（/api/mobile/*）
    if (path.startsWith('/api/')) {
      const froute = fetchRoutes.get(path)
      if (!froute) { res.writeHead(404); res.end('not found'); return }
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      const response = await froute.fetch({
        method: req.method, url: req.url, headers: req.headers,
        text: async () => raw, json: async () => JSON.parse(raw || '{}'),
      })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
      return
    }
    // 插件 webServer 路由（/m/ 等）
    const exactHit = exact.get(path)
    const route = exactHit || (() => {
      let best
      for (const [prefix, r] of prefixes) {
        if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
        if (!best || prefix.length > best.path.length) best = r
      }
      return best
    })()
    if (route) return void (await route.handler(req, res))
    res.writeHead(404)
    res.end('no route')
  } catch (e) {
    res.writeHead(500)
    res.end(String(e))
  }
})

// WS：/api/remote.mux
let wsSeq = 0
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/api/remote.mux') { socket.destroy(); return }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}`,
    '', '',
  ].join('\r\n'))
  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    const { frames, rest } = decodeFrames(buf)
    buf = rest
    for (const f of frames) {
      if (f.opcode === 0x8) { socket.destroy(); continue }
      if (f.opcode !== 0x1) continue
      let msg
      try { msg = JSON.parse(f.text) } catch { continue }
      if (msg.type === 'open') {
        wsSeq++
        if (msg.endpoint === 'workspace/follow') {
          socket.write(encodeText(JSON.stringify({
            type: 'item', streamId: msg.streamId,
            value: { type: 'baseline', value: { items: [WORKSPACE], archivedSessionIds: [] } },
          })))
        } else if (msg.endpoint === 'session/follow') {
          socket.write(encodeText(JSON.stringify({
            type: 'item', streamId: msg.streamId,
            value: { type: 'snapshot', records: [], hasMore: false, projections: { values: { title: '演示会话一' } } },
          })))
        }
      }
    }
  })
  socket.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`UI_HARNESS_READY http://127.0.0.1:${PORT}/m/`)
})
process.on('SIGINT', () => { server.close(); process.exit(0) })
