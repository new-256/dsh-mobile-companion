/**
 * run-all.mjs — 统一测试入口（npm test）。
 * 顺序执行全部测试文件，任一失败即以非零码退出。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  ['test-qr.mjs', '二维码编码器'],
  ['test-devices.mjs', '设备注册表 + HMAC'],
  ['test-netconflict.mjs', '局域网/代理冲突识别'],
  ['test-natdiag.mjs', '入向可达性（双层 NAT 判定）'],
  ['test-forward.mjs', 'LAN 透明转发器'],
  ['test-relay.mjs', '中继服务器 + 宿主隧道'],
  ['test-relayconfig.mjs', '中继运行时配置'],
  ['test-push.mjs', '推送注册/免打扰/投递'],
  ['test-ovpn.mjs', 'OpenVPN 通道集成'],
  ['test-tunnel.mjs', '隧道断线重连与并发'],
  ['test-smoke.mjs', '端到端冒烟'],
  ['test-acceptance.mjs', 'M1 验收（配对/续约/多实例隔离）'],
]

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(HERE, file)], { stdio: 'inherit' })
  child.on('exit', (code) => resolve(code ?? 1))
  child.on('error', () => resolve(1))
})

let failed = 0
for (const [file, label] of SUITES) {
  console.log(`\n${'═'.repeat(56)}\n▶ ${label}  (${file})\n${'═'.repeat(56)}`)
  const code = await run(file)
  if (code !== 0) {
    failed++
    console.error(`✗ ${label} 失败（exit=${code}）`)
  }
}

console.log(`\n${'═'.repeat(56)}`)
if (failed === 0) {
  console.log(`✅ 全部 ${SUITES.length} 个测试套件通过`)
} else {
  console.error(`❌ ${failed}/${SUITES.length} 个测试套件失败`)
}
process.exit(failed === 0 ? 0 : 1)
