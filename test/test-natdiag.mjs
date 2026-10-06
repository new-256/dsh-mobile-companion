/**
 * test-natdiag.mjs — 入向可达性自检单测。
 * 运行：node test/test-natdiag.mjs
 */
import { classifyAddress, diagnoseInbound, isLikelyChinaIp } from '../lib/natdiag.mjs'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`) }
}

console.log('\n[classifyAddress] 私网/公网归类')
{
  const cases = [
    ['192.168.5.1', true, 'rfc1918'],
    ['192.168.1.9', true, 'rfc1918'],
    ['10.80.12.2', true, 'rfc1918'],
    ['10.0.0.1', true, 'rfc1918'],
    ['172.16.0.1', true, 'rfc1918'],
    ['172.31.255.254', true, 'rfc1918'],
    ['172.32.0.1', false, 'public'],
    ['100.64.0.1', true, 'cgnat'],
    ['100.127.255.254', true, 'cgnat'],
    ['100.128.0.1', false, 'public'],
    ['169.254.1.1', true, 'linklocal'],
    ['127.0.0.1', true, 'loopback'],
    ['117.36.156.68', false, 'public'],
    ['8.8.8.8', false, 'public'],
    ['1.1.1.1', false, 'public'],
    ['224.0.0.1', true, 'special'],
  ]
  for (const [ip, priv, kind] of cases) {
    const r = classifyAddress(ip)
    ok(r.private === priv && r.kind === kind, `${ip} → private=${priv} kind=${kind}`, r)
  }
  ok(classifyAddress('not-an-ip').kind === 'unknown', '非法输入 → unknown')
  ok(classifyAddress('').kind === 'unknown', '空串 → unknown')
  ok(classifyAddress('2409:8a70::1').kind === 'unknown', 'IPv6 → unknown（本模块只判 v4）')
}

console.log('\n[isLikelyChinaIp] 代理出口识别')
{
  // 国内常见：山西电信 117.36.x、北京联通 114.x、移动 111.x
  ok(isLikelyChinaIp('117.36.156.68') === true, '117.36.156.68 → 判定为国内')
  ok(isLikelyChinaIp('114.114.114.114') === true, '114.114.114.114 → 国内')
  ok(isLikelyChinaIp('111.18.85.247') === true, '111.18.85.247 → 国内')
  ok(isLikelyChinaIp('223.5.5.5') === true, '223.5.5.5 → 国内')
  ok(isLikelyChinaIp('1.2.4.8') === true, '1.2.4.8 → 国内')
  // 境外（代理出口常见）
  ok(isLikelyChinaIp('86.53.163.108') === false, '86.53.163.108(欧洲) → 非国内')
  ok(isLikelyChinaIp('8.8.8.8') === false, '8.8.8.8 → 非国内')
  ok(isLikelyChinaIp('104.16.0.1') === false, '104.16.0.1(Cloudflare) → 非国内')
  ok(isLikelyChinaIp('172.32.0.1') === false, '172.32.0.1 → 非国内')
  ok(isLikelyChinaIp('not-ip') === false, '非法输入 → false（不抛异常）')
  ok(isLikelyChinaIp('') === false, '空串 → false')
}

console.log('\n[diagnoseInbound] 裁决逻辑（skipPublicIp，避免联网）')
{
  // 真实复现场景：ZTE WAN=192.168.1.9（私网）→ 双层 NAT
  const r1 = await diagnoseInbound({ wanIp: '192.168.1.9', skipPublicIp: true })
  ok(r1.verdict === 'double-nat', 'WAN=192.168.1.9 → double-nat', r1.verdict)
  ok(r1.doubleNat === true, 'doubleNat=true')
  ok(/192\.168\.1\.9/.test(r1.reasons.join(' ')), '原因里含 WAN 地址')
  ok(/OpenVPN|中继/.test(r1.advice), '建议指向 OpenVPN/中继')

  // CGNAT
  const r2 = await diagnoseInbound({ wanIp: '100.100.1.1', skipPublicIp: true })
  ok(r2.verdict === 'double-nat', 'WAN=100.100.1.1(CGNAT) → double-nat', r2.verdict)

  // 公网 WAN 但无公网 IP 查询 → 不误判为 public（缺少一致性证据）
  const r3 = await diagnoseInbound({ wanIp: '117.36.156.68', skipPublicIp: true })
  ok(r3.verdict === 'unknown' || r3.verdict === 'likely-nat', '公网 WAN 无出口比对 → 不轻断 public', r3.verdict)
  ok(r3.verdict !== 'public', '缺少一致性证据时不判 public')

  // 仅私网网关 → likely-nat
  const r4 = await diagnoseInbound({ gateway: '192.168.5.1', skipPublicIp: true, timeoutMs: 800 })
  ok(r4.verdict === 'likely-nat' || r4.verdict === 'double-nat', '仅私网网关 → likely-nat', r4.verdict)

  // 空输入 → unknown，且不抛异常
  const r5 = await diagnoseInbound({ skipPublicIp: true })
  ok(r5.verdict === 'unknown', '无输入 → unknown', r5.verdict)
  ok(typeof r5.advice === 'string' && r5.advice.length > 0, '始终给出 advice')

  // 结构完整性
  ok(Array.isArray(r1.reasons) && r1.reasons.length > 0, 'reasons 为非空数组')
  ok(typeof r1.checkedAt === 'string' && !Number.isNaN(Date.parse(r1.checkedAt)), 'checkedAt 为合法时间戳')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} natdiag: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
