/**
 * lib/rewrite.mjs — Host/Origin/Referer 头改写与 Set-Cookie Domain 剥离。
 *
 * DSH /api 信任栅栏要求 Host 为 loopback 或 trustedHosts，且 Origin（若存在）
 * 必须等于 Host。因此任何进入隧道/代理的请求，落点都必须把三头改写为环回
 * authority，使 Cookie 签发与校验口径一致。
 *
 * 本模块供 lib/forward.mjs（LAN 代理）与 lib/tunnel.mjs（outbound WSS 隧道）共用，
 * 避免两份实现漂移。
 */

/**
 * 改写请求头。
 * @param {object} headers 原始头对象
 * @param {string} targetAuthority 目标 authority，例如 127.0.0.1:8080
 * @returns {object} 新头对象
 */
export function rewriteHeaders(headers, targetAuthority) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const lc = key.toLowerCase()
    if (lc === 'host') {
      out[key] = targetAuthority
    } else if (lc === 'origin' && value) {
      out[key] = `http://${targetAuthority}`
    } else if (lc === 'referer' && value) {
      out[key] = rewriteReferer(value, targetAuthority)
    } else {
      out[key] = value
    }
  }
  // 若没有 Host 头则补上（HTTP/1.1 必须有）
  if (!Object.keys(out).some(k => k.toLowerCase() === 'host')) {
    out.Host = targetAuthority
  }
  return out
}

/**
 * 改写 Referer，只改 scheme + authority，保留路径/query/hash。
 * @param {string} value
 * @param {string} targetAuthority
 */
export function rewriteReferer(value, targetAuthority) {
  try {
    const u = new URL(value)
    return `http://${targetAuthority}${u.pathname}${u.search}${u.hash}`
  } catch {
    return value
  }
}

/** 把 rawHeaders 中的 Set-Cookie Domain 属性剥除，避免浏览器按代理 authority 拒收 */
export function stripSetCookieDomain(rawHeaders) {
  if (!Array.isArray(rawHeaders)) return rawHeaders
  const out = []
  let i = 0
  while (i < rawHeaders.length) {
    const key = rawHeaders[i]
    let value = rawHeaders[i + 1]
    if (key.toLowerCase() === 'set-cookie' && typeof value === 'string') {
      value = value.replace(/;\s*domain=[^;]+/gi, '')
    }
    out.push(key, value)
    i += 2
  }
  return out
}
