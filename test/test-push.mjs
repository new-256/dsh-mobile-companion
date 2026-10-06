/**
 * test-push.mjs — 推送注册表 + 投递工具测试（M2 推送脚手架）。
 *
 * 覆盖：
 *   · 注册/更新/注销；platform 白名单；token 长度校验
 *   · status() 不回显 token 本体
 *   · 免打扰窗口判定（常规 + 跨午夜），tokenFor 在窗口内返回 null
 *   · 投递：HTTP v1（JWT/OAuth 请求形状）与 legacy 两种模式、按设备过滤、免打扰跳过
 *   · revoke 联动注销（在 test-acceptance 中覆盖）
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { createPushRegistry, validateDnd, inDndWindow } from '../lib/push.mjs'
import { pushNotify, buildV1Message, buildLegacyMessage, fetchV1AccessToken } from '../../../relay/tools/dsh-push.mjs'
let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'dsh-push-'))

console.log('\n── 注册表 ───────────────────────────────────────────')
const reg = createPushRegistry({ dataPath: dir })
reg.load()
const r1 = await reg.register('dev-1', { token: 'fcm-token-abc123', platform: 'android' })
ok(r1.ok === true, 'android 注册成功')
const r2 = await reg.register('dev-2', { token: 'ios-token-xyz987', platform: 'ios' })
ok(r2.ok === true, 'ios 注册成功')
const r3 = await reg.register('dev-3', { token: 'tok', platform: 'android' })
ok(r3.ok === false, '过短 token 被拒')
const r4 = await reg.register('dev-3', { token: 'good-token-0001', platform: 'webos' })
ok(r4.ok === false, '未知 platform 被拒')

const st = reg.status()
ok(st.registered === 2, 'status 统计 2 台设备')
ok(!JSON.stringify(st).includes('fcm-token-abc123'), 'status 不回显 token 本体')
ok(st.devices.every((d) => d.deviceId && d.platform && d.ts), 'status 含 deviceId/platform/ts')

await reg.register('dev-1', { token: 'fcm-token-UPDATED', platform: 'android' })
ok(reg.tokenFor('dev-1').token === 'fcm-token-UPDATED' || reg.tokenFor('dev-1') === 'fcm-token-UPDATED', '重复注册覆盖旧 token')

console.log('\n── 免打扰 ───────────────────────────────────────────')
ok(validateDnd({ enabled: true, from: '22:00', to: '08:00' }).ok === true, '跨午夜窗口合法')
ok(validateDnd({ enabled: true, from: '25:00', to: '08:00' }).ok === false, '非法时间被拒')
ok(inDndWindow({ enabled: true, from: '09:00', to: '18:00' }, new Date(2026, 0, 1, 12, 0)) === true, '窗口内判定 true')
ok(inDndWindow({ enabled: true, from: '09:00', to: '18:00' }, new Date(2026, 0, 1, 20, 0)) === false, '窗口外判定 false')
ok(inDndWindow({ enabled: true, from: '22:00', to: '08:00' }, new Date(2026, 0, 1, 23, 30)) === true, '跨午夜（23:30）判定 true')
ok(inDndWindow({ enabled: true, from: '22:00', to: '08:00' }, new Date(2026, 0, 1, 6, 0)) === true, '跨午夜（06:00）判定 true')
ok(inDndWindow({ enabled: false, from: '22:00', to: '08:00' }, new Date(2026, 0, 1, 23, 0)) === false, '关闭状态不拦截')

await reg.setDnd('dev-1', { enabled: true, from: '22:00', to: '08:00' })
const atNight = new Date(2026, 0, 1, 23, 0)
const atNoon = new Date(2026, 0, 1, 12, 0)
ok(reg.tokenFor('dev-1', atNight) === null, '免打扰窗口内 tokenFor 返回 null（跳过）')
ok(typeof reg.tokenFor('dev-1', atNoon) === 'string', '窗口外 tokenFor 返回 token')
await reg.setDnd('dev-1', { enabled: false })
ok(reg.tokenFor('dev-1', atNight) !== null, '关闭免打扰后不再跳过')
await reg.setDnd('dev-1', { enabled: true, from: '22:00', to: '08:00' })

console.log('\n── 投递工具（注入假 fetcher）────────────────────────')
const requests = []
const fakeFetch = async (url, init) => {
  requests.push({ url, init })
  return { status: 200 }
}
const pushData = { devices: reg.status() && (() => { /* 重建数据便于断言 */ })() || {} }
// 直接用注册表内部数据构造 pushData
const pushDataReal = { devices: {}, dnd: {} }
for (const d of reg.status().devices) {
  pushDataReal.devices[d.deviceId] = { token: d.deviceId === 'dev-1' ? 'fcm-token-UPDATED' : 'ios-token-xyz987', platform: d.platform }
}
pushDataReal.dnd['dev-1'] = { enabled: true, from: '22:00', to: '08:00' }
void pushData

const res1 = await pushNotify({
  pushData: pushDataReal, title: '任务完成', body: 'DSH 已回复', url: 'http://x/m/#/chat/s1',
  fcmServerKey: 'AAAkey', fetcher: fakeFetch, now: new Date(2026, 0, 1, 12, 0),
})
ok(res1.sent === 2, `legacy 模式全部发出（实际 sent=${res1.sent}）`)
const legacyReq = requests[0]
ok(legacyReq.url === 'https://fcm.googleapis.com/fcm/send', 'legacy 请求 URL 正确')
ok(legacyReq.init.headers.authorization === 'key=AAAkey', 'legacy 请求带服务器密钥头')
ok(requests.some((r) => r.init.body.includes('"to":"ios-token-xyz987"')), 'legacy 消息含 to=token')
ok(legacyReq.init.body.includes('"url":"http://x/m/#/chat/s1"'), 'legacy 消息含 data.url（通知点击跳转）')

requests.length = 0
const res2 = await pushNotify({
  pushData: pushDataReal, title: 'x', body: 'y',
  fcmServerKey: 'k', fetcher: fakeFetch, now: new Date(2026, 0, 1, 23, 0),
})
console.log('[debug] pushDataReal.dnd =', JSON.stringify(pushDataReal.dnd), 'devices =', Object.keys(pushDataReal.devices))
ok(res2.sent === 1 && res2.skipped.includes('dev-1'), `免打扰窗口内跳过 dev-1（sent=${res2.sent}, skipped=${res2.skipped}）`)

requests.length = 0
const res3 = await pushNotify({
  pushData: pushDataReal, title: 'x', body: 'y',
  fcmServerKey: 'k', fetcher: fakeFetch, now: new Date(2026, 0, 1, 23, 0), force: true,
})
ok(res3.sent === 2, '--force 忽略免打扰')

const res4 = await pushNotify({
  pushData: pushDataReal, title: 'x', body: 'y', deviceIds: ['dev-2'],
  fcmServerKey: 'k', fetcher: fakeFetch, now: new Date(2026, 0, 1, 12, 0),
})
ok(res4.sent === 1 && res4.results[0].deviceId === 'dev-2', '--device 按设备过滤')

// HTTP v1：注入 v1Token 跳过真实 JWT 签名（签名路径由 fetchV1AccessToken 单测另验）
const v1Fetch = async (url, init) => {
  requests.push({ url, init })
  return { status: 200, json: async () => ({ name: 'projects/x/messages/1' }) }
}
requests.length = 0
const sa = { client_email: 'svc@x.iam.gserviceaccount.com', private_key: 'ignored-in-test', project_id: 'dsh-mobile' }
const res5 = await pushNotify({
  pushData: pushDataReal, title: 'x', body: 'y', deviceIds: ['dev-2'],
  serviceAccount: sa, v1Token: 'fake-oauth-token', fetcher: v1Fetch, now: new Date(2026, 0, 1, 12, 0),
})
ok(res5.sent === 1, 'HTTP v1 发送成功')
const v1Req = requests[0]
ok(v1Req.url === 'https://fcm.googleapis.com/v1/projects/dsh-mobile/messages:send', 'v1 请求 URL 正确')
ok(v1Req.init.headers.authorization === 'Bearer fake-oauth-token', 'v1 请求带 Bearer token')
ok(v1Req.init.body.includes('"notification"'), 'v1 消息含 notification')

console.log('\n── 消息体构造 ──────────────────────────────────────')
const v1msg = buildV1Message({ token: 't', title: 'a', body: 'b', url: 'u' })
ok(v1msg.message.token === 't' && v1msg.message.data.url === 'u', 'buildV1Message 形状正确')
const legacyMsg = buildLegacyMessage({ token: 't', title: 'a', body: 'b', url: 'u' })
ok(legacyMsg.to === 't' && legacyMsg.data.url === 'u', 'buildLegacyMessage 形状正确')

console.log('\n── JWT(RS256) 换取 OAuth token（真实密钥对）──────────')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
let oauthBody = ''
let oauthUrl = ''
const oauthFetch = async (url, init) => {
  oauthUrl = url
  oauthBody = init.body
  return { status: 200, ok: true, json: async () => ({ access_token: 'real-oauth-token' }) }
}
const sa2 = { client_email: 'svc@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'p' }
const token2 = await fetchV1AccessToken(sa2, oauthFetch)
ok(token2 === 'real-oauth-token', '换取到 access token')
ok(oauthUrl === 'https://oauth2.googleapis.com/token', 'OAuth 端点正确')
ok(oauthBody.includes('grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')), 'OAuth 用 jwt-bearer 授权')
const assertion = new URLSearchParams(oauthBody).get('assertion')
const [h, c, sig] = assertion.split('.')
const b64d = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
ok(b64d(h).alg === 'RS256' && b64d(h).typ === 'JWT', 'JWT 头 alg=RS256')
ok(b64d(c).iss === 'svc@example.iam.gserviceaccount.com' && b64d(c).scope.includes('firebase.messaging'), 'JWT 声明含 service account 与 firebase.messaging 范围')
const verifier = createVerify('RSA-SHA256')
verifier.update(`${h}.${c}`)
ok(verifier.verify(publicKey.export({ type: 'spki', format: 'pem' }), Buffer.from(sig, 'base64url')), 'JWT 签名可用公钥验证（真实 RS256 签名）')

await rm(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n推送测试全部通过' : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
