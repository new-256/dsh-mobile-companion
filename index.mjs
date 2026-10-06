/**
 * dsh-mobile-companion — 主机半入口。
 *
 * 职责：
 *   1. 发布 `mobileCompanion` 服务（pairingInfo()，供 bot-gateway 等本进程插件调用）
 *   2. Cookie 认证的 /api/mobile/* 精确路由（经 connection.fetch，自动套 Host/Origin 栅栏）：
 *      GET  /api/mobile/pair-info    配对信息 JSON（含 QR SVG/PNG 尺寸提示）
 *      GET  /api/mobile/qr.svg       配对二维码 SVG（Cookie 保护，token 不落 URL）
 *      GET  /api/mobile/devices      已配对设备列表
 *      POST /api/mobile/devices/enroll   App 首次配对时注册设备
 *      POST /api/mobile/devices/revoke   撤销设备
 *      GET  /api/mobile/net-check    网络/绑定状态
 *   3. HMAC 设备认证的明文路由（App 续期/注销；自带 CORS 放行，无 Cookie 依赖）：
 *      POST /mobile/renew、POST /mobile/unregister
 *   4. /m/ 前缀：移动端 UI 静态文件（零构建 vanilla ES modules；数据接口全部
 *      走 Cookie 认证，未认证时由前端渲染配对引导页，静态文件本身无敏感信息）
 *
 * 数据目录：<config.dataPath>（cordis.patch.yml 显式指定，junction 镜像下可靠）
 *          缺省 = realpath(ctx.baseDir)/../../mobile-companion（即 dsh-home 下）
 */

import { readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))
const VERSION = '0.3.0'

/**
 * 子模块加载戳。
 *
 * Node 的 ESM 缓存按**完整 URL** 命中，宿主挂载点的 `?v=N` 只能刷新入口 index.mjs，
 * 静态 `import './lib/x.mjs'` 仍会返回上一次装载的旧模块——热重载时表现为
 * 「入口是新的、lib 是旧的」这种极难排查的错配。
 * 因此这里用带戳的动态导入，改动 lib/ 后只需递增此常量即可整体刷新。
 */
const LIB_TAG = `${VERSION}.8`
const { createRegistry } = await import(`./lib/devices.mjs?t=${LIB_TAG}`)
const { buildPairingInfo, diagnoseInterfaces } = await import(`./lib/pairing.mjs?t=${LIB_TAG}`)
const { createForwarder } = await import(`./lib/forward.mjs?t=${LIB_TAG}`)
const { createTunnel } = await import(`./lib/tunnel.mjs?t=${LIB_TAG}`)
const { createRelayConfig, redact: redactRelay } = await import(`./lib/relayconfig.mjs?t=${LIB_TAG}`)
const { createPushRegistry, validateDnd } = await import(`./lib/push.mjs?t=${LIB_TAG}`)
const { createNetconfConfig, validateVirtual } = await import(`./lib/netconf.mjs?t=${LIB_TAG}`)
const { createOvnManager, looksLikeOvpnConfig } = await import(`./lib/ovpn.mjs?t=${LIB_TAG}`)
const { createPublicConfig, validatePublicUrl } = await import(`./lib/publicconf.mjs?t=${LIB_TAG}`)
const { diagnoseInbound, classifyAddress } = await import(`./lib/natdiag.mjs?t=${LIB_TAG}`)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/** 读请求 JSON body（容量上限 64KB） */
async function readJson(request, limit = 65536) {
  const text = await request.text()
  if (text.length > limit) throw new Error('请求体过大')
  return JSON.parse(text)
}

/**
 * 由中继 WS 地址推出手机侧访问地址：ws→http、wss→https，路径为 /i/<instanceId>。
 * 手机/浏览器打开该地址即进入本实例的移动界面（中继按 instance 转发到宿主隧道）。
 */
function relayAccessUrl(rc) {
  try {
    const u = new URL(rc.url)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = `/i/${rc.instanceId}`
    u.search = ''
    u.hash = ''
    return u.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

export function apply(ctx, config) {
  const log = ctx.logger('mobile-companion')
  const dataDir = config?.dataPath
    ? resolve(String(config.dataPath))
    : resolve(realpathSafe(PLUGIN_DIR), '..', '..', 'mobile-companion')

  const registry = createRegistry({ dataDir, log })
  const pushRegistry = createPushRegistry({ dataPath: dataDir, log })
  pushRegistry.load()
  /** 网络接口策略（虚拟组网手动放行）：netconf.json > config.netconf.virtual > false */
  const netconf = createNetconfConfig({ dataPath: dataDir, base: config?.netconf?.virtual !== undefined ? { virtual: config.netconf.virtual } : undefined })
  netconf.load()
  /** OpenVPN 通道（自建 VPN 组网，宿主侧连接管理） */
  const ovpn = createOvnManager({ dataPath: dataDir, log })
  /** 公网入口（网关端口映射 → 宿主代理端口）：public.json > config.publicUrl > null */
  const publicConf = createPublicConfig({ dataPath: dataDir, base: config?.publicUrl })
  publicConf.load()
  const mobileDir = join(PLUGIN_DIR, 'mobile')

  // ── 0. LAN 透明代理（方案 B） ──────────────────────────────────────────────
  /** @type {{port:number, close:function}|null} */
  let forwarder = null
  /** @type {Promise<{port:number, close:function}>|null} */
  let forwarderReady = null
  let forwarderDisposed = false

  function startForwarder() {
    if (config?.proxy === false) return
    const targetPort = ctx.webServer?.port
    if (!targetPort) {
      log.warn('webServer.port 未知，LAN 代理未启动')
      return
    }
    forwarderReady = createForwarder({
      // '::' 双栈监听：IPv4 与 IPv6 入站都收（中国宽带 IPv4 多为 CGNAT，IPv6 才是公网可达）
      listenHost: '::',
      listenPort: Number(config?.proxyPort) || 47896,
      targetHost: '127.0.0.1',
      targetPort,
      log,
    }).then((f) => {
      if (forwarderDisposed) {
        f?.close()
        forwarder = null
        return null
      }
      forwarder = f
      log.info(`LAN 代理已启动: 0.0.0.0:${f.port} → 127.0.0.1:${targetPort}`)
      return f
    }).catch((e) => {
      if (!forwarderDisposed) {
        log.warn(`LAN 代理启动失败，插件降级运行: ${e?.message || e}`)
      }
      forwarder = null
      return null
    })
  }

  startForwarder()

  ctx.effect(() => () => {
    forwarderDisposed = true
    if (forwarder) {
      forwarder.close()
      forwarder = null
    }
  }, 'mobile-companion: forwarder close')

  async function proxyInfo() {
    if (forwarderReady) {
      const f = await forwarderReady
      return { enabled: !!f, port: f?.port || null }
    }
    return { enabled: false, port: null }
  }

  // ── 0b. 中继隧道（方案二，M2）────────────────────────────────────────────
  /** @type {{close:function, status:function}|null} */
  let tunnel = null
  let tunnelDisposed = false

  /** 运行时中继配置（relay.json 覆盖 yaml 默认值；改完可热启停，无需重启 DSH） */
  const relayConfig = createRelayConfig({ dataPath: dataDir, base: config?.relay })
  relayConfig.load()

  function relayConfigReady() {
    const rc = relayConfig.effective()
    return rc.enabled === true && !!rc.url && !!rc.key && !!rc.instanceId
  }

  function stopTunnel() {
    if (tunnel) {
      try { tunnel.close() } catch { /* ignore */ }
      tunnel = null
    }
  }

  function startTunnel() {
    if (!relayConfigReady()) {
      stopTunnel()
      return
    }
    const rc = relayConfig.effective()
    const targetPort = ctx.webServer?.port
    if (!targetPort) {
      log.warn('webServer.port 未知，中继隧道未启动')
      return
    }
    stopTunnel()
    tunnel = createTunnel({
      relayUrl: rc.url,
      key: rc.key,
      instanceId: rc.instanceId,
      targetHost: '127.0.0.1',
      targetPort,
      log,
    })
    log.info(`中继隧道已配置: instanceId=${rc.instanceId}, relay=${rc.url}`)
  }

  /** 重载运行时配置并热启停隧道（桌面 UI 保存后调用） */
  async function applyRelay() {
    relayConfig.load()
    startTunnel()
    return tunnelInfo()
  }

  startTunnel()

  ctx.effect(() => () => {
    tunnelDisposed = true
    stopTunnel()
    ovpn.dispose()
  }, 'mobile-companion: tunnel close')

  function tunnelInfo() {
    const rc = relayConfig.effective()
    if (!relayConfigReady()) {
      return { enabled: false, state: rc.enabled ? 'incomplete' : 'disabled', instanceId: rc.instanceId || null, relayUrl: rc.url || null, hasKey: !!rc.key }
    }
    const st = tunnel?.status() || { state: 'idle' }
    return {
      enabled: true,
      state: st.state || 'idle',
      instanceId: rc.instanceId,
      relayUrl: rc.url,
      hasKey: true,
      accessUrl: relayAccessUrl(rc),
      streams: st.streams,
      bytes: st.bytes,
    }
  }

  /**
   * 统一的配对信息构造入口 —— 代理端口在此一次性注入。
   * 所有产出配对载荷的路由（pair-info / qr.svg / renew / mobileCompanion 服务）
   * 必须走这里：曾因 qr.svg 单独调用 buildPairingInfo 漏传 proxyPort，
   * 导致二维码里编的是 127.0.0.1 环回载荷、手机扫码后必然连不上。
   */
  async function pairingWithProxy() {
    const proxy = await proxyInfo()
    const tunnel = tunnelInfo()
    const info = buildPairingInfo(ctx, {
      lanIps: config?.lanIps,
      proxyPort: proxy.port,
      relay: tunnel,
      virtual: netconf.effective(),
      extraLanIps: ovpn.virtualIps(),
      publicUrl: publicConf.effective(),
    })
    return { proxy, tunnel, info, ovpn: ovpn.status() }
  }

  log.info(`dsh-mobile-companion v${VERSION} 挂载（数据目录 ${dataDir}）`)

  // ── 1. mobileCompanion 服务（本进程内其他插件经 ctx.get('mobileCompanion') 消费）──
  ctx.provide('mobileCompanion', {
    version: VERSION,
    /** 配对信息（每次调用铸造新鲜 token URL；QR/PNG 即时生成） */
    pairingInfo: async () => {
      const { proxy, tunnel, info } = await pairingWithProxy()
      return {
        name: info.name,
        port: info.port,
        lanUrl: info.lanUrl,
        payload: info.payload,
        payloadJson: info.payloadJson,
        deepLink: info.deepLink,
        qrSvg: info.qrSvg,
        qrPng: info.qrPng,
        reachable: info.reachable,
        proxy,
        tunnel,
      }
    },
  })

  // ── 2. Cookie 认证的 /api/mobile/* 路由 ──────────────────────────────────────
  // connection.fetch 的精确路由由 /api 共享通道统一执行 requestRejection（栅栏 + Cookie）
  const fetch = ctx.connection.fetch

  ctx.effect(() => fetch.register({
    path: '/api/mobile/pair-info',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const { proxy, tunnel, info } = await pairingWithProxy()
        return json({
          ok: true,
          name: info.name,
          port: info.port,
          bindHost: info.bindHost,
          reachable: info.reachable,
          urls: info.urls,
          lanUrl: info.lanUrl,
          lanIps: info.lanIps,
          payload: info.payload,
          deepLink: info.deepLink,
          version: VERSION,
          proxy,
          tunnel,
        })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500)
      }
    },
  }), 'mobile-companion: pair-info route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/qr.svg',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      // 关键：必须带 proxyPort，否则二维码编的是环回载荷（历史事故）
      const { info } = await pairingWithProxy()
      return new Response(info.qrSvg, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }), 'mobile-companion: qr.svg route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/devices',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, devices: await registry.list() }),
  }), 'mobile-companion: devices route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/devices/enroll',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJson(request)
        const device = await registry.enroll(body, 'qr')
        log.info(`设备已配对：${device.deviceId}（${device.name}）`)
        return json({ ok: true, device })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: enroll route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/devices/revoke',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const { deviceId } = await readJson(request)
        if (typeof deviceId !== 'string' || !deviceId) throw new Error('缺少 deviceId')
        const removed = await registry.revoke(deviceId)
        if (removed) log.info(`设备已撤销：${deviceId}`)
        // 无条件联动清推送（幂等）：即使设备已不存在（重复撤销）也确保令牌清除
        await pushRegistry.unregister(deviceId)
        return json({ ok: true, removed })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: revoke route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/net-check',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const { proxy, info } = await pairingWithProxy()
      const interfaces = diagnoseInterfaces(null, { virtual: netconf.effective() })

      // 代理/虚拟网卡冲突告警：被选中的首个 LAN IP 若来自虚拟接口则提示
      const chosen = info.lanIps[0]
      const chosenIface = interfaces.find(i => i.address === chosen)
      const warnings = []
      if (chosenIface?.virtual) {
        warnings.push(`首选地址 ${chosen} 来自虚拟接口「${chosenIface.name}」，手机可能无法访问；建议在 config.lanIps 中显式指定真实局域网地址。`)
      }
      const skipped = interfaces.filter(i => i.annoying || i.virtual)
      if (skipped.length) {
        warnings.push(`已跳过 ${skipped.length} 个虚拟/无效接口：${skipped.map(i => `${i.name}(${i.address})`).join('、')}`)
      }
      const fakeIp = interfaces.find(i => /^(198\.1[89]|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(i.address))
      if (fakeIp) {
        warnings.push(`检测到代理软件 TUN 假 IP 段（${fakeIp.address} @ ${fakeIp.name}）。若手机连不上，请在代理软件中把本机端口 ${info.port} 加入直连/绕过规则。`)
      }

      const tunnel = tunnelInfo()
      return json({
        ok: true,
        bindHost: info.bindHost,
        port: info.port,
        reachable: info.reachable,
        lanIps: info.lanIps,
        chosen,
        interfaces,
        warnings,
        hint: info.reachable
          ? '已绑定 0.0.0.0，局域网设备可直接连接。'
          : '当前仅绑定 127.0.0.1，手机无法直连；请开启局域网监听或使用端口转发。',
        version: VERSION,
        proxy,
        tunnel,
      })
    },
  }), 'mobile-companion: net-check route')

  /**
   * GET /api/mobile/inbound-check — 入向可达性自检（双层 NAT 判定）
   *
   * 手机要「异地零安装直连」就必须让外网能连进来。国内宽带常为双层 NAT
   * （光猫拨号 + 路由器二次 NAT）或 CGNAT，此时 DDNS 拒登、端口映射穿不过
   * 上游光猫。本接口主动给出结论，避免用户在路由器上反复试错。
   */
  ctx.effect(() => fetch.register({
    path: '/api/mobile/inbound-check',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (req) => {
      const url = new URL(req.url)
      const wanIp = url.searchParams.get('wanIp') || undefined
      const gateway = url.searchParams.get('gateway') || undefined
      try {
        const result = await diagnoseInbound({ wanIp, gateway })
        // 附带当前已配置的通道状态，便于界面联动提示「已有可用通道」
        return json({
          ok: true,
          ...result,
          publicUrl: publicConf.effective() || null,
          relayEnabled: !!relayConfig.effective()?.url,
          ovpnConnected: ovpn.status()?.state === 'connected',
        })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500)
      }
    },
  }), 'mobile-companion: inbound-check route')

  // ── 2d. 中继配置（M2）：读状态 / 写配置并热启停隧道 ──────────────────────
  ctx.effect(() => fetch.register({
    path: '/api/mobile/relay',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          const rc = relayConfig.effective()
          return json({
            ok: true,
            config: redactRelay(rc),
            status: tunnelInfo(),
            file: relayConfig.file,
          })
        }
        const patch = await readJson(request)
        if (patch === null || typeof patch !== 'object') throw new Error('请求体必须是 JSON 对象')
        // 只接受白名单字段，避免把任意键写进配置文件
        const clean = {}
        for (const k of ['enabled', 'url', 'key', 'instanceId']) {
          if (patch[k] !== undefined) clean[k] = patch[k]
        }
        if (typeof clean.enabled === 'string') clean.enabled = clean.enabled === 'true'
        if (clean.url !== undefined) clean.url = String(clean.url).trim()
        if (clean.instanceId !== undefined) clean.instanceId = String(clean.instanceId).trim()
        if (clean.key !== undefined) clean.key = String(clean.key).trim()
        const res = await relayConfig.save(clean)
        if (!res.ok) return json({ ok: false, error: res.error, config: redactRelay(res.config) }, 400)
        const status = await applyRelay()
        log.info(`中继配置已更新：enabled=${relayConfig.effective().enabled === true} state=${status.state}`)
        return json({ ok: true, config: redactRelay(res.config), status })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: relay route')

  // ── 2e. 推送（M2 脚手架）：注册 / 状态 / 免打扰 ──────────────────────────
  // 投递不在此处：`relay/tools/dsh-push.mjs` 读 push.json 直连 FCM（凭据就绪后启用）。
  ctx.effect(() => fetch.register({
    path: '/api/mobile/push/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, ...pushRegistry.status() }),
  }), 'mobile-companion: push status route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/push/register',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJson(request)
        const { deviceId, token, platform } = body || {}
        const res = await pushRegistry.register(deviceId, { token, platform })
        if (!res.ok) return json({ ok: false, error: res.error }, 400)
        return json({ ok: true })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: push register route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/push/dnd',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJson(request)
        const { deviceId, enabled, from, to } = body || {}
        const res = await pushRegistry.setDnd(deviceId, { enabled, from, to })
        if (!res.ok) return json({ ok: false, error: res.error }, 400)
        return json({ ok: true, dnd: res.dnd })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: push dnd route')

  // 解除设备时联动注销推送令牌，避免向已解绑设备发通知
  const revokeRoute = null // eslint-disable-line no-unused-vars

  // ── 2f. 网络接口策略（虚拟组网手动放行）───────────────────────────────────
  ctx.effect(() => fetch.register({
    path: '/api/mobile/netconf',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          const v = netconf.effective()
          return json({
            ok: true,
            virtual: v,
            virtualLabel: v === true ? 'all' : Array.isArray(v) ? v.join(',') : 'off',
            file: netconf.file,
            // 附带当前接口诊断，方便用户确认放行是否生效
            interfaces: diagnoseInterfaces(null, { virtual: v }),
          })
        }
        const body = await readJson(request)
        const res = await netconf.save(body?.virtual)
        if (!res.ok) return json({ ok: false, error: res.error }, 400)
        log.info(`网络接口策略已更新：virtual=${JSON.stringify(res.config)}`)
        return json({ ok: true, virtual: res.config, interfaces: diagnoseInterfaces(null, { virtual: res.config }) })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: netconf route')

  // ── 2g. OpenVPN 通道（自建 VPN 组网，宿主侧连接管理）────────────────────
  ctx.effect(() => fetch.register({
    path: '/api/mobile/ovpn',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, ...ovpn.status() }),
  }), 'mobile-companion: ovpn status route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/ovpn/config',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJson(request)
        const res = await ovpn.saveConfig(String(body?.content || ''))
        if (!res.ok) return json({ ok: false, error: res.error }, 400)
        log.info('OpenVPN 客户端配置已保存')
        return json({ ok: true, ...ovpn.status() })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: ovpn config route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/ovpn/connect',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const res = await ovpn.connect()
      if (!res.ok) return json({ ok: false, error: res.error }, 400)
      return json({ ok: true, ...ovpn.status() })
    },
  }), 'mobile-companion: ovpn connect route')

  ctx.effect(() => fetch.register({
    path: '/api/mobile/ovpn/disconnect',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      ovpn.disconnect()
      return json({ ok: true, ...ovpn.status() })
    },
  }), 'mobile-companion: ovpn disconnect route')

  // ── 2h. 公网入口（网关端口映射 → 宿主）───────────────────────────────────
  ctx.effect(() => fetch.register({
    path: '/api/mobile/public',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          const url = publicConf.effective()
          return json({ ok: true, url, file: publicConf.file })
        }
        const body = await readJson(request)
        const res = await publicConf.save(body?.url)
        if (!res.ok) return json({ ok: false, error: res.error }, 400)
        log.info(`公网入口已更新：${res.config}`)
        return json({ ok: true, url: res.config })
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 400)
      }
    },
  }), 'mobile-companion: public route')

  // ── 3. HMAC 设备认证路由（App 续期/注销；CORS 放行 + 明文 JSON）────────────
  const deviceRoutes = (path, action, onOk) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const cors = {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '600',
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors)
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, cors, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const send = (status, obj) => {
          res.writeHead(status, cors, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(obj))
        }
        try {
          const chunks = []
          let size = 0
          for await (const c of req) {
            size += c.length
            if (size > 65536) throw new Error('请求体过大')
            chunks.push(c)
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const device = await registry.verify({
            authHeader: req.headers.authorization,
            body,
            action,
          })
          if (!device) return send(401, { ok: false, error: '设备认证失败（未配对/签名错误/时钟偏差过大）' })
          const result = await onOk(device)
          return send(200, result)
        } catch (e) {
          return send(400, { ok: false, error: String(e?.message || e) })
        }
      },
    }), `mobile-companion: ${path} route`)
  }

  // 续期：返回新鲜的 token 根 URL（App 用隐藏 iframe 完成一次性交换刷新 Cookie）
  deviceRoutes('/mobile/renew', 'renew', async (device) => {
    const { info } = await pairingWithProxy()
    await registry.touch(device.deviceId, 'lastRenewAt')
    await registry.touch(device.deviceId, 'lastSeenAt')
    return {
      ok: true,
      url: info.lanUrl || info.tokenUrl,
      urls: info.urls,
      lanUrl: info.lanUrl,
      hostName: info.name,
      port: info.port,
      version: VERSION,
      serverTime: Date.now(),
    }
  })

  // 注销：设备自毁（从注册表移除，立即失去续期能力）
  deviceRoutes('/mobile/unregister', 'unregister', async (device) => {
    await registry.revoke(device.deviceId)
    log.info(`设备自注销：${device.deviceId}`)
    return { ok: true }
  })

  // ── 4. /m/ 移动端静态文件 ──────────────────────────────────────────────────
  const serveStatic = async (req, res, relPath) => {
    // 路径穿越防护：规范化后必须仍在 mobileDir 内
    let safe = relPath
    while (safe.startsWith('/')) safe = safe.slice(1)
    const abs = resolve(mobileDir, safe || '.')
    if (abs !== mobileDir && !abs.startsWith(mobileDir + sep)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    // 目录（含根）→ 直接服务 index.html（不做斜杠规范化重定向，避免移动端循环）
    let file = abs
    if (safe === '' || safe.endsWith('/')) file = join(abs, 'index.html')
    try {
      const st = await stat(file)
      if (st.isDirectory()) file = join(file, 'index.html')
      const data = await readFile(file)
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      res.end(data)
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>404</title><p>未找到（/m/）</p>')
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/m',
    handler: (req, res) => {
      res.writeHead(301, { location: '/m/' })
      res.end()
    },
  }), 'mobile-companion: /m redirect')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    // 注意：宿主 match() 按 startsWith(prefix + '/') 匹配，前缀必须不带尾斜杠
    // （带斜杠会导致子路径全部落空 → 空体 404）。/m 与 /m/ 均由此前缀覆盖。
    path: '/m',
    handler: (req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      const rel = pathname.startsWith('/m/') ? pathname.slice(3) : ''
      return serveStatic(req, res, rel)
    },
  }), 'mobile-companion: /m/ static')
}

function realpathSafe(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export const inject = ['webServer', 'connection']
export const name = 'dsh-mobile-companion'
