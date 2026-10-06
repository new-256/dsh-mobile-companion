/**
 * push.mjs — 推送注册表 + 免打扰（M2 推送脚手架）。
 *
 * 数据：<dataPath>/push.json
 *   {
 *     devices: { [deviceId]: { token, platform, ts } },   // FCM 设备令牌（只写不读外传）
 *     dnd:     { [deviceId]: { enabled, from, to } }      // 免打扰窗口（HH:MM 24h）
 *   }
 *
 * 职责边界：
 *   · 本模块只做**注册存储与免打扰判定**，不连接 FCM —— 投递由独立工具
 *     `relay/tools/dsh-push.mjs` 完成（读本文件 + FCM HTTP v1 / legacy）。
 *   · 对外（/api/mobile/push/status 等）一律**不回显 token 本体**，
 *     只给 platform / 最后注册时间 / 是否已注册。
 *   · 同步载入（cordis apply 同步），原子落盘（.tmp + rename）。
 */
import { readFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/u
const PLATFORMS = new Set(['android', 'ios', 'web'])

/** 校验免打扰设置，返回 { ok, error } */
export function validateDnd(dnd) {
  if (!dnd || dnd.enabled !== true) return { ok: true }
  if (dnd.from !== undefined && !TIME_RE.test(dnd.from)) return { ok: false, error: '免打扰开始时间须为 HH:MM（24 小时制）' }
  if (dnd.to !== undefined && !TIME_RE.test(dnd.to)) return { ok: false, error: '免打扰结束时间须为 HH:MM（24 小时制）' }
  if (dnd.from !== undefined && dnd.to !== undefined && dnd.from === dnd.to) {
    return { ok: false, error: '免打扰开始与结束时间不能相同' }
  }
  return { ok: true }
}

/** 解析 "HH:MM" 为当天分钟数 */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 判断某时刻是否落在免打扰窗口（支持跨午夜，如 22:00–06:00） */
export function inDndWindow(dnd, date = new Date()) {
  if (!dnd || dnd.enabled !== true) return false
  if (!dnd.from || !dnd.to) return false
  const now = date.getHours() * 60 + date.getMinutes()
  const from = toMinutes(dnd.from)
  const to = toMinutes(dnd.to)
  if (from < to) return now >= from && now < to
  return now >= from || now < to // 跨午夜
}

/**
 * 创建推送注册表。
 * @param {object} opts
 * @param {string} opts.dataPath
 * @param {object} [opts.log]
 */
export function createPushRegistry({ dataPath, log }) {
  const file = join(dataPath, 'push.json')
  /** @type {{devices:Record<string,{token:string,platform:string,ts:number}>, dnd:Record<string,{enabled:boolean,from?:string,to?:string}>}} */
  let data = { devices: {}, dnd: {} }

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        data = {
          devices: parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
          dnd: parsed.dnd && typeof parsed.dnd === 'object' ? parsed.dnd : {},
        }
      }
    } catch {
      data = { devices: {}, dnd: {} }
    }
    return data
  }

  async function persist() {
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /** 注册/更新设备推送令牌。deviceId 非空且 ≤80；platform 白名单。 */
  async function register(deviceId, { token, platform = 'android' } = {}) {
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 80) {
      return { ok: false, error: 'deviceId 非法' }
    }
    if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
      return { ok: false, error: 'token 非法' }
    }
    if (!PLATFORMS.has(platform)) return { ok: false, error: `platform 须为 ${[...PLATFORMS].join('/')}` }
    data.devices[deviceId] = { token, platform, ts: Date.now() }
    await persist()
    log?.info?.(`推送已注册：${deviceId}（${platform}）`)
    return { ok: true }
  }

  /** 注销设备推送（设备解绑时调用） */
  async function unregister(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) return { ok: false, error: 'deviceId 非法' }
    const removed = delete data.devices[deviceId]
    delete data.dnd[deviceId]
    if (removed) await persist()
    return { ok: true, removed }
  }

  /** 设置免打扰窗口 */
  async function setDnd(deviceId, dnd) {
    if (typeof deviceId !== 'string' || !deviceId) return { ok: false, error: 'deviceId 非法' }
    const check = validateDnd(dnd)
    if (!check.ok) return { ok: false, error: check.error }
    if (!dnd || dnd.enabled !== true) {
      delete data.dnd[deviceId]
      await persist()
      return { ok: true, dnd: null }
    }
    data.dnd[deviceId] = { enabled: true, from: dnd.from, to: dnd.to }
    await persist()
    return { ok: true, dnd: data.dnd[deviceId] }
  }

  /** 对外状态（不回显 token） */
  function status() {
    const devices = Object.entries(data.devices).map(([deviceId, d]) => ({
      deviceId,
      platform: d.platform,
      ts: d.ts,
    }))
    return {
      registered: devices.length,
      devices,
      dnd: { ...data.dnd },
      file,
    }
  }

  /** 发送工具用：取某设备 token；若该设备处于免打扰窗口则返回 null 表示跳过 */
  function tokenFor(deviceId, date = new Date()) {
    const d = data.devices[deviceId]
    if (!d) return null
    if (inDndWindow(data.dnd[deviceId], date)) return null
    return d.token
  }

  return { load, register, unregister, setDnd, status, tokenFor, inDnd: (id, d) => inDndWindow(data.dnd[id], d), file }
}
