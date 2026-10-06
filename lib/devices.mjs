/**
 * devices.mjs — 已配对设备注册表 + HMAC 设备认证。
 *
 * 存储：<dsh-home>/mobile-companion/devices.json（原子写：tmp + rename）
 * 结构：{ devices: [{deviceId, name, model, platform, secret, createdAt,
 *                    lastSeenAt, lastRenewAt, enrolledVia}] }
 *
 * 认证协议（App → /mobile/renew、/mobile/unregister）：
 *   请求头  Authorization: DSH-Device <deviceId>:<hmacHex>
 *   签名串  `${deviceId}\n${ts}\n${nonce}\n<action>-v1`
 *   hmac    = HMAC-SHA256(deviceSecretHex, 签名串) 的 hex
 *   约束    ts 与服务器时钟偏差 ≤ 5 分钟；nonce 5 分钟窗口内防重放；
 *           secret 为 64 位 hex（32 字节），enroll 时服务端校验。
 *
 * 这两个路由不经过 Cookie 认证（App 在配对前没有 Cookie），因此自带
 * CORS 放行（无凭证的 HMAC 路由，可安全开放给任意 Origin）。
 */

import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CLOCK_SKEW_MS = 5 * 60 * 1000
const NONCE_WINDOW_MS = 5 * 60 * 1000
const MAX_DEVICES = 20
const SECRET_RE = /^[0-9a-f]{64}$/
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** 解析 Authorization: DSH-Device <id>:<hmac> */
export function parseDeviceAuth(header) {
  if (typeof header !== 'string') return null
  const m = /^DSH-Device\s+([A-Za-z0-9_-]{8,64}):([0-9a-f]{64})$/.exec(header.trim())
  return m ? { deviceId: m[1], hmac: m[2] } : null
}

/** 计算指定动作的期望签名 */
function expectedHmac(secretHex, deviceId, ts, nonce, action) {
  const msg = `${deviceId}\n${ts}\n${nonce}\n${action}-v1`
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(msg, 'utf8').digest('hex')
}

export function createRegistry({ dataDir, log }) {
  const filePath = join(dataDir, 'devices.json')
  const nonces = new Map() // nonce -> expiry（定时惰性清理）
  let cache = null // 内存缓存；写穿到磁盘
  let writing = Promise.resolve()

  const load = async () => {
    if (cache) return cache
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'))
      cache = { devices: Array.isArray(raw.devices) ? raw.devices.filter((d) => d && DEVICE_ID_RE.test(String(d.deviceId))) : [] }
    } catch {
      cache = { devices: [] }
    }
    return cache
  }

  const persist = async (data) => {
    const prev = writing
    writing = (async () => {
      await prev.catch(() => {})
      await mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmp, filePath)
    })()
    return writing
  }

  const pruneNonces = () => {
    const now = Date.now()
    for (const [n, exp] of nonces) if (exp <= now) nonces.delete(n)
  }

  return {
    /** 列表（不含 secret） */
    async list() {
      const { devices } = await load()
      return devices.map(({ secret, ...rest }) => rest)
    },

    /** 注册设备；secret 由客户端生成（64 hex）。幂等：同 deviceId 覆盖更新。 */
    async enroll({ deviceId, name, model, platform, secret }, enrolledVia = 'qr') {
      if (!DEVICE_ID_RE.test(String(deviceId || ''))) throw new Error('deviceId 格式非法')
      if (!SECRET_RE.test(String(secret || ''))) throw new Error('secret 必须是 64 位 hex')
      const { devices } = await load()
      const now = Date.now()
      const existing = devices.find((d) => d.deviceId === deviceId)
      if (existing) {
        Object.assign(existing, {
          name: String(name || existing.name || '未命名设备').slice(0, 64),
          model: String(model || '').slice(0, 120),
          platform: String(platform || '').slice(0, 32),
          secret,
          lastSeenAt: now,
          enrolledVia,
        })
        await persist({ devices })
        return { ...existing, secret: undefined }
      }
      if (devices.length >= MAX_DEVICES) throw new Error(`已达设备上限（${MAX_DEVICES}），请先撤销不再使用的设备`)
      const entry = {
        deviceId,
        name: String(name || '未命名设备').slice(0, 64),
        model: String(model || '').slice(0, 120),
        platform: String(platform || '').slice(0, 32),
        secret,
        createdAt: now,
        lastSeenAt: now,
        lastRenewAt: 0,
        enrolledVia,
      }
      devices.push(entry)
      await persist({ devices })
      return { ...entry, secret: undefined }
    },

    /** 撤销设备（立即失去续期能力；既有 Cookie 最多再活 30 天） */
    async revoke(deviceId) {
      const { devices } = await load()
      const idx = devices.findIndex((d) => d.deviceId === deviceId)
      if (idx < 0) return false
      devices.splice(idx, 1)
      await persist({ devices })
      return true
    },

    get(deviceId) {
      return load().then(({ devices }) => devices.find((d) => d.deviceId === deviceId) || null)
    },

    async touch(deviceId, field = 'lastSeenAt') {
      const { devices } = await load()
      const d = devices.find((x) => x.deviceId === deviceId)
      if (!d) return
      d[field] = Date.now()
      await persist({ devices })
    },

    /**
     * 校验 HMAC 请求。成功返回设备条目（含 secret），失败返回 null。
     * @param {object} params { authHeader, body, action } —— body: {deviceId, ts, nonce}
     */
    async verify({ authHeader, body, action }) {
      pruneNonces()
      const parsed = parseDeviceAuth(authHeader)
      if (!parsed || !body || typeof body !== 'object') return null
      const { deviceId, ts, nonce } = body
      if (deviceId !== parsed.deviceId) return null
      const tsNum = Number(ts)
      if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > CLOCK_SKEW_MS) return null
      if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64) return null
      const nonceKey = `${deviceId}:${nonce}`
      if (nonces.has(nonceKey)) return null
      const device = await this.get(deviceId)
      if (!device) return null
      const expect = expectedHmac(device.secret, deviceId, ts, nonce, action)
      // 常量时间比较（防时序侧信道）
      const a = Buffer.from(expect, 'hex')
      const b = Buffer.from(parsed.hmac, 'hex')
      if (a.length !== b.length || !cryptoTimingSafeEqual(a, b)) return null
      nonces.set(nonceKey, Date.now() + NONCE_WINDOW_MS)
      return device
    },
  }
}

function cryptoTimingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i]
  return out === 0
}

/** 生成设备凭据（供测试与文档示例；App 端应自行生成） */
export function generateDeviceCredentials() {
  return {
    deviceId: randomBytes(16).toString('hex'),
    secret: randomBytes(32).toString('hex'),
  }
}
