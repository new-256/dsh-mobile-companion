// test-smoke.mjs — 端到端冒烟：模拟 cordis 环境（webServer/connection 服务），
// 执行 apply() 注册全部路由，然后发真实 HTTP 请求验证每个端点。
// 这是在挂载前发现「启动即崩」类问题的最后一道闸。
import { createServer } from 'node:http'
import { mkdtemp, rm, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

const PLUGIN_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// ── 模拟 webServer：exact + prefix 路由表 ────────────────────────────────
const exact = new Map()
const prefixes = new Map()
const mockWebServer = {
  host: '0.0.0.0',
  port: 0, // 由真实 server 填充
  register(route) {
    const table = route.kind === 'exact' ? exact : prefixes
    if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`)
    table.set(route.path, route)
    return () => table.delete(route.path)
  },
}

// ── 模拟 connection：fetch 路由表 + 辅助方法 ─────────────────────────────
const fetchRoutes = new Map()
const token = 'test-token-123'
const mockConnection = {
  authenticatedUrl: (base) => `${base}/?token=${token}`,
  requestRejection: () => undefined, // 测试中视作已认证
  fetch: {
    register(route) {
      if (fetchRoutes.has(route.path)) throw new Error(`duplicate fetch route ${route.path}`)
      if (!route.methods?.length) throw new Error(`fetch route ${route.path} 无方法`)
      fetchRoutes.set(route.path, route)
      return () => fetchRoutes.delete(route.path)
    },
  },
}

// ── 模拟 cordis ctx ─────────────────────────────────────────────────────
const disposers = []
const services = new Map()
const mockCtx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  provide(name, value) { services.set(name, value) },
  get: (name) => services.get(name),
  webServer: mockWebServer,
  connection: mockConnection,
}

// ── 执行 apply：推迟到 HTTP 服务器监听之后 ───────────────────────────────
// （webServer.port 必须在 apply 前已知，LAN 代理才会真正启动并进入配对载荷；
//   早先的顺序让代理永远拿不到端口，v2/代理地址断言被静默跳过。）
let failed = 0
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++ }

// ── 起真实 HTTP 服务器，把请求分发进 mock 路由表 ────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  try {
    // ★ 完全复刻 dsh-host-webserver match()：exact 优先，前缀最长胜出，
    //   前缀匹配条件 = pathname === prefix || pathname.startsWith(prefix + '/')
    //   （前缀注册时不应带尾斜杠，否则子路径永不匹配 —— 与宿主行为一致）
    const route = (() => {
      const exactHit = exact.get(path)
      if (exactHit) return exactHit
      let best
      for (const [prefix, r] of prefixes) {
        if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
        if (!best || prefix.length > best.path.length) best = r
      }
      return best
    })()
    if (route) return void (await route.handler(req, res))
    // /api 前缀（模拟 client-connection 共享通道）→ fetch 路由
    if (path.startsWith('/api/')) {
      const froute = fetchRoutes.get(path)
      if (!froute) { res.writeHead(404); res.end('not found'); return }
      if (!froute.methods.includes(req.method)) { res.writeHead(405); res.end('bad method'); return }
      const chunks = []
      for await (const c of req) chunks.push(c)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const request = {
        method: req.method,
        url: req.url,
        headers: { 'content-type': req.headers['content-type'] },
        text: async () => rawBody,
        json: async () => JSON.parse(rawBody || '{}'),
      }
      const response = await froute.fetch(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
      return
    }
    res.writeHead(404)
    res.end('no route')
  } catch (e) {
    res.writeHead(500)
    res.end(String(e))
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
mockWebServer.port = server.address().port
const base = `http://127.0.0.1:${mockWebServer.port}`

// 现在端口已知 → apply，LAN 代理会真正启动（用独立端口，避开真实 DSH 的 47896）
const { apply } = await import(`file:///${PLUGIN_DIR.replace(/\\/g, '/')}/index.mjs`)
const dataDir = await mkdtemp(join(tmpdir(), 'dsh-mc-smoke-'))
const SMOKE_PROXY_PORT = 47890
apply(mockCtx, { dataPath: dataDir, proxyPort: SMOKE_PROXY_PORT })

// ── 测试矩阵 ────────────────────────────────────────────────────────────
const j = async (path, opts) => {
  const res = await fetch(base + path, opts)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body, text, headers: res.headers }
}

// 1. pair-info（fetch 路由，经 connection.authenticatedUrl）
const p1 = await j('/api/mobile/pair-info')
ok(p1.status === 200 && p1.body.ok === true, `pair-info 200（name=${p1.body.name}, port=${p1.body.port}）`)
ok(Array.isArray(p1.body.urls) && p1.body.urls.length >= 1, `urls 列表（${p1.body.urls?.length} 个）`)
ok(p1.body.payload?.type === 'dsh-pair' && p1.body.payload?.token === token, '载荷 v1 含 token')
ok(typeof p1.body.deepLink === 'string' && p1.body.deepLink.startsWith('dshpair://'), '深链格式')

// 2. QR SVG
const res2 = await fetch(base + '/api/mobile/qr.svg')
const svg = await res2.text()
ok(res2.status === 200 && svg.startsWith('<svg'), 'qr.svg 返回 SVG')
ok(svg.includes('path'), 'SVG 含 path 元素')

// 2b. 回归：二维码内容必须与 pair-info 载荷逐字节一致
// （历史事故：qr.svg 路由单独调 buildPairingInfo 漏传 proxyPort，二维码里编的是
//  127.0.0.1 环回载荷，手机扫码后必然连不上。）
const { qrSvg } = await import(new URL('../lib/qr.mjs', import.meta.url).href)
ok(svg === qrSvg(JSON.stringify(p1.body.payload), { scale: 4, quiet: 4 }),
  '二维码载荷与 pair-info 载荷一致（含代理地址）')

// 2c. 代理必须启用，载荷必须是 v2 且 urls 首位为局域网代理地址
ok(p1.body.proxy?.enabled === true, `LAN 代理已启用（port=${p1.body.proxy?.port}）`)
ok(p1.body.payload.v === 2, `载荷版本为 v2（实际 ${p1.body.payload.v}）`)
{
  const first = String(p1.body.urls?.[0] || '')
  ok(first.includes(`:${SMOKE_PROXY_PORT}`) && !/127\.0\.0\.1|localhost/.test(first),
    `urls 首位是局域网代理地址（${first}）`)
}

// 3. enroll（注册设备）
const dev = { deviceId: 'smoketest000001', name: '冒烟手机', platform: 'test', secret: 'a'.repeat(64) }
const p3 = await j('/api/mobile/devices/enroll', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dev),
})
ok(p3.status === 200 && p3.body.ok === true && !p3.body.device?.secret, 'enroll 注册成功且不回显 secret')

// 4. devices 列表
const p4 = await j('/api/mobile/devices')
ok(p4.status === 200 && p4.body.devices?.length === 1 && p4.body.devices[0].name === '冒烟手机', 'devices 列表')

// 5. net-check
const p5 = await j('/api/mobile/net-check')
ok(p5.status === 200 && p5.body.reachable === true, 'net-check 判定 0.0.0.0 可达')

// 6. /m/ 重定向 + 静态 index
const res6a = await fetch(base + '/m', { redirect: 'manual' })
ok(res6a.status === 301 && res6a.headers.get('location') === '/m/', '/m 301 → /m/')
const res6b = await fetch(base + '/m/')
const html = await res6b.text()
ok(res6b.status === 200 && html.includes('js/app.js'), '/m/ index.html 服务正常')

// 7. 静态子资源 + 路径穿越防护
const res7 = await fetch(base + '/m/js/api.js')
ok(res7.status === 200 && (res7.headers.get('content-type') || '').includes('javascript'), '/m/js/api.js MIME 正确')
const res7b = await fetch(base + '/m/..%2f..%2findex.mjs')
ok([403, 404].includes(res7b.status), `路径穿越被拦截（${res7b.status}）`)

// 8. /mobile/renew（HMAC 认证路由）——先算正确签名
const { createHmac, randomBytes } = await import('node:crypto')
const ts = Date.now()
const nonce = randomBytes(12).toString('hex')
const hmac = createHmac('sha256', Buffer.from(dev.secret, 'hex')).update(`${dev.deviceId}\n${ts}\n${nonce}\nrenew-v1`).digest('hex')
const p8 = await j('/mobile/renew', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `DSH-Device ${dev.deviceId}:${hmac}` },
  body: JSON.stringify({ deviceId: dev.deviceId, ts, nonce }),
})
ok(p8.status === 200 && p8.body.ok === true && p8.body.url?.includes(`token=${token}`), `renew 返回带 token 的新 URL`)
ok(typeof p8.body.serverTime === 'number', 'renew 含 serverTime')

// 9. renew 错误签名 → 401
const p9 = await j('/mobile/renew', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `DSH-Device ${dev.deviceId}:${'0'.repeat(64)}` },
  body: JSON.stringify({ deviceId: dev.deviceId, ts: Date.now(), nonce: randomBytes(12).toString('hex') }),
})
ok(p9.status === 401, '错误签名 renew → 401')

// 10. renew 重放 → 401
const p10 = await j('/mobile/renew', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `DSH-Device ${dev.deviceId}:${hmac}` },
  body: JSON.stringify({ deviceId: dev.deviceId, ts, nonce }),
})
ok(p10.status === 401, 'renew 重放 → 401')

// 11. OPTIONS 预检（CORS）
const res11 = await fetch(base + '/mobile/renew', { method: 'OPTIONS' })
ok(res11.status === 204 && res11.headers.get('access-control-allow-origin') === '*', 'OPTIONS CORS 预检')

// 12. mobileCompanion 服务（bot-gateway 消费面）
const svc = services.get('mobileCompanion')
ok(typeof svc?.pairingInfo === 'function', 'mobileCompanion 服务已发布')
const pi = await svc.pairingInfo()
ok(pi.qrPng?.length > 100 && pi.qrPng[0] === 0x89, `服务返回 qrPng（${pi.qrPng.length} 字节）`)
ok(pi.deepLink.startsWith('dshpair://'), '服务返回深链')

// 13. revoke 后 renew 失效
const p13a = await j('/api/mobile/devices/revoke', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ deviceId: dev.deviceId }),
})
ok(p13a.status === 200 && p13a.body.ok === true && p13a.body.removed === true, 'revoke 撤销设备')
const ts13 = Date.now()
const nonce13 = randomBytes(12).toString('hex')
const hmac13 = createHmac('sha256', Buffer.from(dev.secret, 'hex')).update(`${dev.deviceId}\n${ts13}\n${nonce13}\nrenew-v1`).digest('hex')
const p13b = await j('/mobile/renew', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `DSH-Device ${dev.deviceId}:${hmac13}` },
  body: JSON.stringify({ deviceId: dev.deviceId, ts: ts13, nonce: nonce13 }),
})
ok(p13b.status === 401, '撤销后 renew → 401')

// 14. 卸载（effect disposer 全部可执行）
for (const d of disposers) { try { d() } catch (e) { ok(false, `disposer 抛错: ${e}`) } }
ok(true, `${disposers.length} 个 effect disposer 全部干净执行`)

server.close()
await rm(dataDir, { recursive: true, force: true })
console.log(failed === 0 ? `\n冒烟测试全部通过（${disposers.length} 个 effect）` : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
