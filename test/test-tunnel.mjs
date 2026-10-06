// test-tunnel.mjs — 宿主隧道客户端测试
//
// 覆盖：断线重连、并发多流互不串扰。

import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const RELAY_ROOT = join(HERE, '..', '..', '..', 'relay')
const { createRelay } = await import(pathToFileURL(join(RELAY_ROOT, 'lib', 'relay.mjs')).href)
const { createTunnel } = await import(pathToFileURL(join(HERE, '..', 'lib', 'tunnel.mjs')).href)

const KEY = 'test-tunnel-key-' + randomBytes(8).toString('hex')
const INSTANCE = 'test-tunnel-instance'

let failed = 0
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++ }

async function waitState(tunnel, state, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (tunnel.status().state === state) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

// ── 目标服务器：按 id 回显 ───────────────────────────────────────────────────
const target = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const id = u.searchParams.get('id') || 'none'
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id, method: req.method, path: u.pathname }))
})
await new Promise(r => target.listen(0, '127.0.0.1', r))
const targetPort = target.address().port

// ── 启动中继 ─────────────────────────────────────────────────────────────
let relay = await createRelay({ port: 0, host: '127.0.0.1', key: KEY, log: { info() {}, warn() {} } })
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

ok(await waitState(tunnel, 'connected'), '隧道初始连接成功')

// ── 1. 断线重连 ──────────────────────────────────────────────────────────
await relay.close()
ok(await waitState(tunnel, 'error', 3000), '中继关闭后隧道状态变为 error')

relay = await createRelay({ port: relayPort, host: '127.0.0.1', key: KEY, log: { info() {}, warn() {} } })
ok(await waitState(tunnel, 'connected', 5000), '重启中继后隧道自动恢复 connected')

// ── 2. 并发多流 ───────────────────────────────────────────────────────────
const ids = Array.from({ length: 10 }, (_, i) => `req-${i}`)
const results = await Promise.all(ids.map(async (id) => {
  const res = await fetch(`http://127.0.0.1:${relayPort}/i/${INSTANCE}/echo?id=${id}`)
  const body = await res.json()
  return { id, body }
}))

let concurrentOk = true
for (const { id, body } of results) {
  if (body.id !== id) concurrentOk = false
}
ok(concurrentOk, '10 个并发请求各自拿到正确响应')

// ── 3. 状态暴露 ───────────────────────────────────────────────────────────
const st = tunnel.status()
ok(st.enabled === true, 'status() 报告 enabled')
ok(st.instanceId === INSTANCE, 'status() 含 instanceId')
ok(st.relayUrl === `ws://127.0.0.1:${relayPort}`, 'status() 含 relayUrl')
ok(st.state === 'connected', 'status() 报告 state 为 connected')

tunnel.close()
await relay.close()
target.close()
target.closeAllConnections?.()
await new Promise(r => setTimeout(r, 100))

console.log(failed === 0 ? '\n隧道客户端测试全部通过' : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
