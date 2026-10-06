/**
 * ovpn.mjs — OpenVPN 通道集成（中国大内网组网方案的又一条路径）。
 *
 * 场景：用户有自建 OpenVPN 服务器（如国内 VPS），手机与宿主都连入同一 VPN 网段，
 * 手机就能像局域网一样直连宿主。本模块管理**宿主侧**的 OpenVPN 连接：
 *   1. 检测已安装的 OpenVPN 二进制（社区版 / OpenVPN Connect）
 *   2. 用用户提供的 client.ovpn 拉起连接（前台 spawn，Windows 版不支持 --daemon）
 *   3. 从日志提取服务器分配的虚拟 IP（如 10.80.12.2），供配对载荷注入候选
 *   4. 断开 = 终止进程
 *
 * 手机侧：用户自行安装 OpenVPN Connect 并导入同一份 client.ovpn（VPN 属系统级
 * 权限，App 不内置 VPN 客户端——与设计决策一致），连上后即可经虚拟 IP 直连宿主。
 *
 * 安全：client.ovpn 内含私钥（证书认证），属凭证——只落盘插件数据目录、不回显内容。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer as createNetServer, connect as netConnect } from 'node:net'

/** 常见 OpenVPN 客户端路径（社区版优先，其次 OpenVPN Connect） */
const BIN_CANDIDATES = [
  'C:/Program Files/OpenVPN/bin/openvpn.exe',
  'C:/Program Files/OpenVPN Connect/openvpn.exe',
  'C:/Program Files/OpenVPN Connect/ovpncli.exe',
  'C:/Program Files (x86)/OpenVPN/bin/openvpn.exe',
  '/usr/bin/openvpn',
  '/usr/local/sbin/openvpn',
]

/** 连接成功标记与虚拟 IP（Windows 日志两种常见写法） */
const INIT_DONE = /Initialization Sequence Completed/u
const IP_DHCP = /DHCP IP\/netmask of ([\d.]+)/u
const IP_SUBNET = /Set TAP-Windows TUN subnet mode network\/local\/netmask = [\d./]+\/([\d.]+)/u

/** 检测 OpenVPN 二进制（固定路径 + PATH） */
export function detectOpenvpn(env = process.env, exists = existsSync) {
  for (const p of BIN_CANDIDATES) {
    if (exists(p)) return p
  }
  const pathDirs = String(env.PATH || '').split(';')
  for (const dir of pathDirs) {
    if (!dir) continue
    const p = join(dir, 'openvpn.exe')
    if (exists(p)) return p
  }
  return null
}

/** 粗略校验一段文本是否像 OpenVPN 客户端配置（防乱传） */
export function looksLikeOvpnConfig(text) {
  if (typeof text !== 'string' || text.length < 64 || text.length > 512 * 1024) return false
  if (!/\bclient\b/u.test(text)) return false
  if (!/remote\s+\S+\s+\d+/u.test(text)) return false
  return true
}

/**
 * 创建 OpenVPN 连接管理器。
 * @param {object} opts
 * @param {string} opts.dataPath  插件数据目录（ovpn/ 子目录存配置与日志）
 * @param {object} [opts.log]     logger
 * @param {Function} [opts.spawnImpl] 注入用（测试）；默认 node:child_process.spawn
 * @param {Function} [opts.bin]   注入用（测试）；默认 detectOpenvpn()
 * @param {number} [opts.timeoutMs] 连接超时（测试注入小值）；默认 30000
 */
export function createOvnManager({ dataPath, log, spawnImpl = spawn, bin = detectOpenvpn(), timeoutMs = 30000 }) {
  const dir = join(dataPath, 'ovpn')
  const configFile = join(dir, 'client.ovpn')
  const logFile = join(dir, 'openvpn.log')

  /** @type {{pid:number|null, ip:string|null, state:'stopped'|'connecting'|'connected'|'error', error?:string}} */
  let st = { pid: null, ip: null, state: 'stopped' }
  let proc = null
  let connectTimer = null
  let mgmtPort = null
  let closed = false

  async function ensureDir() {
    await mkdir(dir, { recursive: true })
  }

  /** 预留一个空闲 TCP 端口给 OpenVPN management 接口（失败返回 null，不阻塞连接） */
  function reserveMgmtPort() {
    return new Promise((resolve) => {
      try {
        const srv = createNetServer()
        srv.once('error', () => resolve(null))
        srv.listen(0, '127.0.0.1', () => {
          const port = srv.address().port
          srv.close(() => resolve(port))
        })
      } catch {
        resolve(null)
      }
    })
  }

  /** 保存客户端配置（原子写）。返回 { ok, error } */
  async function saveConfig(text) {
    if (!looksLikeOvpnConfig(text)) return { ok: false, error: '内容不像 OpenVPN 客户端配置（需含 client 与 remote <主机> <端口>）' }
    await ensureDir()
    const tmp = `${configFile}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, configFile)
    return { ok: true }
  }

  function hasConfig() {
    return existsSync(configFile)
  }

  /**
   * 断开连接。
   * 优先走 OpenVPN management 接口发 `signal SIGTERM` 优雅关闭（openvpn 先删路由再退出，
   * 不留死路由）；management 不可用或 5s 内未退出则强杀兜底。
   */
  function disconnect() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
    const p = proc
    const mgmt = mgmtPort
    mgmtPort = null
    if (p && p.pid) {
      if (mgmt) {
        let done = false
        const fallback = setTimeout(() => { if (!done) { try { p.kill() } catch { /* ignore */ } } }, 5000)
        const sock = netConnect({ host: '127.0.0.1', port: mgmt })
        sock.on('connect', () => { try { sock.write('signal SIGTERM\r\n') } catch { /* ignore */ } })
        sock.on('error', () => { if (!done) { try { p.kill() } catch { /* ignore */ } } })
        p.once('exit', () => { done = true; clearTimeout(fallback); try { sock.destroy() } catch { /* ignore */ } })
        setTimeout(() => { try { sock.destroy() } catch { /* ignore */ } }, 1200).unref?.()
      } else {
        try { p.kill() } catch { /* ignore */ }
      }
    }
    if (st.state === 'connecting' || st.state === 'connected') {
      log?.info?.('OpenVPN 已断开')
    }
    st = { pid: null, ip: null, state: 'stopped' }
    proc = null
  }

  /** 建立连接（异步，状态经 status() 轮询）。timeoutMs 内未完成视为失败。 */
  async function connect() {
    if (!bin) return { ok: false, error: '未检测到 OpenVPN 客户端（请安装社区版或 OpenVPN Connect）' }
    if (!hasConfig()) return { ok: false, error: '缺少 client.ovpn 配置（先在卡片上传）' }
    if (st.state === 'connecting' || st.state === 'connected') return { ok: false, error: '已在连接中' }

    disconnect()
    st = { pid: null, ip: null, state: 'connecting' }
    void ensureDir()

    const mgmt = await reserveMgmtPort()
    mgmtPort = mgmt
    const args = ['--config', configFile, '--auth-nocache', '--log', logFile, '--verb', '3']
    if (mgmt) args.push('--management', '127.0.0.1', String(mgmt))
    log?.info?.(`OpenVPN 启动：${bin} ${args.slice(0, 2).join(' ')} …`)
    try {
      proc = spawnImpl(bin, args, { windowsHide: true })
    } catch (e) {
      st = { pid: null, ip: null, state: 'error', error: String(e?.message || e) }
      return { ok: false, error: st.error }
    }
    st.pid = proc.pid || null

    proc.on('error', (e) => {
      if (closed) return
      st = { pid: null, ip: null, state: 'error', error: `openvpn 启动失败：${e.message}` }
      proc = null
    })
    proc.on('exit', (code) => {
      if (closed) return
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
      // 若从未连上或异常退出 → error；主动断开时 disconnect() 已置 stopped
      if (st.state === 'connecting') st = { pid: null, ip: null, state: 'error', error: `openvpn 退出（code=${code}），详见 ${logFile}` }
      else if (st.state === 'connected') st = { pid: null, ip: null, state: 'stopped' }
      proc = null
    })

    // 超时保护
    connectTimer = setTimeout(() => {
      if (st.state === 'connecting') {
        log?.warn?.('OpenVPN 超时未完成握手，判定失败')
        disconnect()
        st = { pid: null, ip: null, state: 'error', error: '连接超时，详见 ' + logFile }
      }
    }, timeoutMs)

    return { ok: true }
  }

  /**
   * 从 openvpn.log 增量解析状态：找 Initialization Sequence Completed 与分配 IP。
   * 每 800ms 轮询；日志尚在写时捕获读错误即跳过。
   */
  function pollLog() {
    if (st.state !== 'connecting' || !proc) return
    let text = ''
    try { text = readFileSync(logFile, 'utf8') } catch { return }
    const mIp = text.match(IP_DHCP) || text.match(IP_SUBNET)
    if (mIp) st.ip = mIp[1]
    if (INIT_DONE.test(text)) {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
      log?.info?.(`OpenVPN 已连接${st.ip ? `，虚拟 IP ${st.ip}` : ''}`)
      st.state = 'connected'
    }
  }
  const pollTimer = setInterval(pollLog, 800)
  pollTimer.unref?.()

  /** 状态（安全：不含配置内容） */
  function status() {
    return {
      state: st.state,
      ip: st.ip,
      pid: st.pid,
      bin: bin ? String(bin) : null,
      hasConfig: hasConfig(),
      configFile,
      logFile,
      error: st.error || null,
    }
  }

  /** 若已连接，返回虚拟 IP 列表（配对候选注入用） */
  function virtualIps() {
    return st.state === 'connected' && st.ip ? [st.ip] : []
  }

  /** 销毁（插件 dispose 时调用） */
  function dispose() {
    closed = true
    if (pollTimer) clearInterval(pollTimer)
    disconnect()
  }

  return { connect, disconnect, saveConfig, hasConfig, status, virtualIps, dispose, configFile, logFile }
}
