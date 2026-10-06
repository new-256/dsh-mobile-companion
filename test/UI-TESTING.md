# 移动 UI 测试方法（`test/ui-harness.mjs`）

移动端 UI 是零构建的 vanilla ES modules，跑在真实浏览器里。历史事故（`replaceChildren(array)`
导致整页渲染成 `[object HTMLDivElement]` 串）说明**只看代码不足以发现 UI 缺陷**，必须用
真实浏览器过一遍视图。本文件记录可复现的验证方法。

## 一、起测试台

```bash
node test/ui-harness.mjs 47899
# → UI_HARNESS_READY http://127.0.0.1:47899/m/
```

测试台做三件事：

1. 用 mock cordis ctx 挂载插件本体（`proxy: false`，避免占用真实 47896）
2. 实现模拟 DSH 后端：一元 RPC 信封（`session/list`、`pluginInventory/list`、`settings/describe`
   …）、`/api/session-cleaner/*` 回收站、以及 `/api/remote.mux` 的最小 WebSocket
   （对 `workspace/follow` 回 baseline 快照，含 1 个workspace + 2 个会话）
3. 插件自身路由照原样服务（`/m/` 静态、`/api/mobile/pair-info` 等）

## 二、用真实浏览器验证

浏览器打开 `http://127.0.0.1:47899/m/`，逐项检查：

| 视图 | 进入方式 | 期望 |
|---|---|---|
| 会话 | 默认 | 工作区分组标题 + 会话卡片；无 `[object HTML` |
| 插件 | 底部「插件」 | 插件清单（2 条 + 已启用 pill）+ 设置命名空间列表 + 「在完整界面打开」 |
| 插件设置表单 | 点设置卡片 | 弹层标题 = 命名空间名；表单项按 schema 渲染（boolean → 开关、number → 数字框、string → 文本框）+ 保存按钮 |
| 设置 | 底部「设置」 | 外观/语言/连接信息（主机/端口/地址）/配对新设备（二维码 + 复制）/已配对设备/关于 |
| 回收站 | 会话页 🗑️ | 已删除会话卡片 + 恢复/彻底删除按钮 |

判定式（可直接在 DevTools console 粘贴）：

```js
document.body.innerText.includes('[object HTML')  // 必须为 false
```

## 三、已知非缺陷

- `favicon.ico` 404：测试台不提供图标，忽略。
- 切换 tab 后**立刻**读取内容可能拿到上一帧（会话流 `workspace/follow` 刷新与路由渲染竞争）；
  等待 ≥1s 再断言。这不是产品 bug。

## 四、与自动化测试的分工

- `test-acceptance.mjs`：配对闭环 / 终身续约 / 多实例隔离 / 断开生效（协议层，无需浏览器）
- `test-forward.mjs` + `test-relay.mjs` + `test-tunnel.mjs`：转发器、中继、隧道（字节层）
- **本方法**：渲染层（必须真实浏览器）
