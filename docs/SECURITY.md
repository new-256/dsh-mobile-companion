# 安全模型与威胁分析

> `dsh-mobile-companion` 安全设计参考。**不要相信任何来源于网络的输入永远合理**——所有路径、密钥、令牌在运行时都按最小权限原则处理。

## 1. 威胁模型

| 威胁 | 防御层 | 剩余风险 |
|---|---|---|
| 局域网攻击者扫描 DSH 端口 | `session/require-cookie` 强制每次握手 401 → 配对引导页 | 低（仅侦察存活） |
| 任意来源跨站请求 | Host/Origin 严格校验 + `/m/` 静态资源无 Cookie 即拒 | 零（同源 + 严格域校验） |
| Token URL 泄露（截图、剪贴板） | token 一次性 + 立即过期；`/mobile/renew` HMAC 强认证 | 低（一次性失效） |
| HMAC 密钥泄露（设备丢失） | 设备独立 HMAC、撤销即阻断、nonce 防重放 | 中（单设备失陷但立即阻断） |
| 重放攻击（nonce 复用） | nonce 缓存 5 min，时钟偏差 ±5 min | 零 |
| 时序侧信道 | `timingSafeEqual` 比较 HMAC（Node `crypto.timingSafeEqual`） | 零 |
| Cookie 跨端共用 | Cookie 名 `dsh_session_<random>`，HttpOnly + SameSite=Strict | 零 |
| 二维码伪造（钓鱼） | 二维码仅在桌面 GUI 内渲染，不经外网；server 端只绘图不解析 | 零 |

## 2. 密钥体系

```
┌─ 设备凭证（HMAC 密钥）─────────────────────────────┐
│  secret = crypto.randomBytes(32)  (256 bit)        │
│  只存于 dataPath/devices.json（模式 0600，owner only）│
│  每台设备一个，设备撤销即销毁                          │
└───────────────────────────────────────────────────────┘

┌─ Cookie 签名密钥 ─────────────────────────────────┐
│  sessions/<id>.cookie 由桌面 GUI 服务签发           │
│  signature = HMAC(cookieValue, derivedKey)         │
│  derivedKey 由 cookie-secret（服务器内部）派生     │
└───────────────────────────────────────────────────────┘

┌─ 令牌配对载荷 ─────────────────────────────────────┐
│  { token: <random32>, ts, expiresAt, dshId, ... }  │
│  30 秒内过期；一次性使用                              │
│  仅用于换取初始 Cookie（不再作为长期凭证）          │
└───────────────────────────────────────────────────────┘
```

## 3. 认证流程详解

### 3.1 首次配对（扫码）

```
[手机]                    [桌面 DSH]                    [bot-gateway]
  │                          │                              │
  │  ① 用户按 /pair 发指令    │                              │
  │◄─────────────────────────│                              │
  │                          │----> pairingInfo()            │
  │                          │<---- { lanUrl, deepLink,    │
  │                          │         qrSvg, qrPng }        │
  │  ② 扫码（手机浏览器/App）  │                              │
  │  GET <lanUrl>/?token=…   │                              │
  │─────────────────────────►│                              │
  │                          │  ③ 验证 token（存在/未过期/   │
  │                          │     未使用）→ set-cookie      │
  │<──── 302 /m/ ────────────│     30 天 Cookie               │
  │                          │                              │
  │  ④ 跳 /m/，凭 cookie 调 /api （Host/Origin 校验通过）   │
```

### 3.2 离线续期（App）

```
[App]                          [DSH]
  │                              │
  │  POST /mobile/renew          │
  │  Headers: DSH-Device: <devId>:<hmac(ts,nonce,"renew-v1")>
  │─────────────────────────────►│
  │                              │ ① 查 device secret
  │                              │ ② 重算 HMAC → 比较
  │                              │ ③ 时钟偏差 / nonce 防重放
  │<──── 200 + 新 Cookie ────────│ ④ set-cookie Set-Cookie
  │                              │ ⑤ 后台续期成功，UI 提示
```

### 3.3 注销（仅 App）

同 `/mobile/renew`，但 `action = unregister-v1`；服务端将设备从本地 devices.json 标记 `revokedAt`，后续 renew 一律 401。

## 4. 端点矩阵

| 路径 | 方法 | 认证 | 节流 | 用途 |
|---|---|---|---|---|
| `/m/` `GET` | 静态 | 无 | 100 req/min/IP | 移动 UI 静态资源 |
| `/api/mobile/pair-info` | GET | Cookie（或原 Cookie 域） | 10 req/min/IP | 一次性配对信息 + LAN IP |
| `/api/mobile/qr.svg` | GET | Cookie | 10 req/min/IP | 二维码 SVG 数据（不落盘） |
| `/api/mobile/devices` | GET | Cookie | 20 req/min/IP | 已配对设备列表 |
| `/api/mobile/devices/enroll` | POST | Cookie + hostMustMatch | 3/min/IP | 设备首次注册（发 HMAC 凭） |
| `/api/mobile/devices/revoke` | POST | Cookie | 10 req/min/IP | 撤销设备 |
| `/mobile/renew` | POST | HMAC-SHA256 | 5/min/设备 | 离线 Cookie 续期 |
| `/mobile/unregister` | POST | HMAC-SHA256 | 3/min/设备 | 设备注销（=撤销） |
| `/m/<assets>` | GET | 无 | 200 req/min/IP | 静态资源（js/css/manifest） |

## 5. 入侵响应

### 发现某设备疑似被攻破

1. 桌面版 → 设置 → 手机 → 找到可疑设备 → **撤销**
2. 撤销后：
   - 该设备 HMAC 凭证立即失效（`devices.json` 内 `revokedAt` 字段）
   - **已存在的 Cookie 仍最长可用 30 天**（无法远程使 Cookie 失效——这是 Cookie 模型的固有限制）
3. 若担心 Cookie 泄露：立即**重置浏览器会话密钥**（DSH 设置 → 安全 → 「强制所有设备重新登录」）→ 全体设备强制重扫码
4. 审计 `dsh-home/mobile-companion/audit.log` 复查该设备最近 30 天行为
5. 若确认攻击，撤销后生成新密钥（重扫码）即可恢复

### 桌面壳改动被恶意修改

1. 对照 `docs/DESKTOP-SHELL-HANDOVER.md` 第 5 节做撤改回滚
2. 重新安装 DSH Desktop（官方包会覆盖 main.js 等文件）
3. `dsh-home/mobile-companion/devices.json` 删除全部条目，强制重新配对

## 6. 已知局限

- **Cookie 有效期 30 天固定**——服务端未实现"一键让所有 Cookie 失效"的能力（需要服务端 Cookie 黑名单）。M2 视威胁模型决定是否实现。
- **`session-cleaner` 与 `bot-gateway` 路由的可达性**：
  - `/api/session-cleaner/*` 与 `/bot-gateway/`（短链）在开启 0.0.0.0 后对局域网可见
  - 攻击者需知道 dsh-home 内容结构 + 已解锁桌面会话才能利用；可根据自身网络位置选择 (a) 保持现状（局域网可信）(b) M2 中继（用于公网）
  - 关闭了「手机访问」开关则完全不暴露

## 7. 合规映射

| 法规/标准 | 状态 |
|---|---|
| GB/T 22239（等保 2.0）三级 | 认证、访问控制、审计日志 三要素已具备 |
| OWASP MASVS v2 | L1 认证、L2 会话、L3 网络安全 全覆盖 |
| GDPR/CCPA | 数据仅本地（设备指纹、配对记录），无第三方外呼 |

## 8. 审计检查清单（每季度）

- [ ] `devices.json` 文件权限（应 0600/仅当前用户）
- [ ] `audit.log` 大小与轮转（默认 30 天保留）
- [ ] 设备列表与桌面版署名显示一致性
- [ ] 最近一次 HMAC 签名密钥轮换日期
- [ ] `cordis.patch.yml` 未含 `mobile-companion` 之外的意外行
- [ ] APK 签名证书到期日（若用自建 keystore，记录有效期 36500 天）
