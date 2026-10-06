# 移动端平台兼容性方案（Android · HarmonyOS · iOS）

> 本文档面向跨平台复用：`dsh-mobile-companion`（插件）+ `mobile-app/`（Capacitor 壳）如何以最小改动支持 **Android（已交付）、HarmonyOS NEXT、iOS** 三大平台。

## 一、现状总览

| 平台 | 状态 | 技术选型 |
|---|---|---|
| Android | ✅ 已交付签名 APK | Capacitor 6 + Android WebView + native HTTP 拦截（CapacitorHttp） |
| HarmonyOS NEXT | 🟡 方案就绪，未构建 | **ArkWeb**（系统级 Chromium）+ Native Bridge，走纯 web 栈 |
| iOS | 🟡 方案就绪，未构建 | **WKWebView** + Capacitor iOS 运行时（`@capacitor/ios`） |

**关键架构决策**：业务逻辑全部在 `mobile-app/www/`（纯 HTML+JS，与 `/m/` 同源代码），平台壳只负责 (a) WebView 容器 (b) 权限声明 (c) 扫码组件。因此 90% 代码跨平台共享。

## 二、HarmonyOS NEXT 扩展方案

### 2.1 可行性
- **ArkUI + ArkWeb** 是 HarmonyOS NEXT 的系统级浏览器组件，Chromium 内核对 ES2022+ 完全兼容，本地 `.js/.mjs/.html/.css` 加载无需转译。
- **纯 Web 应用 + Native Bridge** 模式与 HarmonyOS 官方「混合开发」最佳实践一致。
- 障碍：OpenHarmony API 与 Android API 不同；需要 HarmonyOS NEXT 开发者账号 + DevEco Studio。

### 2.2 工程脚手架

```
harmony-app/
├── entry/src/main/ets/
│   ├── MainAbility/
│   │   ├── pages/
│   │   │   └── Index.ets        <-- ArkWeb 容器，加载本地 www/index.html
│   │   └── MainAbility.ets
│   └── resources/base/media/    <-- 图标
├── www/                          <-- 软链接/拷贝 mobile-app/www 全部内容
└── hvigorfile.ts
```

**Index.ets 核心模板**（可直接使用）：
```ets
import web_webview from '@ohos.web.webview';

@Entry
@Component
struct Index {
  private controller: web_webview.WebviewController = new web_webview.WebviewController();

  aboutToAppear() {
    // 允许 file:// 协议加载本地 www
    web_webview.WebviewController.setWebDebuggingAccess(true);
  }

  build() {
    Column() {
      Web({
        src: $rawfile('www/index.html'),   // 本地资源，不走网络
        controller: this.controller
      })
      .fileAccess(true)
      .javaScriptAccess(true)
      .domStorageAccess(true)               // localStorage（必需，保存设备凭证）
      .onlineImageAccess(true)
      .mediaPlayGestureAccess(false)
      .mixedMode(MixedMode.All)             // QR 内嵌 SVG 兼容
    }
    .width('100%').height('100%')
  }
}
```

### 2.3 关键兼容点
| 问题 | 解法 |
|---|---|
| `fetch` 到 HTTP 局域网被拦截 | `AppScope/app.json5` 中 `network.cleartextTraffic: true`；或推荐走 HTTPS 自签名证书（域名校验放行） |
| `crypto.subtle` 在 WebView 沙箱 | ArkWeb 内核 ≥ 92 稳定支持；若异常降级到 pure-js-hmac（`app.js` 已内置） |
| 扫码 | `scanCore` 从 `@kit.ScanKit`，比 Android zxing 更稳定 |
| Cookie 持有 | ArkWeb Cookie 管理器与系统同步，`domStorageAccess(true)` 即可 |
| HMAC 离线续期 | 移到原生侧用 `@kit.CryptoFramework` 实现，前端只调 RPC |

### 2.4 验证路径
1. DevEco Studio 新建 Empty Ability，粘贴上面 Index.ets。
2. `mobile-app/www/*` 拷贝到 `entry/src/main/resources/rawfile/www/`。
3. 连真机或模拟器（P60/P70，API 12+），运行后应见到配对二维码界面。

**成本估算**：本机 Android 工程已可复用 90%，鸿蒙适配工作量 ≈ 1-2 人日（主要是签名/打包流程）。

## 三、iOS 扩展方案

### 3.1 可行性
- Capacitor 原生支持 iOS（`@capacitor/ios`），同一份 `www/` 代码零修改运行。
- 限制：iOS App Store 审核要求 WKWebView 只能用系统浏览器打开外部链接，不允许"远程加载未签名的 web UI"——但我们这里是**纯本地资源**，通过。

### 3.2 工程脚手架

```bash
cd mobile-app
npm install @capacitor/ios@^6 --save-exact
npx cap add ios        # 需要 macOS + Xcode
npx cap sync ios
npx cap open ios
```

### 3.3 关键兼容点

| 问题 | 解法 |
|---|---|
| `http://` 局域网请求被 ATS 拦截 | `Info.plist` 加 `NSAppTransportSecurity > NSAllowsArbitraryLoadsInLocalNetworking = YES`（自 6.0 Capacitor 默认允许 local networking；只需确认 `CapacitorHttp` 的 `enabled: true` 在 ios 段也设了，配置会同步） |
| 扫码 | Capacitor 官方 `@capacitor-mlkit/barcode-scanning`，或简化为手动输入 URL |
| Cookie 30 天持久 | WKHTTPCookieStore 默认持久化到 app sandbox，不需额外配置 |
| 推送（M2 计划） | APNs + 后端 webhook |

### 3.4 验证路径
Mac 开发者：
```bash
npx cap add ios
npx cap sync ios
npx cap open ios    # Xcode
# Simulator iPhone 15 Pro → 配对二维码 → 完成 MDM 流
```

## 四、通用跨端架构原则

```
┌──────────────────────────────────────────────────────┐
│  mobile-app/www/  (纯 HTML/JS, 同 /m/ 同源代码)        │
│    ├── index.html + app.css + app.js                  │
│    ├── settings.js / plugins.js / chat.js             │
│    └── api.js  (Mux + rpc envelope)                   │
└──────────────────────────────────────────────────────┘
                        ↓
    ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
    │  Android (✔)     │     │  HarmonyOS NEXT  │     │  iOS (WKWebView) │
    │  Capacitor 6     │     │  ArkWeb          │     │  Capacitor 6     │
    │  WebView+HTTP    │     │  Index.ets       │     │  WKWebView       │
    │  intercept       │     │  + scanCore      │     │  + MLKit scan    │
    └──────────────────┘     └──────────────────┘     └──────────────────┘
                        ↓
            LAN HTTP(s) → DSH Backend (0.0.0.0:47896)
```

**共享契约**（三个平台行为一致）：
- `DSH-Device <deviceId>:<hexHmac>` 头签名 renew/unregister（消息 = `deviceId\nts\nnonce\nrenew-v1` / `unregister-v1`）。
- `enroll` 载荷 = `{deviceName, platform}`，返回 `{deviceId, deviceSecret, serverInfo, expiresAt}`。
- `pairingInfo()` 载荷 = `{lanUrl, deepLink, qrSvg, qrPng}`。
- Cookie 策略 = host-only, Path=/, HttpOnly, SameSite=Strict, 30 天（服务器 Expires 字段可选剥离）。

## 五、本机 Android APK 一键重出

```powershell
$env:ANDROID_HOME = "C:\Users\lcl\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
cd C:\Users\lcl\Desktop\DSH\mobile-app\android
.\gradlew.bat assembleRelease
# → app\build\outputs\apk\release\app-release.apk（已签名，可分发）
```

## 六、测试矩阵

| 场景 | Android | HarmonyOS | iOS |
|---|---|---|---|
| 扫码配对 | ✅ | 🟡 | 🟡 |
| HMAC 离线续期 | ✅ | 🟡 | 🟡 |
| 多实例切换 | ✅ | 🟡 | 🟡 |
| Cookie 30 天 | ✅ | 🟡 | 🟡 |
| 附件上传（M2） | — | — | — |
| APNs/FCM 推送（M2） | 待 M2 | HMS Push Kit | 待 M2 |

✅ 已要求，🟡 已规划未实施，— 待 M2。
