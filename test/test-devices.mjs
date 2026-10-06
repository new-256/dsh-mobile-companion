// test-devices.mjs — 设备注册表 + HMAC 认证单元测试
import { createRegistry, generateDeviceCredentials } from '../lib/devices.mjs'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'dsh-mc-test-'))
const reg = createRegistry({ dataDir: dir, log: console })

let failed = 0
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) failed++ }

// 1. enroll + list
const { deviceId, secret } = generateDeviceCredentials()
const dev = await reg.enroll({ deviceId, name: '测试手机', model: 'Pixel 8', platform: 'capacitor', secret })
const list = await reg.list()
ok(list.length === 1 && list[0].name === '测试手机' && !list[0].secret, 'enroll + list（secret 不外泄）')

// 2. 正确 HMAC → verify 通过
const ts = Date.now()
const nonce = randomBytes(12).toString('hex')
const good = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${deviceId}\n${ts}\n${nonce}\nrenew-v1`).digest('hex')
const authHeader = `DSH-Device ${deviceId}:${good}`
const v1 = await reg.verify({ authHeader, body: { deviceId, ts, nonce }, action: 'renew' })
ok(v1?.deviceId === deviceId, '正确签名通过 verify')

// 3. 重放同一 nonce → 拒绝
const v2 = await reg.verify({ authHeader, body: { deviceId, ts, nonce }, action: 'renew' })
ok(v2 === null, 'nonce 重放被拒绝')

// 4. 错误动作后缀 → 拒绝
const ts2 = Date.now()
const nonce2 = randomBytes(12).toString('hex')
const badAction = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${deviceId}\n${ts2}\n${nonce2}\nunregister-v1`).digest('hex')
const v3 = await reg.verify({ authHeader: `DSH-Device ${deviceId}:${badAction}`, body: { deviceId, ts: ts2, nonce: nonce2 }, action: 'renew' })
ok(v3 === null, '动作不匹配的签名被拒绝')

// 5. 时钟偏差过大 → 拒绝
const ts3 = Date.now() - 10 * 60 * 1000
const nonce3 = randomBytes(12).toString('hex')
const stale = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${deviceId}\n${ts3}\n${nonce3}\nrenew-v1`).digest('hex')
const v4 = await reg.verify({ authHeader: `DSH-Device ${deviceId}:${stale}`, body: { deviceId, ts: ts3, nonce: nonce3 }, action: 'renew' })
ok(v4 === null, '时钟偏差 >5min 被拒绝')

// 6. 篡改签名 → 拒绝（翻转末位，确保与原签名必然不同——原写法 slice+补'0' 在末位恰为'0'时会偶发相等）
const ts4 = Date.now()
const nonce4 = randomBytes(12).toString('hex')
const orig4 = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${deviceId}\n${ts4}\n${nonce4}\nrenew-v1`).digest('hex')
const tampered = orig4.slice(0, 63) + (orig4[63] === '0' ? '1' : '0')
const v5 = await reg.verify({ authHeader: `DSH-Device ${deviceId}:${tampered}`, body: { deviceId, ts: ts4, nonce: nonce4 }, action: 'renew' })
ok(v5 === null, '篡改签名被拒绝')

// 7. revoke 后 verify → 拒绝
await reg.revoke(deviceId)
const ts5 = Date.now()
const nonce5 = randomBytes(12).toString('hex')
const good2 = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${deviceId}\n${ts5}\n${nonce5}\nrenew-v1`).digest('hex')
const v6 = await reg.verify({ authHeader: `DSH-Device ${deviceId}:${good2}`, body: { deviceId, ts: ts5, nonce: nonce5 }, action: 'renew' })
ok(v6 === null, '撤销后 verify 拒绝')

// 8. 非法 secret 格式 → enroll 拒绝
try {
  await reg.enroll({ deviceId: 'short', secret: 'xyz' })
  ok(false, '非法 deviceId/secret 应被拒绝')
} catch { ok(true, '非法 deviceId/secret 被拒绝') }

// 9. 持久化：新实例读回
const reg2 = createRegistry({ dataDir: dir, log: console })
const list2 = await reg2.list()
ok(list2.length === 0, 'revoke 持久化（新实例读回为空）')

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n设备注册表测试全部通过' : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
