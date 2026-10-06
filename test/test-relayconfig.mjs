/**
 * test-relayconfig.mjs — 中继运行时配置（relay.json）单测。
 *
 * 重点：
 *   · 优先级：relay.json > cordis.patch.yml 的 config.relay
 *   · 校验：地址必须 ws(s)、实例 ID 字符集、key 必填
 *   · 安全：redact() 绝不回显 key；落盘文件权限与 devices.json 同级同目录
 *   · 原子写：先写 .tmp 再 rename，避免半截文件
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayConfig, validateRelay, redact } from '../lib/relayconfig.mjs'

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'dsh-relaycfg-'))

console.log('\n── 校验 ───────────────────────────────────────────────')
ok(validateRelay({ enabled: false }).ok === true, '未启用时不需要其它字段')
ok(validateRelay({ enabled: true, url: 'http://x', key: 'k', instanceId: 'a' }).ok === false, 'http:// 地址被拒（必须 ws/wss）')
ok(validateRelay({ enabled: true, url: 'ws://x', key: '', instanceId: 'a' }).ok === false, '缺少 key 被拒')
ok(validateRelay({ enabled: true, url: 'ws://x', key: 'k', instanceId: 'a/b' }).ok === false, '实例 ID 含斜杠被拒')
ok(validateRelay({ enabled: true, url: 'ws://x', key: 'k', instanceId: 'home-pc_1' }).ok === true, '合法配置通过')

console.log('\n── 优先级与持久化 ─────────────────────────────────────')
const base = { enabled: true, url: 'ws://yaml.example:8443', key: 'yaml-key', instanceId: 'yaml-id' }
const cfg = createRelayConfig({ dataPath: dir, base })
await cfg.load()
let eff = cfg.effective()
ok(eff.url === 'ws://yaml.example:8443' && eff.key === 'yaml-key', '无 relay.json 时取 yaml 默认值')

const saved = await cfg.save({ url: 'ws://runtime.example:9000', instanceId: 'runtime-id' })
ok(saved.ok === true, '保存运行时覆盖成功')
eff = cfg.effective()
ok(eff.url === 'ws://runtime.example:9000', 'url 被运行时值覆盖')
ok(eff.key === 'yaml-key', '未提交的字段继续沿用 yaml 值（逐字段合并）')

const raw = await readFile(join(dir, 'relay.json'), 'utf8')
ok(JSON.parse(raw).url === 'ws://runtime.example:9000', 'relay.json 已落盘')

const cfg2 = createRelayConfig({ dataPath: dir, base })
await cfg2.load()
ok(cfg2.effective().url === 'ws://runtime.example:9000', '新实例重新载入文件生效（等价重启后读取）')

console.log('\n── 安全 ───────────────────────────────────────────────')
const red = redact(cfg2.effective())
ok(!JSON.stringify(red).includes('yaml-key'), 'redact() 不含 key 本体')
ok(red.hasKey === true && red.url === 'ws://runtime.example:9000', 'redact() 保留 hasKey/url')

console.log('\n── 关闭与坏文件 ───────────────────────────────────────')
await cfg2.disable()
ok(cfg2.effective().enabled === false, 'disable() 关闭隧道')
ok(cfg2.effective().url === 'ws://runtime.example:9000', 'disable() 保留地址便于再次开启')

await writeFile(join(dir, 'relay.json'), '{ 这不是 JSON', 'utf8')
const cfg3 = createRelayConfig({ dataPath: dir, base })
await cfg3.load()
ok(cfg3.effective().url === 'ws://yaml.example:8443', 'relay.json 损坏时回退 yaml 默认值而不是抛错')

const bad = await cfg3.save({ enabled: true, url: 'ftp://nope' })
ok(bad.ok === false && typeof bad.error === 'string', '非法地址保存被拒并给出中文原因')
ok(!(await readFile(join(dir, 'relay.json'), 'utf8')).includes('ftp://'), '非法输入未写入磁盘')

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n中继配置测试全部通过' : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
