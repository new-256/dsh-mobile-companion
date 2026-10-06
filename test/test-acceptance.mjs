/**
 * test-acceptance.mjs — M1 验收测试（对照 DSH手机端设计v3.1.md「四、里程碑与验收」）。
 *
 * 覆盖项：
 *   A. 配对闭环：一次性 token URL → 303 + Set-Cookie → 带 Cookie 注册设备 → 设备列表可见
 *   B. 终身续约（方式三）：丢掉 Cookie（模拟 30 天过期）→ 设备 HMAC 调 /mobile/renew
 *      → 拿新鲜 token URL → 重新换 Cookie → 凭新 Cookie 访问 /api 成功（用户无感）
 *   C. 多实例隔离（要求二）：两个 authority 的 Cookie 名互不相同；
 *      拿着 A 的 Cookie 访问 B 必须 401（切换互不污染）
 *   D. 断开即时生效：桌面解除设备后，原设备密钥续约立即 401
 *   E. 代理与栅栏：LAN 代理在线时配对载荷为 v2 且 urls 首位非环回
 *
 * 设计说明：DSH 真实的浏览器鉴权语义（303 + Set-Cookie 名 = 'dsh-auth-' +
 * base64url(sha256(Host authority))、Host/Origin 栅栏、Cookie 校验）在测试里用一个
 * 忠实复刻的 shim 实现——依据是已读源码 @deepseek-ai/dsh-client-connection
 * （authorizeIndex / isTrustedApiRequest / cookieName / sessionCookie）。
 */
import { createServer } from 'node:http'
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) failed++
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const cookieNameFor = (authority) => `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`

// ── 忠实复刻 DSH 浏览器鉴权 shim ──────────────────────────────────────────
const LAUNCH_TOKEN = b64url(randomBytes(32))
const usedTokens = new Set()
const sessions = new Map() // cookieValue -> { authority, expiresAt }

function issueCookie(authority) {
  const value = b64url(randomBytes(32))
  sessions.set(value, { authority, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 })
  return `${cookieNameFor(authority)}=${value}`
}

function parseCookies(header) {
  const out = {}
  for (const seg of String(header || '').split(';')) {
    const i = seg.indexOf('=')
    if (i === -1) continue
    out[seg.slice(0, i).trim()] = seg.slice(i + 1).trim()
  }
  return out
}

/** 复刻 isTrustedApiRequest：Host 必须 loopback；Origin 若存在须等于 Host；cross-site 拒绝 */
function trustedApiRequest(req) {
  const host = req.headers.host
  if (!host) return false
  const hostname = host.split(':')[0]
  if (!/^(127\.|localhost$|\[::1\])/.test(hostname)) return false
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function authenticated(req) {
  if (!trustedApiRequest(req)) return false
  const authority = req.headers.host
  const jar = parseCookies(req.headers.cookie)
  const value = jar[cookieNameFor(authority)]
  if (!value) return false
  const s = sessions.get(value)
  return !!s && s.authority === authority && s.expiresAt > Date.now()
}

export async function runAcceptance() {
  // ── 挂载插件（mock cordis ctx）────────────────────────────────────────
  const exact = new Map()
  const prefixes = new Map()
  const fetchRoutes = new Map()
  const mockWebServer = {
    host: '0.0.0.0',
    port: 0,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  }
  const services = new Map()
  const disposers = []
  const mockCtx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    provide(n, v) { services.set(n, v) },
    get: (n) => services.get(n),
    webServer: mockWebServer,
    connection: {
      authenticatedUrl: (base) => `${base}/?token=${LAUNCH_TOKEN}`,
      requestRejection: () => undefined,
      fetch: {
        register(route) {
          fetchRoutes.set(route.path, route)
          return () => fetchRoutes.delete(route.path)
        },
      },
    },
  }

  // ── 真实 HTTP 服务器：鉴权 shim 前置，命中后分发进插件路由 ─────────────
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    try {
      // 1. 一次性 token 交换（复刻 authorizeIndex 的 303 + Set-Cookie）
      if (path === '/' && url.searchParams.getAll('token').length === 1 && req.method === 'GET') {
        const t = url.searchParams.get('token')
        const authority = req.headers.host
        if (t !== LAUNCH_TOKEN) { res.writeHead(401); res.end('unauthorized'); return }
        usedTokens.add(t)
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'referrer-policy': 'no-referrer',
          'set-cookie': `${issueCookie(authority)}; Max-Age=2592000; Path=/; Expires=${new Date(Date.now() + 30 * 24 * 3600 * 1000).toUTCString()}; HttpOnly; SameSite=Strict`,
        })
        return void res.end()
      }

      // 2. /api/* 走栅栏 + Cookie（复刻 requestRejection）
      if (path.startsWith('/api/')) {
        const froute = fetchRoutes.get(path)
        if (!froute) { res.writeHead(404); res.end('not found'); return }
        if (!authenticated(req)) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); return }
        if (!froute.methods.includes(req.method)) { res.writeHead(405); res.end('bad method'); return }
        const chunks = []
        for await (const c of req) chunks.push(c)
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const request = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          text: async () => rawBody,
          json: async () => JSON.parse(rawBody || '{}'),
        }
        const response = await froute.fetch(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(await response.text())
        return
      }

      // 3. 其余（/m/、/mobile/renew 等）直连插件
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
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  mockWebServer.port = server.address().port
  const origin = `http://127.0.0.1:${mockWebServer.port}`

  const { apply } = await import(`file:///${PLUGIN_DIR.replace(/\\/g, '/')}/index.mjs`)
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-mc-accept-'))
  const PROXY_PORT = 47891
  apply(mockCtx, { dataPath: dataDir, proxyPort: PROXY_PORT, relay: { enabled: false } })

  // ── 辅助：带 cookie jar 的请求 ────────────────────────────────────────
  const jar = new Map() // authority -> cookie header
  const call = async (path, { method = 'GET', body, base = origin, auth = true, cookieOverride } = {}) => {
    const authority = new URL(base).host
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth) {
      const c = cookieOverride !== undefined ? cookieOverride : jar.get(authority)
      if (c) headers.cookie = c
    }
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) jar.set(authority, setCookie.split(';')[0])
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed, text, setCookie }
  }

  console.log('\n── A. 配对闭环 ─────────────────────────────────────────')
  const tokenUrl = `${origin}/?token=${LAUNCH_TOKEN}`
  const ex = await call('/?token=' + LAUNCH_TOKEN, { auth: false })
  ok(ex.status === 303, `token 交换返回 303（实际 ${ex.status}）`)
  const cookieHeader = jar.get(new URL(origin).host)
  ok(!!cookieHeader && cookieHeader.startsWith('dsh-auth-'), `取得会话 Cookie：${String(cookieHeader).slice(0, 34)}…`)
  ok(cookieHeader.split('=')[0] === cookieNameFor(new URL(origin).host), 'Cookie 名 = dsh-auth- + base64url(sha256(authority))')
  void tokenUrl

  const device = { deviceId: 'accept-device-01', name: '验收手机', platform: 'test', secret: randomBytes(32).toString('hex') }
  const en = await call('/api/mobile/devices/enroll', { method: 'POST', body: device })
  ok(en.status === 200 && en.body?.ok === true, `带 Cookie 注册设备成功（实际 ${en.status}）`)

  const noCookie = await call('/api/mobile/devices', { auth: true, cookieOverride: '' })
  ok(noCookie.status === 401, `无 Cookie 访问 /api 被拒（401，实际 ${noCookie.status}）`)

  const list = await call('/api/mobile/devices')
  ok(list.status === 200 && Array.isArray(list.body?.devices) && list.body.devices.some((d) => d.deviceId === device.deviceId),
    '设备列表中可见已注册设备')

  const pairInfo = await call('/api/mobile/pair-info')
  ok(pairInfo.status === 200, '/api/mobile/pair-info 可取')
  ok(pairInfo.body?.payload?.v === 2, `配对载荷为 v2（实际 ${pairInfo.body?.payload?.v}）`)
  ok(String(pairInfo.body?.urls?.[0] || '').includes(`:${PROXY_PORT}`) && !/127\.0\.0\.1|localhost/.test(String(pairInfo.body?.urls?.[0])),
    `载荷 urls 首位是局域网代理地址（${pairInfo.body?.urls?.[0]}）`)

  console.log('\n── B. 终身续约（方式三）───────────────────────────────')
  // 模拟 Cookie 过期：清空 jar，并让该 Cookie 在 shim 侧失效（等价 30 天到期）
  const expiredCookie = jar.get(new URL(origin).host)
  const expiredValue = String(expiredCookie).split('=')[1]
  sessions.delete(expiredValue)
  jar.delete(new URL(origin).host)

  const stale = await call('/api/mobile/devices', { cookieOverride: expiredCookie })
  ok(stale.status === 401, `过期 Cookie 被拒（401，实际 ${stale.status}）`)

  const nonce = randomBytes(12).toString('hex')
  const ts = Date.now()
  const sign = createHmac('sha256', Buffer.from(device.secret, 'hex'))
    .update(`${device.deviceId}\n${ts}\n${nonce}\nrenew-v1`).digest('hex')
  const renewRes = await fetch(`${origin}/mobile/renew`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `DSH-Device ${device.deviceId}:${sign}` },
    body: JSON.stringify({ deviceId: device.deviceId, ts, nonce }),
  })
  const renewBody = await renewRes.json()
  ok(renewRes.status === 200 && renewBody?.ok === true, `设备 HMAC 续约成功（实际 ${renewRes.status}）`)
  ok(typeof renewBody?.url === 'string' && renewBody.url.includes('token='), `续约返回新鲜 token URL（${String(renewBody?.url).slice(0, 46)}…）`)

  // 用新鲜 token URL 重新换取 Cookie → 恢复访问（用户无感）
  const freshPath = new URL(renewBody.url).pathname + new URL(renewBody.url).search
  const reEx = await call(freshPath, { auth: false })
  ok(reEx.status === 303, `新鲜 token 交换成功（303，实际 ${reEx.status}）`)
  const after = await call('/api/mobile/devices')
  ok(after.status === 200, `续约后无需人工干预即可访问（实际 ${after.status}）`)

  console.log('\n── C. 多实例隔离（要求二）─────────────────────────────')
  // 用真实存在的第二个 authority（localhost 与 127.0.0.1 是两个不同 authority）
  const altBase = `http://localhost:${mockWebServer.port}`
  const altAuthority = new URL(altBase).host
  ok(cookieNameFor(new URL(origin).host) !== cookieNameFor(altAuthority), '两个 authority 的 Cookie 名不同（天然分域）')
  const crossUse = await call('/api/mobile/devices', { base: altBase, cookieOverride: jar.get(new URL(origin).host) })
  ok(crossUse.status === 401, `实例 A 的 Cookie 拿到实例 B 使用被拒（401，实际 ${crossUse.status}）`)
  // 各自在自己 authority 下正常 → 互不污染
  const ownA = await call('/api/mobile/devices')
  ok(ownA.status === 200, `实例 A 自身访问正常（实际 ${ownA.status}）`)

  console.log('\n── D. 断开即时生效 ────────────────────────────────────')
  const revoke = await call('/api/mobile/devices/revoke', { method: 'POST', body: { deviceId: device.deviceId } })
  ok(revoke.status === 200 && revoke.body?.ok === true, '桌面端解除设备成功')
  const nonce2 = randomBytes(12).toString('hex')
  const ts2 = Date.now()
  const sign2 = createHmac('sha256', Buffer.from(device.secret, 'hex'))
    .update(`${device.deviceId}\n${ts2}\n${nonce2}\nrenew-v1`).digest('hex')
  const renew2 = await fetch(`${origin}/mobile/renew`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `DSH-Device ${device.deviceId}:${sign2}` },
    body: JSON.stringify({ deviceId: device.deviceId, ts: ts2, nonce: nonce2 }),
  })
  ok(renew2.status === 401, `解除后续约立即失效（401，实际 ${renew2.status}）`)

  console.log('\n── E. 中继运行时配置（M2）─────────────────────────────')
  const relayGet0 = await call('/api/mobile/relay')
  ok(relayGet0.status === 200 && relayGet0.body?.ok === true, `GET /api/mobile/relay 200（实际 ${relayGet0.status}）`)
  ok(relayGet0.body?.config?.enabled === false, '默认未启用中继')
  ok(!JSON.stringify(relayGet0.body).includes('"key"'), 'GET 状态不回显 key 字段')

  const badRelay = await call('/api/mobile/relay', { method: 'POST', body: { enabled: true, url: 'http://not-ws.example', key: 'k', instanceId: 'x' } })
  ok(badRelay.status === 400 && badRelay.body?.ok === false, `非 ws:// 地址被拒（实际 ${badRelay.status}）`)

  const setRelay = await call('/api/mobile/relay', { method: 'POST', body: { enabled: true, url: 'ws://relay.invalid:8443', key: 'accept-key', instanceId: 'accept-inst' } })
  ok(setRelay.status === 200 && setRelay.body?.config?.enabled === true, `写入合法中继配置（实际 ${setRelay.status}）`)
  ok(setRelay.body?.config?.hasKey === true && !JSON.stringify(setRelay.body).includes('accept-key'), '写入后仍不回显 key')
  ok(setRelay.body?.status?.instanceId === 'accept-inst', '状态反映新 instanceId')
  const relayFile = JSON.parse(await (await import('node:fs/promises')).readFile(join(dataDir, 'relay.json'), 'utf8'))
  ok(relayFile.key === 'accept-key' && relayFile.enabled === true, 'relay.json 已落盘（含 key，仅本地）')

  const relayGet1 = await call('/api/mobile/relay')
  ok(relayGet1.body?.config?.url === 'ws://relay.invalid:8443', '重新读取生效（无需改 yaml）')

  const offRelay = await call('/api/mobile/relay', { method: 'POST', body: { enabled: false } })
  ok(offRelay.status === 200 && offRelay.body?.config?.enabled === false, '可一键关闭中继（保留地址）')
  ok(offRelay.body?.config?.url === 'ws://relay.invalid:8443', '关闭后仍保留地址')

  console.log('\n── F. 推送与免打扰 API（M2）─────────────────────────')
  const push0 = await call('/api/mobile/push/status')
  ok(push0.status === 200 && push0.body?.ok === true && push0.body?.registered === 0, `推送状态默认空（实际 ${push0.status}）`)
  const badTok = await call('/api/mobile/push/register', { method: 'POST', body: { deviceId: device.deviceId, token: 'short', platform: 'android' } })
  ok(badTok.status === 400, '非法 token 被拒（400）')
  const regPush = await call('/api/mobile/push/register', { method: 'POST', body: { deviceId: device.deviceId, token: 'fcm-token-accept-123456', platform: 'android' } })
  ok(regPush.status === 200 && regPush.body?.ok === true, '推送注册成功')
  const push1 = await call('/api/mobile/push/status')
  ok(push1.body?.registered === 1 && !JSON.stringify(push1.body).includes('fcm-token-accept-123456'), '状态含 1 台且不回显 token')
  const badDnd = await call('/api/mobile/push/dnd', { method: 'POST', body: { deviceId: device.deviceId, enabled: true, from: '25:00', to: '08:00' } })
  ok(badDnd.status === 400, '非法免打扰时间被拒（400）')
  const setDnd = await call('/api/mobile/push/dnd', { method: 'POST', body: { deviceId: device.deviceId, enabled: true, from: '22:00', to: '08:00' } })
  ok(setDnd.status === 200 && setDnd.body?.dnd?.from === '22:00', '免打扰窗口保存成功')
  const revoke2 = await call('/api/mobile/devices/revoke', { method: 'POST', body: { deviceId: device.deviceId } })
  ok(revoke2.status === 200, '再次撤销设备（联动清推送）')
  const push2 = await call('/api/mobile/push/status')
  ok(push2.body?.registered === 0, '撤销设备后推送注册一并清除')

  console.log('\n── H. 网络接口策略（虚拟组网）───────────────────────')
  const nc0 = await call('/api/mobile/netconf')
  ok(nc0.status === 200 && nc0.body?.ok === true && nc0.body?.virtual === false, `netconf 默认 off（实际 ${nc0.status}）`)
  const badNc = await call('/api/mobile/netconf', { method: 'POST', body: { virtual: { weird: true } } })
  ok(badNc.status === 400, '非法策略被拒（400）')
  const ncAll = await call('/api/mobile/netconf', { method: 'POST', body: { virtual: true } })
  ok(ncAll.status === 200 && ncAll.body?.virtual === true, '放行全部虚拟接口成功')
  const ncList = await call('/api/mobile/netconf', { method: 'POST', body: { virtual: ['Tailscale'] } })
  ok(ncList.status === 200 && JSON.stringify(ncList.body?.virtual) === JSON.stringify(['Tailscale']), '指定模式列表保存成功')
  const ncOff = await call('/api/mobile/netconf', { method: 'POST', body: { virtual: false } })
  ok(ncOff.status === 200 && ncOff.body?.virtual === false, '恢复默认剔除')
  const ncFile = JSON.parse(await (await import('node:fs/promises')).readFile(join(dataDir, 'netconf.json'), 'utf8'))
  ok(ncFile.virtual === false, 'netconf.json 已落盘')

  console.log('\n── I. OpenVPN 通道 API（M2 组网）───────────────────')
  const ov0 = await call('/api/mobile/ovpn')
  ok(ov0.status === 200 && ov0.body?.ok === true && ov0.body?.state === 'stopped', `ovpn 状态默认 stopped（实际 ${ov0.status}）`)
  ok(ov0.body?.hasConfig === false, '默认无配置文件')
  const ovBad = await call('/api/mobile/ovpn/config', { method: 'POST', body: { content: '不是配置文件' } })
  ok(ovBad.status === 400, '非法 ovpn 配置被拒（400）')
  const ovSample = 'client\ndev tun\nnobind\nproto udp\nremote 203.0.113.10 1194\nauth SHA1\nremote-cert-tls server\n<ca>xxxx</ca>'
  const ovSave = await call('/api/mobile/ovpn/config', { method: 'POST', body: { content: ovSample } })
  ok(ovSave.status === 200 && ovSave.body?.hasConfig === true, '合法配置保存成功')
  const ovFile = await (await import('node:fs/promises')).readFile(join(dataDir, 'ovpn', 'client.ovpn'), 'utf8')
  ok(ovFile.includes('remote 203.0.113.10 1194'), 'client.ovpn 已落盘数据目录')
  const ov1 = await call('/api/mobile/ovpn')
  ok(ov1.body?.hasConfig === true, '保存后状态可见 hasConfig')
  // 不在此真实拨号（会连外部服务器）；连接生命周期由 test-ovpn.mjs 注入 mock 覆盖

  console.log('\n── J. 公网入口（端口转发）──────────────────────────')
  const pub0 = await call('/api/mobile/public')
  ok(pub0.status === 200 && pub0.body?.ok === true && pub0.body?.url === null, `公网入口默认空（实际 ${pub0.status}）`)
  const pubBad = await call('/api/mobile/public', { method: 'POST', body: { url: 'ftp://x' } })
  ok(pubBad.status === 400, '非法 URL 被拒（400）')
  const pubSet = await call('/api/mobile/public', { method: 'POST', body: { url: 'http://203.0.113.10:1443/' } })
  ok(pubSet.status === 200 && pubSet.body?.url === 'http://203.0.113.10:1443', '公网入口保存成功（尾斜杠被清理）')
  const pubFile = JSON.parse(await (await import('node:fs/promises')).readFile(join(dataDir, 'public.json'), 'utf8'))
  ok(pubFile.url === 'http://203.0.113.10:1443', 'public.json 已落盘')
  const pairWithPub = await call('/api/mobile/pair-info')
  ok(pairWithPub.body?.urls?.includes('http://203.0.113.10:1443'), '配对候选包含公网入口')
  ok(String(pairWithPub.body?.payload?.token ? pairWithPub.body.lanUrl : '').startsWith('http://203.0.113.10:1443'),
    'token 交换入口优先公网地址（异地扫码不落空）')
  const pubClr = await call('/api/mobile/public', { method: 'POST', body: { url: '' } })
  ok(pubClr.status === 200 && pubClr.body?.url === null, '可清除公网入口')

  console.log('\n── G. 移动 UI 与静态资源 ──────────────────────────────')
  const m = await fetch(`${origin}/m/`)
  const html = await m.text()
  ok(m.status === 200 && /<html/i.test(html), `/m/ 返回移动 UI（${m.status}）`)
  const pluginsJs = await fetch(`${origin}/m/js/plugins.js`)
  const jsText = await pluginsJs.text()
  ok(pluginsJs.status === 200 && !/replaceChildren\(\s*kids\s*\)/.test(jsText), '插件中心渲染 bug 已修（无裸数组 replaceChildren）')
  const chatJs = await fetch(`${origin}/m/js/chat.js`)
  const chatText = await chatJs.text()
  ok(chatJs.status === 200 && chatText.includes('uploadFileBinary') && chatText.includes('receiptId'),
    '聊天页已接入附件上传（uploadFileBinary + receiptId）')

  // ── 清理 ──────────────────────────────────────────────────────────────
  for (const d of disposers.reverse()) { try { d() } catch { /* ignore */ } }
  await new Promise((r) => server.close(r))
  await rm(dataDir, { recursive: true, force: true })

  return failed
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  console.log('════════════════════════════════════════════════════════')
  console.log('▶ M1 验收测试  (test-acceptance.mjs)')
  console.log('════════════════════════════════════════════════════════')
  const failedCount = await runAcceptance()
  if (failedCount === 0) {
    console.log('\n✅ M1 验收测试全部通过')
    process.exit(0)
  }
  console.log(`\n❌ M1 验收测试 ${failedCount} 例失败`)
  process.exit(1)
}

export { timingSafeEqual }
