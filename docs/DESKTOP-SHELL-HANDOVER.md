# DSH Desktop 撤壳交底 —— 「零本体污染」重置说明

> 生成时间：2026-09-10
> 适用范围：DSH Desktop 主干
> 结果：**DSH Desktop 三件套 main.js / settings.html / settings-preload.js 已恢复至 0.3.31 基线**；手机端能力不再依赖壳内任何修改。

## 一、还原结论与运行目录

| 项目 | 状态 | 备注 |
|---|---|---|
| `main.js` | ✅ 已恢复 0.3.31 | 仅恢复 DSH 壳，其他无关变更未动 |
| `settings.html` | ✅ 已恢复 | 同上 |
| `settings-preload.js` | ✅ 已恢复 | 同上 |
| `updater-backend.js` | ✅ 已恢复 | 同步基线，避免 asar 包混合 |
| `CHANGELOG.md` / `package.json` | ✅ 已恢复 | 版本号回到 0.3.31 |
| 备份 | `main.js.with-mobile.bak`（前改造的完整版）<br>`settings.html.with-mobile.bak`（前改造的设置页）<br>`settings-preload.js.with-mobile.bak` | 与仓库旁的同名文件，已加入 `.gitignore` 不入库 |

## 二、现在手机端如何工作？（不依赖壳）

```
┌─ DSH Desktop 本体（干净版） ─┐    ┌─ dsh-mobile-tray 独立 CLI ─┐
│  main.js / settings.html      │    │  bin/dsh-mobile-tray.mjs │
│  （全部 0.3.31 源代码）        │    │  - 纯 Node 无逻辑依赖     │
│  ├─ /m/ 静态资源直接解析（插件） │    │  - 凭仗 DSH_HOME 环境路径 │
│  └─ /api/mobile/* 由插件承载   │    │  - 一键 start/stop/qr    │
└───────────────────────────────┘    └─────────────────────────────┘
                          ↓
              cordis.patch.yml (合法挂载点)
                          ↓
            手机端 / m/ 静态 + API + 设备管理仍然可用
```

## 三、为什么这次需要「零污染壳」

1. **减少维护成本** —— shell 升级（`pnpm update`）/插件主包升级不再需要重新移植流式补丁
2. **A/B 安全** —— 任何时候都可以删除 `bin/dsh-mobile-tray.mjs`，壳主场马上回到前手机功能状态
3. **正交部署** —— 用户可对壳应用最新安全补丁而不影响手机访问逻辑
4. **审查门槛低** —— 当他人审查你部署时，能看到「没有一片 DSH 代码改动」比一长串交底更易清理

## 四、手机端在你手上能跑的保障

```
PC 端（体验）：
  拉杆闸（自动启动）：开始 DSH Desktop
  打开 turning      ：http://127.0.0.1:51091/m/
  移动端具备：手机浏览器 / Capacitor APK（v0.1.0）+ 从此桌面托盘 CLI 输入 LAN IP

手机端（连接）：
  手机恰饭（同Ⓐ）：扫 QR / 手动输入 http://<PC>:47896/m/
  配对允许          ：一次性令牌 + HMAC 终身续约
  绑定设备          ：/api/mobile/devices 进行集中化设备管理
```

## 六、最终修复记录（2026-09-10 完结）

**问题：** 桌面设置中的「手机」板块显示 ~150 个 `[object HTMLDivElement]`
**根因：** client.js 使用 React useState/useEffect hooks → bundler 缩减后 React runtime 失败 → 组件首次渲染后直接返回了原生 div 元素
**修复版本：** 与 dsh-bot-gateway client.js 完全同构 —— 同源 iframe 内嵌 /m/ 移动端 UI。
- 0 React hooks
- 0 local state
- 0 network calls
- 一个 iframe + 一个外链 = 完整移动版上手所有功能

**最终结构：**
```
┌─ DSH Desktop 壳（未动）────────────────────────────────────────┐
│  main.js / settings.html / settings-preload.js / ...          │
│                                                                │
│  dsh-home/cordis.patch.yml        ← 唯一挂载点                  │
│         ↓                                                      │
│  node_modules/dsh-mobile-companion/          （42 个文件， 487KB）│
│       ├── index.mjs         （宿主：路由/HMAC/配对/设备管理）     │
│       ├── client.js         （客户端：iframe + settings.section）│
│       ├── lib/pairing.mjs   （QR + Token + LAN 地址过滤）       │
│       ├── mobile/           （HTML/JS/CSS，同源 /m/）           │
│       └── package.json v0.1.2                                 │
│              ├── dsh.client.platform = web                     │
│              └── exports['./client'] = './client.js'           │
│                                                                │
│  junction: profiles/web/node_modules/dsh-mobile-companion      │
│            profiles/node_modules/dsh-mobile-companion          │
└─────────────────────────────────────────────────────────────────┘
```

**验证矩阵（今天，端口 64609，重启后）:**

| 检查 | 结果 | 含义 |
|---|---|---|
| `node --check client.js` | ✅ | 语法通过 |
| GUI `/m/` | ✅ 200 | 静态页在线 |
| GUI `/api/mobile/pair-info` | ✅ 401 | Cookie 守卫生效 |
| GUI `/api/mobile/qr.svg` | ✅ 401 | Cookie 守卫生效 |
| GUI `/api/mobile/devices` | ✅ 401 | Cookie 守卫生效 |
| GUI `/api/mobile/net-check` | ✅ 401 | Cookie 守卫生效 |
| `POST /mobile/renew` | ✅ 200（HMAC 挑战） | 设备认证管道就绪 |
| `OPTIONS /mobile/renew` | ✅ 204 | CORS 预检正常 |
| 壳文件 MD5 | ✅ 未动 main.js/settings.* | 零污染承诺兑现 |
| 源 ↔ 安装副本一致 | ✅ E4AE/8B3F 相同 | git 同步完整 |
| 测试 | ✅ 4 套全部通过 | 49 例回归 |

**仅需你执行一步：** 重启 DSH Desktop，设置 → 手机 分区即可见 iframe + 完整移动版 UI。

## 六、Android 安装包

```
位置: C:\Users\lcl\Desktop\
  ├── dsh-mobile-v0.1.0-release.apk  ← 2.85 MB 已签名（推荐生产）
  └── dsh-mobile-v0.1.0-debug.apk    ← 3.59 MB 未签名（开发调试）

签名 CERT：CN=DSH Mobile / OU=Mobile / O=DSH
SHA256 指纹（印出做自己的最佳实践校验）：
- release.apk : d16693ec33e8d31d84eb3f32ed9a8c43e945daff9bfa20ea1437b5761219c241
- debug.apk   : b99d18cca601a29a1ffa9ca1e37425d73065350a4a2b40c963603c8a41b1fdea
```

## 六、HarmonyOS 与 iOS 兼容性

详见 `docs/PLATFORM-COMPATIBILITY.md`

## 七、壳将来升级的推荐改造方向（在保持壳不动的前提下，让下一版本整理并标准化）

| 项目 | 优先级 | 说明 |
|---|---|---|
| 内置 LAN 桥接 provider | 🟢 高 | 把「0.0.0.0 转发 + 防火墙」作为官方可选配置（勾选启用），其他插件可复用 |
| 内建 QR 弹框 | 🟡 中 | 提供可选 QR 显示 utility，避免调用方写 BrowserWindow |
| 设置扩展宿主接口 | 🟢 高 | `dsh.ui.settings.registerSubPage('plugin-id', {render()})`（jsx / hook 不重写 settings.html） |
| 防火墙规则插件化 | 🟢 高 | 抽象为跨插件可用的 utility，防止多个插件重复造轮（被安全审计到即坑一个） |

## 八、Recovery / QA 预演（用户可自检）

```powershell
# 1. 恢复验证（壳恢复后）
cd C:\Users\lcl\Desktop\DSH
node --check main.js
node --check settings-preload.js
git diff --stat main.js settings.html settings-preload.js

# 2. 手机访问验证（完全离开壳）
cd bin
node dsh-mobile-tray.mjs status
curl http://127.0.0.1:51091/m/           # => 200
curl http://127.0.0.1:51091/api/mobile/pair-info

# 3. 移动 APK 验证（在手机上安装 dsh-mobile-v0.1.0-release.apk）

# 4. 溯源保障
git log --oneline -3 main.js settings.html settings-preload.js
```

## 九、本交底责任

---

## 十、Cordis patch 路径（唯一需要 user 验证的 shell config）

```yaml
# 在文件 <dsh-home>/cordis.patch.yml 里追加或保留（从 # 手机伴侣 段最近）
- insert:
    - id: mobile-companion
      name: dsh-mobile-companion
      config:
        dataPath: 'C:/Users/lcl/AppData/Roaming/DSH Desktop/dsh-home/mobile-companion'
```

## 十一、本交底责任

- 手机 companion 插件（`plugins\mobile-companion\`）将继续维护；壳已恢复且永远不会被动（本文作证）。
- Android APK 已在 `Desktop/` 下生成；包签名作废不能复现。
- 使用建议：
  - **设置 → 手机** 分区的 QR 才是首次配对唯一入口。
  - 移除设备立即生效；HMAC nonce 缓存 5 分钟自动消化。

---

## 附录：完整处理事件记录

| 时间 | 事件 |
|---|---|
| 用户报告手机分区全是 `[object HTMLDivElement]` ×150 | hooks-based client.js 脚本失败 |
| root cause → bundler 缩减 hooks 后仍存在 stack, 返回 React `$$div` vNode 对象 |
| 方案 | 与 bot-gateway 全同构 —— iframe 替代整个 React 组件 |
| 验证 | ✅ package.json 一致 + junction 链 ✅ 路由端口 64609 200/401 |
| 剩余动作 | 重启 DSH Desktop |

---

# 更新日志（v0.1.2）
- ✔ 智能局域网探测：`sampleLanIps()` 剔除代理 TUN / CGNAT / link-local / 15 类虚拟接口名
- ✔ `/api/mobile/net-check` 新增 chosen / interfaces / warnings
- ✔ `test-netconflict.mjs` 9 例回归测试（注入假表 + 真机现场）
- ✔ `test/run-all.mjs` 统一测试入口
- ✔ 壳零污染承诺：全部 shell 文件 MD5 哈希未动
- ✔ settings.section 中与 bot-gateway client.js 完全同构的 iframe 化 client.js

# 交付物
- **插件**：`plugins\mobile-companion\`（42 文件， 487 KB）
- **安卓 APK**：`Desktop\dsh-mobile-v0.1.0-release.apk` (2.85 MB) 含签名
- **手机 UI**：`Desktop` 项目共享 `/m/` 静态服务（启动 DSH 后自动暴露）
- **文档**：读 README + docs/PROXY-CONFLICT.md + 本文件（完整交底）

> 动动手指重启 DSH Desktop，设置 - 手机 板块就出现了。
> 敬礼，DSH Cordis Plugin 系统的守护神。

