/**
 * pairing.mjs — 配对信息构造（服务 mobileCompanion.pairingInfo()）。
 *
 * 载荷：
 *   v: 1 — 直连候选 only
 *   v: 2 — 启用 LAN 透明代理，urls 首位为代理地址，直连候选保留在后
 *   { v, type: 'dsh-pair', name, host, port, urls: [...], token }
 *   urls  — 可达该实例的根 URL 列表（无 token；token 单列，App 交换时拼接）
 *   深链  — dshpair://<base64url(JSON)>
 *
 * token 通过 ctx.connection.authenticatedUrl() 铸造（一次性，即扫即用）。
 */

import { hostname, networkInterfaces } from 'node:os'
import { qrSvg, qrPng } from './qr.mjs'

/** 把 wss/ws URL 转成 https/http 访问 URL（手机通过反代走 HTTP） */
function relayHttpUrl(relayUrl, instanceId) {
  const u = new URL(relayUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = `/i/${encodeURIComponent(instanceId)}`
  u.search = ''
  u.hash = ''
  return u.toString()
}

// ── 已知虚拟/虚拟专用网接口名模式（大小写不敏感前缀匹配） ──────────
const VIRTUAL_PATTERNS = [
  'hyper-v', 'vEthernet', 'default switch', 'docker', 'nat', 'br-',
  'wsl', 'tailscale', 'zerotier', 'vmware', 'virtualbox', 'radmin',
  'bluetooth', 'loopback', 'tun', 'tap', 'ndis', 'pseudo',
  '本地连接', 'bluetooth network',
]

/** 是否为已知虚拟/专用网接口 */
function isVirtual(name) {
  const lc = name.toLowerCase()
  return VIRTUAL_PATTERNS.some(p => lc.includes(p))
}

/** 是否为 link-local / CGNAT / TUN 假 IP */
function isAnnoyingIp(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return true
  // 169.254.x.x link-local, 100.64.x.x CGNAT, 198.18.x.x 代理假 IP
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true
  return false
}

/**
 * 虚拟组网接口策略（用户可手动选择，见 /api/mobile/netconf 与配置手册 §1）：
 *   false / 'off' / 缺省        → 虚拟接口照旧剔除（仅无物理接口时降级）【默认】
 *   true  / 'all'               → 放行全部虚拟接口（Tailscale/ZeroTier/Radmin/WSL 等）
 *   string[]                    → 只放行名字匹配其中任一模式（大小写不敏感 contains）
 */
export function normalizeVirtualOpt(opt) {
  if (opt === true || opt === 'all') return true
  if (Array.isArray(opt) && opt.length) return opt.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  return false
}

/** 判断某虚拟接口是否被用户策略放行 */
function isVirtualAllowed(name, virtualOpt) {
  const opt = normalizeVirtualOpt(virtualOpt)
  if (opt === true) return true
  if (Array.isArray(opt)) {
    const lc = String(name).toLowerCase()
    return opt.some((p) => lc.includes(String(p).toLowerCase()))
  }
  return false
}

/**
 * 用户显式放行的虚拟组网接口是否可用（进入候选）。
 * 注意：Tailscale 默认段 100.64.0.0/10 就是 CGNAT，普通剔除会误伤——
 * 放行组网接口时 CGNAT 不再算「假 IP」；但 link-local(169.254) 与代理
 * TUN 假 IP(198.18/198.19) 仍剔除（那些不是组网地址）。
 */
function allowedVirtualIface(name, address, virtualOpt) {
  if (!isVirtual(name) || !isVirtualAllowed(name, virtualOpt)) return false
  const p = address.split('.').map(Number)
  if (p.length !== 4) return false
  if (p[0] === 169 && p[1] === 254) return false
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false
  return true
}

/**
 * 智能采样局域网 IPv4。
 * 优先：有默认网关的物理接口 > 无网关的物理接口 > 虚拟接口（但只在无真正 LAN 时降级）
 * 跳过：link-local、CGNAT、代理 TUN 假 IP 区间（用户放行的组网虚拟接口豁免 CGNAT）
 * @param {object} [injected]  networkInterfaces() 的返回值（测试注入）
 * @param {object} [opts]      { virtual } 虚拟接口策略（normalizeVirtualOpt 语义）
 */
export function sampleLanIps(injected = null, opts = {}) {
  const ifaces = injected || networkInterfaces()
  const candidates = { real: [], allowedVirtual: [], virtual: [] }

  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue

      // 用户放行的组网虚拟接口：单独收容（豁免 CGNAT），排在物理接口之后
      if (allowedVirtualIface(name, iface.address, opts.virtual)) {
        candidates.allowedVirtual.push({ name, address: iface.address, iface })
        continue
      }
      if (isAnnoyingIp(iface.address)) continue

      const entry = { name, address: iface.address, iface }
      if (isVirtual(name) && !isVirtualAllowed(name, opts.virtual)) {
        candidates.virtual.push(entry)
      } else {
        candidates.real.push(entry)
      }
    }
  }

  // 优先真实物理接口；放行的组网虚拟接口紧随其后（App 探测以此顺序为准）；
  // 无物理才回退到未放行的虚拟接口
  const chosen = candidates.real.length
    ? [...candidates.real, ...candidates.allowedVirtual]
    : candidates.allowedVirtual.length
      ? candidates.allowedVirtual
      : candidates.virtual.length
        ? candidates.virtual
        : [{ name: 'fallback', address: '127.0.0.1', iface: null }]

  // 仅返回有序地址列表
  return chosen.map(e => e.address)
}

/**
 * 采样全球单播 IPv6（2000::/3）。
 * 中国宽带 IPv4 多为运营商 CGNAT（公网不可达），但 IPv6 常为公网可路由——
 * 手机蜂窝网有 IPv6 即可零配置直连宿主。
 * 剔除：链路本地 fe80::/10、ULA fc00::/7、Teredo 2001:0000::/32、环回 ::1。
 */
export function sampleGlobalIps6(injected = null) {
  const ifaces = injected || networkInterfaces()
  const out = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv6' || iface.internal) continue
      const ip = String(iface.address)
      if (/^fe80:/i.test(ip)) continue
      if (/^f[cd][0-9a-f]{2}:/i.test(ip)) continue // fc00::/7 ULA
      if (/^2001:0+:/i.test(ip)) continue // Teredo 2001:0000::/32
      out.push(ip)
    }
  }
  return [...new Set(out)]
}

/** 采样含诊断信息的接口详情（用于 net-check） */
export function diagnoseInterfaces(injected = null, opts = {}) {
  const ifaces = injected || networkInterfaces()
  const detail = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      detail.push({
        name,
        address: iface.address,
        netmask: iface.netmask,
        mac: iface.mac || '',
        virtual: isVirtual(name),
        allowed: allowedVirtualIface(name, iface.address, opts.virtual) || !isVirtual(name),
        annoying: isAnnoyingIp(iface.address),
      })
    }
  }
  return detail
}

/** base64url（无填充） */
function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * 构建配对信息。
 * @param {object} ctx        Cordis 上下文（webServer + connection）
 * @param {object} [extra]    { lanIps } 覆盖采样
 */
export function buildPairingInfo(ctx, extra = {}) {
  const port = ctx.webServer?.port
  const bindHost = ctx.webServer?.host || '127.0.0.1'
  if (!port) throw new Error('webServer 未就绪（端口未知）')

  // LAN 地址：优先 webRuntime 服务（已含信任口径）；用户显式放行虚拟接口时改用自有采样
  let lanIps = extra.lanIps
  if (!lanIps) {
    const virtualOpt = normalizeVirtualOpt(extra.virtual)
    if (virtualOpt !== false) {
      lanIps = sampleLanIps(null, { virtual: virtualOpt })
    } else {
      const webRuntime = ctx.get('webRuntime')
      lanIps = webRuntime?.lanAddresses?.length ? webRuntime.lanAddresses : sampleLanIps()
    }
  }
  // 追加候选（如 OpenVPN 等主动建立的通道虚拟 IP），排在采样结果之后
  if (Array.isArray(extra.extraLanIps)) {
    for (const ip of extra.extraLanIps) {
      if (typeof ip === 'string' && !lanIps.includes(ip)) lanIps.push(ip)
    }
  }

  const proxyPort = extra.proxyPort || null
  const directReachable = bindHost === '0.0.0.0' || bindHost === '::'
  const reachable = directReachable || !!proxyPort
  const name = hostname()

  // 公网入口（网关端口映射直连宿主代理端口）：异地手机零安装访问入口
  const publicUrl = typeof extra.publicUrl === 'string' && extra.publicUrl ? extra.publicUrl : null

  // 全球单播 IPv6（公网可达，中国宽带 IPv4 CGNAT 下的直连通道）。
  // 只取 1 个：IPv6 地址 ≈65 字符，多个会挤爆 QR 载荷容量（v13-M 上限 331 字节）。
  const v6IpsAll = extra.v6Ips !== undefined ? extra.v6Ips : sampleGlobalIps6()
  const v6Ips = v6IpsAll.slice(0, 1)

  // 根 URL 候选：仅 loopback 直连保留（LAN 直连与代理候选重复、且手机不可达
  // DSH 主端口——代理端口才是手机入口；裁剪以压缩 QR 载荷）
  const directUrls = [`http://127.0.0.1:${port}`]

  // 若存在 LAN 代理端口，生成代理 URL 并置于候选首位；IPv6 代理紧随其后（异地首选）
  const proxyUrls = proxyPort && lanIps.length
    ? lanIps.map(ip => `http://${ip}:${proxyPort}`)
    : []
  const proxyUrls6 = proxyPort && v6Ips.length
    ? v6Ips.map(ip => `http://[${ip}]:${proxyPort}`)
    : []

  // 若启用中继隧道，把中继地址放在局域网代理之后、直连候选之前
  const relay = extra.relay
  const relayUrls = (relay && relay.enabled && relay.relayUrl && relay.instanceId)
    ? [relayHttpUrl(relay.relayUrl, relay.instanceId)]
    : []

  // 候选顺序：IPv4 代理 → IPv6 代理 → 公网入口（端口转发）→ 中继 → 直连
  let urls = [...proxyUrls, ...proxyUrls6, ...(publicUrl ? [publicUrl] : []), ...relayUrls, ...directUrls]

  // QR 载荷容量兜底（v13-M = 331 字节）：超限时从尾部按「最不关键」顺序裁剪
  // （中继 → 公网入口 → IPv6 代理），保证 IPv4 代理与 loopback 恒在。
  const QR_BUDGET = 331
  const jsonLen = (u) => JSON.stringify({ v: proxyPort ? 2 : 1, type: 'dsh-pair', name, host: '', port: '', urls: u, token: '' }).length
  if (jsonLen(urls) > QR_BUDGET) {
    for (const drop of [relayUrls, publicUrl ? [publicUrl] : [], proxyUrls6]) {
      if (jsonLen(urls) <= QR_BUDGET) break
      urls = urls.filter((u) => !drop.includes(u))
    }
  }

  // token URL（一次性交换入口）：优先公网入口，其次 IPv6 代理（异地公网可达），
  // 再 IPv4 代理地址（同网/可直连场景），最后直连 primary
  const primaryBase = publicUrl
    ? publicUrl
    : proxyPort && v6Ips.length
      ? `http://[${v6Ips[0]}]:${proxyPort}`
      : proxyPort && lanIps.length
        ? `http://${lanIps[0]}:${proxyPort}`
        : directReachable && lanIps.length
          ? `http://${lanIps[0]}:${port}`
          : `http://127.0.0.1:${port}`
  const tokenUrl = ctx.connection.authenticatedUrl(primaryBase)
  const token = new URL(tokenUrl).searchParams.get('token') || ''

  const payload = {
    v: proxyPort ? 2 : 1,
    type: 'dsh-pair',
    name,
    host: new URL(primaryBase).hostname,
    port: new URL(primaryBase).port,
    urls,
    token,
  }
  if (relay && relay.enabled && relay.relayUrl && relay.instanceId) {
    payload.relay = {
      url: relay.relayUrl,
      instanceId: relay.instanceId,
    }
  }
  const payloadJson = JSON.stringify(payload)
  const deepLink = `dshpair://${b64url(payloadJson)}`

  // QR 内容 = 载荷 JSON（App 解析）；浏览器扫码用户改走 /m/ 引导页的说明文字
  const qrText = payloadJson
  const lanUrl = tokenUrl

  return {
    name,
    port,
    bindHost,
    reachable,
    urls,
    lanUrl,
    tokenUrl,
    payload,
    payloadJson,
    deepLink,
    qrSvg: qrSvg(qrText, { scale: 4, quiet: 4 }),
    qrPng: qrPng(qrText, { scale: 6, quiet: 4 }),
    lanIps,
  }
}