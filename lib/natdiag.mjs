/**
 * natdiag.mjs — 入向可达性自检（双层 NAT / 公网 IP 判定）。
 *
 * 背景：用户常按「路由器 DDNS + 端口映射」思路接入手机端，但国内宽带多为
 * 双层 NAT（光猫拨号 + 路由器二次 NAT）或运营商级 NAT（CGNAT），此时：
 *   · 路由器 WAN 口拿到的是私网地址 → DDNS 服务端拒登（Status: Disconnected）
 *   · 端口映射只穿透第一层，入向流量止步于上游光猫
 *   · 域名会解析到 DDNS 服务商的「占位 IP」，看似能解析实则不可达
 * 与其让用户反复折腾路由器，不如主动检测并给出可行替代（OpenVPN / 中继）。
 *
 * 判定逻辑（三层证据，逐级降级，任一失败不影响其余）：
 *   1) 本机默认网关地址是否落在 RFC1918 / CGNAT / 链路本地 → 判断是否存在上游 NAT
 *   2) 公网出口 IP（HTTPS 查询，避免 DNS 劫持）
 *   3) 网关设备指纹（HTTP Server 头）：Boa/GoAhead 多为光猫(ONU)
 *
 * 纯 Node 内置模块（net / dns / https），无第三方依赖；全部探测带超时，
 * 任一环节失败只降级该项结论，不抛异常。
 */
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'

/** 私网 / 特殊网段判定（用于识别「上游还有一层 NAT」） */
export function classifyAddress(ip) {
  if (!ip || isIP(ip) !== 4) return { private: false, kind: 'unknown' }
  const p = ip.split('.').map(Number)
  const [a, b] = p
  if (a === 10) return { private: true, kind: 'rfc1918', label: '10.0.0.0/8 私网' }
  if (a === 172 && b >= 16 && b <= 31) return { private: true, kind: 'rfc1918', label: '172.16.0.0/12 私网' }
  if (a === 192 && b === 168) return { private: true, kind: 'rfc1918', label: '192.168.0.0/16 私网' }
  if (a === 100 && b >= 64 && b <= 127) return { private: true, kind: 'cgnat', label: '100.64.0.0/10 运营商级 NAT(CGNAT)' }
  if (a === 169 && b === 254) return { private: true, kind: 'linklocal', label: '169.254.0.0/16 链路本地' }
  if (a === 127) return { private: true, kind: 'loopback', label: '127.0.0.0/8 环回' }
  if (a === 0 || a >= 224) return { private: true, kind: 'special', label: '保留/组播地址' }
  return { private: false, kind: 'public', label: '公网地址' }
}

/**
 * 粗略判断是否为「中国大陆运营商可能分配的 IP」。
 * 目的不是精确地理定位（那需要 GeoIP 数据库），而是识别明显的境外代理出口，
 * 避免把代理服务器 IP 当成宽带出口地址。误判只影响提示措辞，不影响裁决。
 */
export function isLikelyChinaIp(ip) {
  if (!ip || isIP(ip) !== 4) return false
  const p = ip.split('.').map(Number)
  const [a, b] = p
  // 中国 CNNIC/运营商主要 A 段（含电信/联通/移动/教育网常见段）
  if (a === 1 && ((b >= 0 && b <= 3) || (b >= 12 && b <= 14) || (b >= 24 && b <= 49) || (b >= 180 && b <= 199))) return true
  if (a === 14 && (b >= 16 && b <= 29)) return true
  if (a === 27 || a === 36 || a === 39 || a === 42 || a === 49) return true
  if (a === 58 || a === 59 || a === 60 || a === 61) return true
  if (a === 101 || a === 106 || a === 110 || a === 111 || a === 112 || a === 113) return true
  if (a === 114 || a === 115 || a === 116 || a === 117 || a === 118 || a === 119) return true
  if (a === 120 || a === 121 || a === 122 || a === 123 || a === 124 || a === 125) return true
  if (a === 139 || a === 140 || a === 144 || a === 150 || a === 153 || a === 157) return true
  if (a === 159 || a === 161 || a === 162 || a === 163 || a === 166 || a === 167 || a === 168) return true
  if (a === 171 || a === 175 || a === 180 || a === 182 || a === 183) return true
  if (a === 202 || a === 203 || a === 210 || a === 211 || a === 218 || a === 219) return true
  if (a === 220 || a === 221 || a === 222 || a === 223) return true
  return false
}

/** 带超时的 HTTP(S) GET，返回 { ok, status, body, error } */function fetchText(url, { timeoutMs = 6000, insecure = false } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    let req
    try {
      const mod = url.startsWith('https:') ? httpsRequest : httpRequest
      req = mod(url, { timeout: timeoutMs, rejectUnauthorized: !insecure }, (res) => {
        const chunks = []
        res.on('data', (c) => { if (chunks.length < 64) chunks.push(c) })
        res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
    } catch (e) {
      return done({ ok: false, error: String(e && e.message || e) })
    }
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }) })
    req.on('error', (e) => done({ ok: false, error: String(e && e.message || e) }))
    req.end()
  })
}

/** 查询公网出口 IPv4（多源轮询，任一成功即返回） */
export async function queryPublicIp({ timeoutMs = 6000, sources } = {}) {
  const list = sources || [
    { url: 'https://api.ipify.org?format=json', pick: (t) => { try { return JSON.parse(t).ip } catch { return (t.match(/\d+\.\d+\.\d+\.\d+/) || [])[0] } } },
    { url: 'https://ifconfig.me/ip', pick: (t) => (t.match(/\d+\.\d+\.\d+\.\d+/) || [])[0] },
    { url: 'https://ipinfo.io/ip', pick: (t) => (t.match(/\d+\.\d+\.\d+\.\d+/) || [])[0] },
  ]
  const errors = []
  for (const s of list) {
    const r = await fetchText(s.url, { timeoutMs })
    if (r.ok && r.body) {
      const ip = s.pick(r.body)
      if (ip && isIP(ip) === 4) return { ok: true, ip, source: s.url }
    }
    errors.push(`${s.url}: ${r.error || 'HTTP ' + r.status}`)
  }
  return { ok: false, errors }
}

/** 探测网关设备指纹（HTTP Server 头）——Boa/GoAhead 常为光猫 */
export async function probeGateway(gateway, { timeoutMs = 4000 } = {}) {
  if (!gateway || isIP(gateway) !== 4) return { ok: false, error: 'invalid gateway' }
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    let req
    try {
      req = httpRequest({ host: gateway, port: 80, path: '/', method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume()
        done({ ok: true, server: res.headers.server || '', status: res.statusCode })
      })
    } catch (e) { return done({ ok: false, error: String(e && e.message || e) }) }
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }) })
    req.on('error', (e) => done({ ok: false, error: String(e && e.message || e) }))
    req.end()
  })
}

/**
 * 入向可达性总检。
 * @param {object} opts
 * @param {string} [opts.gateway]    本机默认网关（省略则自动探测结果由调用方注入）
 * @param {string} [opts.wanIp]      路由器 WAN 口地址（调用方已知时注入，最准确）
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.skipPublicIp]
 * @returns {Promise<object>} { verdict, doubleNat, publicIp, gateway, reasons[], advice }
 */
export async function diagnoseInbound({ gateway, wanIp, timeoutMs = 6000, skipPublicIp = false } = {}) {
  const reasons = []
  const publicIpRes = skipPublicIp ? { ok: false, errors: ['skipped'] } : await queryPublicIp({ timeoutMs })
  const publicIp = publicIpRes.ok ? publicIpRes.ip : null

  const wan = wanIp ? { ip: wanIp, ...classifyAddress(wanIp) } : null
  const gw = gateway ? { ip: gateway, ...classifyAddress(gateway) } : null

  // 证据 1：路由器 WAN 口地址是否私网 —— 最强信号
  if (wan) {
    if (wan.private) reasons.push(`路由器 WAN 口地址 ${wan.ip} 属${wan.label}，上游还有一层 NAT`)
    else reasons.push(`路由器 WAN 口地址 ${wan.ip} 是公网地址`)
  }

  // 证据 2：本机网关是否私网（说明至少一层 NAT；与证据 1 配合可判双层）
  if (gw && gw.private) reasons.push(`本机默认网关 ${gw.ip} 属${gw.label}`)

  // 证据 3：WAN 口地址 vs 公网出口地址 一致性
  let matchesPublic = null
  if (wan && publicIp) {
    matchesPublic = wan.ip === publicIp
    if (!matchesPublic) reasons.push(`WAN 口地址(${wan.ip}) ≠ 公网出口地址(${publicIp})，二者被 NAT 隔开`)
    else reasons.push('WAN 口地址与公网出口地址一致，说明处于公网（单层 NAT 或 DMZ 桥接）')
  }

  // 证据 4：网关设备指纹
  let gatewayDevice = null
  if (gateway) {
    const p = await probeGateway(gateway, { timeoutMs: Math.min(timeoutMs, 4000) })
    if (p.ok && p.server) {
      gatewayDevice = p.server
      if (/boa/i.test(p.server)) reasons.push(`上游网关 ${gateway} 响应 Server: ${p.server}（典型光猫/ONU 指纹）`)
    }
  }

  // 证据 5：代理污染提示。
  // 本机若运行代理软件（FlClash/Clash 等 TUN 模式），公网 IP 查询会走代理出口，
  // 得到的是代理服务器所在地 IP，与真实宽带出口无关，会污染「一致性」判断。
  // 这里不试图修正，只显式提示，避免用户被误导。
  let proxySuspected = false
  if (publicIp && !isLikelyChinaIp(publicIp)) {
    proxySuspected = true
    reasons.push(`公网出口 IP ${publicIp} 归属地疑似境外，很可能是代理软件出口而非真实宽带出口；该值仅供参考`)
  } else if (!publicIp && Array.isArray(publicIpRes?.errors) && publicIpRes.errors.length > 0) {
    reasons.push('公网出口 IP 探测失败（可能被代理或防火墙拦截），本次仅依据本机与 WAN 口地址判断')
  }

  // 综合裁决
  let verdict
  let doubleNat = false
  if (wan && !wan.private && matchesPublic === true) {
    verdict = 'public'
  } else if (wan && wan.private) {
    verdict = 'double-nat'
    doubleNat = true
  } else if (wan && !wan.private && matchesPublic === false) {
    verdict = 'cgnat-or-multi-nat'
    doubleNat = true
  } else if (gw && gw.private) {
    verdict = 'likely-nat'
  } else {
    verdict = 'unknown'
  }

  const advice = {
    public: '可用「公网入口 / 端口映射」方案：路由器映射 47896 → 宿主，桌面「公网入口」卡片填入公网地址即可，手机零安装。',
    'double-nat': '入向不可达：路由器 WAN 口为私网地址，DDNS 会拒登、端口映射穿不过上游光猫。请改走「OpenVPN 通道」或「自建中继」（二者均为主动出向，天然穿透 NAT），不要继续配置 DDNS。',
    'cgnat-or-multi-nat': '入向不可达：处于运营商级 NAT(CGNAT) 或多层 NAT 之后，无法自行端口映射。请改走「OpenVPN 通道」或「自建中继」。',
    'likely-nat': '检测到本机位于私网，但未拿到路由器 WAN 口地址，无法判定入向是否可达。请在路由器「网络 → WAN」查看 IPAddress：若为 10./100.64-127./172.16-31./192.168. 开头即为双层 NAT。',
    unknown: '未能完成判定（网络探测超时或被代理拦截）。请在路由器「网络 → WAN」查看 IPAddress 是否私网。',
  }[verdict]

  return {
    verdict, doubleNat, publicIp, gateway, wanIp: wanIp || null,
    gatewayDevice, matchesPublic, proxySuspected, reasons, advice,
    checkedAt: new Date().toISOString(),
  }
}
