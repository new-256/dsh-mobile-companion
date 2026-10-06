/**
 * relayconfig.mjs — 中继隧道的运行时配置（M2）。
 *
 * 为什么需要它：中继的 url / key / instanceId 若只能写在 cordis.patch.yml 里，
 * 用户每换一次中继都要改配置并重启 DSH。这里把配置落成数据目录下的 relay.json，
 * 桌面「手机」分区改完即时生效（隧道热启停），yaml 里的 config.relay 退化为**初始默认值**。
 *
 * 优先级：relay.json（运行时） > cordis.patch.yml 的 config.relay > 空
 * 落盘位置：<dataPath>/relay.json（与 devices.json 同目录，权限一致）
 *
 * 安全：key 属于特权凭证（持 key 即可把宿主接进中继）。本模块只落盘、不外传；
 * 所有对外状态一律经 redact() 输出，绝不回显 key 本体。
 */
import { readFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/** 中继地址必须是 WS 系（隧道是出站 WebSocket） */
const URL_RE = /^wss?:\/\/[^\s]+$/u
/** 实例 id 进 URL 路径，限制字符集以杜绝注入 */
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/u

/** 校验一份（已合并的）配置，返回 { ok, error } */
export function validateRelay(rc) {
  if (!rc || rc.enabled !== true) return { ok: true }
  if (!rc.url) return { ok: false, error: '中继地址不能为空' }
  if (!URL_RE.test(rc.url)) return { ok: false, error: '中继地址必须以 ws:// 或 wss:// 开头' }
  if (!rc.instanceId) return { ok: false, error: '实例 ID 不能为空' }
  if (!ID_RE.test(rc.instanceId)) return { ok: false, error: '实例 ID 只能含字母、数字、点、下划线、连字符（≤64）' }
  if (!rc.key) return { ok: false, error: '中继密钥不能为空' }
  return { ok: true }
}

/** 对外状态（永不包含 key 本体） */
export function redact(rc) {
  return {
    enabled: rc?.enabled === true,
    url: rc?.url || null,
    instanceId: rc?.instanceId || null,
    hasKey: !!rc?.key,
  }
}

const ALLOWED = ['enabled', 'url', 'key', 'instanceId']

/**
 * 创建配置读取器。
 * @param {object} opts
 * @param {string} opts.dataPath 数据目录
 * @param {object} [opts.base]   cordis.patch.yml 的 config.relay
 */
export function createRelayConfig({ dataPath, base } = {}) {
  const file = join(dataPath, 'relay.json')
  /** 磁盘上的运行时覆盖（可能为空对象） */
  let stored = {}

  /**
   * 同步载入（文件只有几百字节）。
   * 刻意同步：cordis 的 apply() 是同步函数，内部无法 top-level await；
   * 装配期必须立刻知道中继是否启用，故用同步读，落盘仍走异步原子写。
   */
  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        stored = {}
        for (const k of ALLOWED) if (parsed[k] !== undefined) stored[k] = parsed[k]
      }
    } catch {
      stored = {} // 文件不存在或损坏 → 视作无覆盖
    }
    return stored
  }

  /** 合并后的生效配置 */
  function effective() {
    const merged = {}
    for (const k of ALLOWED) {
      if (stored[k] !== undefined) merged[k] = stored[k]
      else if (base && base[k] !== undefined) merged[k] = base[k]
    }
    merged.enabled = merged.enabled === true
    return merged
  }

  /** 写入运行时覆盖（原子替换），返回 { ok, error, config } */
  async function save(patch = {}) {
    const next = { ...effective() }
    for (const k of ALLOWED) if (patch[k] !== undefined) next[k] = patch[k]
    const check = validateRelay(next)
    if (!check.ok) return { ok: false, error: check.error, config: effective() }
    const payload = {}
    for (const k of ALLOWED) if (next[k] !== undefined) payload[k] = next[k]
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    stored = payload
    return { ok: true, config: effective() }
  }

  /** 关闭中继（保留 url/instanceId，仅关 enabled） */
  async function disable() {
    return save({ enabled: false })
  }

  return { load, effective, save, disable, redact: () => redact(effective()), file }
}
