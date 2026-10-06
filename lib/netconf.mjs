/**
 * netconf.mjs — 网络接口策略的运行时配置。
 *
 * 解决「用户想手动启用 Tailscale/ZeroTier 等虚拟组网方案」：
 *   默认虚拟接口照旧剔除（防止误导性候选），用户可在桌面「手机」分区或移动端
 *   设置页手动放行 —— 落盘 <dataPath>/netconf.json，保存即生效（下次配对载荷
 *   重新采样时应用），无需重启 DSH。
 *
 * 配置形状（JSON 单键）：
 *   { "virtual": false }         剔除全部虚拟接口（默认）
 *   { "virtual": true }          放行全部虚拟接口（Tailscale/ZeroTier/Radmin/WSL…）
 *   { "virtual": ["Tailscale"] } 只放行名字包含指定模式的虚拟接口
 *
 * 同步载入（cordis apply 同步）、原子落盘（.tmp + rename）。
 */
import { readFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/** 校验一份 virtual 策略，返回 { ok, error, value } */
export function validateVirtual(opt) {
  if (opt === false || opt === undefined || opt === null) return { ok: true, value: false }
  if (opt === true || opt === 'all') return { ok: true, value: true }
  if (Array.isArray(opt)) {
    const clean = opt.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    if (clean.length === 0) return { ok: true, value: false }
    if (clean.some((x) => x.length > 32 || /[\/\\:*?"<>|]/.test(x))) {
      return { ok: false, error: '接口名模式须 ≤32 字符且不含路径分隔符' }
    }
    return { ok: true, value: clean }
  }
  return { ok: false, error: 'virtual 必须是 true / false / 字符串数组' }
}

/**
 * 创建网络策略配置。
 * @param {object} opts
 * @param {string} opts.dataPath
 * @param {object} [opts.base] cordis.patch.yml 的 config（可用 netconf.virtual 作默认）
 */
export function createNetconfConfig({ dataPath, base } = {}) {
  const file = join(dataPath, 'netconf.json')
  /** 磁盘运行时覆盖 */
  let stored = null

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.virtual !== undefined) {
        stored = validateVirtual(parsed.virtual).value
      } else {
        stored = null
      }
    } catch {
      stored = null
    }
    return stored
  }

  /** 生效值（运行时 > yaml 默认 > false） */
  function effective() {
    if (stored !== null) return stored
    const baseVirtual = base?.virtual
    if (baseVirtual !== undefined) return validateVirtual(baseVirtual).value
    return false
  }

  /** 写入运行时覆盖（原子替换） */
  async function save(virtual) {
    const check = validateVirtual(virtual)
    if (!check.ok) return { ok: false, error: check.error, config: effective() }
    const payload = { virtual: check.value }
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    stored = check.value
    return { ok: true, config: effective() }
  }

  return { load, effective, save, file }
}
