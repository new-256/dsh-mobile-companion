# 手机伴侣常驻诊断信标（可选，仅调试期启用）
# 用法：
#   1. 将本目录下的 dsh-mobile-companion\plugins\mobile-companion-beacon.mjs
#      复制为 dsh-home\plugins\mobile-companion-beacon.mjs
#   2. 在 dsh-home\profiles\web\cordis.patch.yml 开头添加一行：
#        - insert: [mobile-companion-beacon]
#   3. 重启 DSH
#   4. 每次 GUI 加载设置面板时，信标自动访问 /api/mobile/net-check 并打一个 beacon
#   5. 查看 dsh-home\logs\mobile-beacon.jsonl

/**
 * plugins/mobile-companion-beacon.mjs — 最小的诊断信标插件。
 * 声明自身为 dsh.client 平台 = web，但 client 代码极瘦：仅发一个 fetch。
 * 用于判断 client-modules 是否正确解析 mobile-companion 的 client entry。
 * 验证方法：
 *   - 启动 DSH 后 curl http://127.0.0.1:PORT/plugins/mobile-companion-beacon/client.js
 *     能拿到本 client.js 内容 → client-modules 工作；插件列表没条目。
 *   - 若 401 → 你和 GUI 在同源（正常）。若 404 → client-modules 不发，去看 plugin manifest。
 */

window.__DSH_MC_DIAG__ = { started: Date.now() };

function diagnose(label, extra) {
  const stamp = new Date().toISOString();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const msg = [
    "[MC beacon]",
    label,
    "platform=" + (typeof window !== "undefined" && window.__DSH_BOOT__ ? "boot-ok" : "no-boot"),
    "entries=" + (typeof window !== "undefined" && window.__DSH_BOOT__ ? (window.__DSH_BOOT__.entries || []).length : "n/a"),
  ];
  if (extra) msg.push(JSON.stringify(extra));
  console.warn(msg.join(" "));
}

window.__ModuleLoader__.load({
  id: "mobile-companion-beacon",
  factory: () => {
    diagnose("load", { now: Date.now() });
    fetch("/api/mobile/net-check").then((r) => {
      diagnose("net-check", { status: r.status });
    }).catch((e) => {
      diagnose("net-check", { error: String((e && e.message) || e) });
    });
  }
});
