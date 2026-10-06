DSH 手机端 M1 —— 按用户要求最终交付态
=========================================

✅ DSH 本体已恢复 0.3.31（无手机污染）
✅ 手机能力通过「插件 + 独立 CLI」提供（壳零侵入）

【一、APK 安装包】
位置：C:\Users\lcl\Desktop\
  dsh-mobile-v0.1.0-release.apk（2.85 MB，已签名）—生产分发给 Android
  dsh-mobile-v0.1.0-debug.apk  （3.59 MB，未签名）—开发调试
签名证书：CN=DSH Mobile / OU=Mobile / O=DSH
SHA256:
  release.apk = 425594e6b4520ec65005389b76f5f23d87eaa38f585640b4b03c302b6b759c26
  debug.apk   = 66c4efa7ac1c7434d663b5d21fd6e68115047ccb950024e59ab4f7e0ae7ab60a

【二、插件源码】
位置：C:\Users\lcl\Desktop\DSH\plugins\mobile-companion\
  ├── index.mjs / client.js / package.json
  ├── lib/{qr,devices,pairing}.mjs     (核心加密+配对)
  ├── mobile/                            (手机 UI)
  ├── docs/DESKTOP-SHELL-HANDOVER.md    (本次撤离交底)
  ├── docs/PLATFORM-COMPATIBILITY.md  (鸿蒙/iOS 设计)
  ├── docs/SECURITY.md                (安全模型)
  └── bin/dsh-mobile-tray.mjs           (独立手机托盘,替代壳改造)

【三、移动端安装与启动（用户不需任何命令行）】
  方式1（推荐）：手机浏览器访问 http://<PC_IP>:47896/m/ → 扫码配对成功
  方式2（更稳定）：安装 dsh-mobile-v0.1.0-release.apk → 应用内输入 http://<PC_IP>:47896/m/ → 一键连接
  前端 UI：http://127.0.0.1:51091/m/  （凭后续 DSH 启动时的 LAN IP 自动切换）

【四、桌面 DSH 使用量零污染验证】
  - 备份文件（恢复到 0.3.34 手机态）：
      C:\Users\lcl\Desktop\DSH\main.js.with-mobile.bak
      C:\Users\lcl\Desktop\DSH\settings.html.with-mobile.bak
      C:\Users\lcl\Desktop\DSH\settings-preload.js.with-mobile.bak
  - 撤壳验证插件状态（DSH 关闭时）：
      node bin/dsh-mobile-tray.mjs status

【五、升级后的预期 (DSH 0.3.32+)】
  DSH 主干手机功能收回 re-implementation：
  - 撤走 dsh-mobile-tray，由接入 DSH 官方启动时桥接 menu
  - Phone UI 不依赖 DSH(msg) 设置分区（GUI 不改造）
  - 版本号管理: settings.mobile 配置移上 plugins/dsh-mobile-companion/

【六、HarmonyOS/iOS】
  docs/PLATFORM-COMPATIBILITY.md 给出工程骨架。零污染 DSH 本体，仍是该方案不变的边际。

【七、删除壳遗留代码清单】
  - bin/dsh-mobile-tray.mjs + bin/README-mobile-tray.md             （新增）
  - plugins/mobile-companion/                                      （自用）
  - main.js.with-mobile.bak / settings.html.with-mobile.bak / settings-preload.js.with-mobile.bak （备份）

构建环境一键证明（PowerShell）：
  $env:ANDROID_HOME = "C:\Users\lcl\Android\Sdk"
  $env:ANDROID_SDK_ROOT = "C:\Users\lcl\Android\Sdk"
  $env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
  cd C:\Users\lcl\Desktop\DSH\mobile-app\android
  .\gradlew.bat assembleRelease
