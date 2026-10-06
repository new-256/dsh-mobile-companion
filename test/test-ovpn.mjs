/**
 * test-ovpn.mjs — OpenVPN 通道集成测试。
 *
 * 用注入的 spawnImpl 模拟 openvpn 进程与日志文件，验证：
 *   · 二进制检测（固定路径 / PATH）
 *   · 配置校验与落盘（原子写；非 ovpn 内容被拒）
 *   · 连接生命周期：connecting → 日志出现完成标记 → connected + 虚拟 IP 提取
 *   · 断开（kill 进程、状态归位）
 *   · 超时判定（注入小 timeoutMs）
 *   · 虚拟 IP 进入配对候选（virtualIps()）
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createOvnManager, detectOpenvpn, looksLikeOvpnConfig } from '../lib/ovpn.mjs'

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'dsh-ovpn-'))

console.log('\n── 二进制检测 ───────────────────────────────────────')
const realCandidate = 'C:/Program Files/OpenVPN/bin/openvpn.exe'
ok(detectOpenvpn({ PATH: '' }, (p) => p === realCandidate) === realCandidate, '固定路径命中')
ok(detectOpenvpn({ PATH: 'C:/fake' }, (p) => p === join('C:/fake', 'openvpn.exe')) === join('C:/fake', 'openvpn.exe'), 'PATH 命中')
ok(detectOpenvpn({ PATH: 'C:/none' }, () => false) === null, '未安装返回 null')

console.log('\n── 配置校验与落盘 ───────────────────────────────────')
const OVPN_SAMPLE = `client\ndev tun\nnobind\nproto udp\nremote 117.36.156.68 1194\nauth SHA1\nremote-cert-tls server\n<ca>xxxx</ca>`
ok(looksLikeOvpnConfig(OVPN_SAMPLE) === true, '合法配置通过校验')
ok(looksLikeOvpnConfig('随便一段文字') === false, '非配置文本被拒')
ok(looksLikeOvpnConfig(OVPN_SAMPLE.replace('client', 'clinet')) === false, '缺 client 关键字被拒')
ok(looksLikeOvpnConfig(OVPN_SAMPLE.replace('remote 117.36.156.68 1194', 'remote x')) === false, '缺 remote 主机+端口被拒')

let killed = 0
let spawned = null
const fakeProc = () => {
  const p = new EventEmitter()
  p.pid = 4242
  p.kill = () => { killed++; p.emit('exit', 0) }
  return p
}
const ovpn = createOvnManager({ dataPath: dir, log: { info() {}, warn() {}, error() {} }, bin: realCandidate, timeoutMs: 3000, spawnImpl: (bin2, args) => { spawned = { bin: bin2, args }; return fakeProc() } })

const save1 = await ovpn.saveConfig(OVPN_SAMPLE)
ok(save1.ok === true, '配置保存成功')
ok(await (async () => (await readFile(ovpn.configFile, 'utf8')).includes('remote 117.36.156.68 1194'))(), '配置已落盘')
const save2 = await ovpn.saveConfig('not an ovpn')
ok(save2.ok === false, '非法配置保存被拒')

console.log('\n── 连接生命周期（模拟日志）──────────────────────────')
ok(ovpn.status().state === 'stopped' && ovpn.hasConfig() === true, '初始 stopped 且已有配置')
const r1 = await ovpn.connect()
ok(r1.ok === true, '发起连接成功')
ok(spawned && spawned.bin === realCandidate && spawned.args[0] === '--config', 'spawn openvpn --config …')
ok(ovpn.status().state === 'connecting', '状态 connecting')

// 模拟日志出现 DHCP IP + 完成标记 → 轮询后应 connected（轮询 800ms，超时 3000ms，时序充裕）
await writeFile(ovpn.logFile, [
  'UDP link remote: [AF_INET]117.36.156.68:1194',
  'TAP-WIN32 device opened',
  'Notified TAP-Windows driver to set a DHCP IP/netmask of 10.80.12.2/255.255.255.0',
  'Initialization Sequence Completed',
].join('\n'), 'utf8')
await new Promise((r) => setTimeout(r, 1600))
const st1 = ovpn.status()
ok(st1.state === 'connected', '日志完成标记 → connected')
ok(st1.ip === '10.80.12.2', `虚拟 IP 提取：${st1.ip}`)
ok(JSON.stringify(ovpn.virtualIps()) === JSON.stringify(['10.80.12.2']), 'virtualIps() 返回虚拟 IP（供配对候选注入）')

console.log('\n── 断开 ─────────────────────────────────────────────')
const r2 = await ovpn.connect()
ok(r2.ok === false, '已连接时重复 connect 被拒')
ovpn.disconnect()
// 优雅关闭走 management 异步路径（mock 进程不监听 mgmt → ECONNREFUSED → 兜底 kill），需等事件
await new Promise((r) => setTimeout(r, 400))
ok(killed >= 1, 'disconnect kill 了 openvpn 进程（management 不可用→兜底强杀）')
ok(ovpn.status().state === 'stopped' && ovpn.virtualIps().length === 0, '断开后 stopped 且虚拟 IP 清空')

console.log('\n── 超时判定 ─────────────────────────────────────────')
// 清掉上次连接的残留日志（否则 poll 会误判 connected），再发起无响应的连接
await rm(ovpn.logFile, { force: true })
await ovpn.connect()
await new Promise((r) => setTimeout(r, 3600))
ok(ovpn.status().state === 'error', '无日志时超时判定 error')

ovpn.dispose()
await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nOpenVPN 集成测试全部通过' : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
