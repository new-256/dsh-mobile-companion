/**
 * publicconf.mjs — 公网入口（端口转发）运行时配置。
 *
 * 场景：用户的 OpenVPN 网关（路由器）有公网 IP，可在其管理面板配置端口映射
 * 「公网端口 → 宿主 VPN IP:47896」。配好后，手机从任意网络访问
 * `http://<公网IP>:<端口>` 即经网关转发直达宿主——手机零安装（不需要 OpenVPN
 * 客户端、不需要中继），DSH App 直接把这个地址当作服务器地址。
 *
 * 本模块把该入口地址持久化为 <dataPath>/public.json：
 *   { "url": "http://117.36.156.68:1443" }
 * pairing 载荷会把它加入候选（顺序：局域网代理 → 公网入口 → 中继 → 直连）。
 * 本地探测不可达时 App 自动跳过，不影响局域网用户。
 *
 * 同步载入、原子落盘（与 relayconfig/netconf 同模式）。
 */
import { readFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const URL_RE = /^https?:\/\/[^\s/]+\d*[^\s]*$/u

/** 校验公网入口 URL，返回 { ok, error, value } */
export function validatePublicUrl(url) {
  if (url === undefined || url === null || url === '') return { ok: true, value: null }
  if (typeof url !== 'string') return { ok: false, error: '公网入口必须是字符串 URL' }
  const clean = url.trim()
  if (clean.length > 200) return { ok: false, error: '公网入口 URL 过长（≤200）' }
  if (!URL_RE.test(clean)) return { ok: false, error: '公网入口须为 http(s)://主机[:端口] 形式（不要带路径）' }
  return { ok: true, value: clean.replace(/\/+$/u, '') }
}

/**
 * 创建公网入口配置。
 * @param {object} opts
 * @param {string} opts.dataPath
 * @param {string} [opts.base] cordis.patch.yml 的 config.publicUrl 默认值
 */
export function createPublicConfig({ dataPath, base } = {}) {
  const file = join(dataPath, 'public.json')
  let stored = null

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.url !== undefined) {
        stored = validatePublicUrl(parsed.url).value
      } else {
        stored = null
      }
    } catch {
      stored = null
    }
    return stored
  }

  /** 生效值（运行时 > yaml 默认 > null） */
  function effective() {
    if (stored !== null) return stored
    if (base) return validatePublicUrl(base).value
    return null
  }

  /** 写入运行时覆盖（原子替换） */
  async function save(url) {
    const check = validatePublicUrl(url)
    if (!check.ok) return { ok: false, error: check.error, config: effective() }
    const payload = { url: check.value }
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    stored = check.value
    return { ok: true, config: effective() }
  }

  return { load, effective, save, file }
}
