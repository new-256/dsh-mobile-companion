/**
 * @file client.js
 * @description dsh-mobile-companion 的浏览器半边：DSH GUI「设置 → 手机」分区。
 *
 * 与 bot-gateway client.js 同构策略：分区内容用同源 iframe 内嵌 /m/（已验证
 * 路径）。零构建 React 版曾因 hooks 使用不当被 shell 静默摘除，改为 iframe 后
 * 移动端完整功能（聊天/插件/设置/回收站）在 GUI 中原样可用。
 *
 * 加载机制：宿主侧 client-modules 扫描到 package.json 的 dsh.client 声明后，
 * 经 /mobile-companion/client.js 以经典脚本分发本文件；window.__ModuleLoader__.load
 * 注册 CJS 工厂。react 与 slots 服务来自 shell 静态种子表，无需 dsh.client.inject。
 *
 * 词典：中英双语（zh/en），经 locale 服务注册；设置外壳导航文案全部由注册方
 * 提供（shell 零拷贝原则）。
 */
window.__ModuleLoader__.load({
	id: "dsh-mobile-companion",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const el = react.createElement;

		/** 词典命名空间（与插件 id 一致） */
		const NS = "mobile-companion";
		const zh = {
			"section.nav": "手机",
		};
		const en = {
			"section.nav": "Mobile",
		};

		/**
		 * 配对信息头部：直接内嵌配对二维码 + 地址（同源 Cookie 认证，免进 iframe 翻 tab）。
		 * 每次渲染重新拉取（token 一次性，即扫即用）。
		 */
		function PairHeader() {
			const [info, setInfo] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				fetch("/api/mobile/pair-info", { credentials: "include" })
					.then((r) => (r.ok ? r.json() : null))
					.then((d) => { if (alive && d && d.ok !== false) setInfo(d); })
					.catch(() => {});
				return () => { alive = false; };
			}, []);
			if (!info) return null;
			const urls = (info.urls || []).filter((u) => !u.includes("127.0.0.1"));
			const qrSrc = "/api/mobile/qr.svg?" + Date.now();
			return el("div", {
				style: {
					display: "flex", flexDirection: "column", alignItems: "center", flex: "none",
					padding: "16px 12px", border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "10px", textAlign: "center", gap: "6px",
				},
			},
				el("div", { style: { fontWeight: 600, fontSize: "15px" } }, "用 DSH 手机版 App 扫码配对"),
				el("a", {
					href: qrSrc, target: "_blank", rel: "noopener", title: "点击放大 / 新窗口打开",
					style: { lineHeight: 0, margin: "4px 0" },
				},
					el("img", {
						src: qrSrc,
						alt: "配对二维码",
						// SVG 矢量放大不糊；240px 为扫码舒适尺寸，点击可新窗口看更大
						style: { width: "240px", height: "240px", background: "#fff", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)", cursor: "zoom-in" },
					}),
				),
				el("div", { style: { fontSize: "12px", opacity: 0.6 } }, "点击二维码可放大 / 新窗口打开"),
				el("div", { style: { fontSize: "12px", opacity: 0.75, wordBreak: "break-all" } },
					"手机与电脑同一网络，浏览器打开：" + (urls[0] ? urls[0] + "/m/" : "（仅本机可达）")),
				urls.length > 1 && el("div", { style: { fontSize: "12px", opacity: 0.55, wordBreak: "break-all" } }, "候选：" + urls.join(" · ")),
				info.proxy && info.proxy.enabled && el("div", { style: { fontSize: "12px", opacity: 0.55 } }, "局域网代理端口：" + info.proxy.port),
			);
		}

		/**
		 * 公网入口卡片（网关端口映射 → 宿主）。
		 * 在 OpenVPN 网关（路由器）管理面板配一条端口映射「公网端口 → 10.80.12.2:47896」
		 * 后，把生成的公网地址填这里；配对候选/二维码会自动包含它，手机异地零安装直连。
		 */
		/**
		 * 入向可达性自检卡片。
		 *
		 * 用户通常先想到「路由器 DDNS + 端口映射」，但国内宽带多为双层 NAT
		 * （光猫拨号 + 路由器二次 NAT）或 CGNAT，此时 DDNS 拒登、端口映射穿不过
		 * 上游光猫。本卡片主动检测并直接给出结论，避免在路由器上反复试错。
		 */
		function InboundCard() {
			const [state, setState] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");

			const check = react.useCallback(() => {
				setBusy(true); setErr("");
				fetch("/api/mobile/inbound-check", { credentials: "include" })
					.then((r) => r.json())
					.then((d) => { if (d && d.ok) setState(d); else setErr((d && d.error) || "检测失败"); })
					.catch((e) => setErr(String(e)))
					.finally(() => setBusy(false));
			}, []);

			react.useEffect(() => { check(); }, [check]);

			const VERDICT = {
				public: { text: "公网可达（可端口映射）", color: "#2e9e5b", icon: "●" },
				"double-nat": { text: "双层 NAT（入向不可达）", color: "#d9534f", icon: "●" },
				"cgnat-or-multi-nat": { text: "运营商级/多层 NAT", color: "#d9534f", icon: "●" },
				"likely-nat": { text: "疑似 NAT（信息不足）", color: "#d9a441", icon: "●" },
				unknown: { text: "未能判定", color: "#999", icon: "○" },
			};

			const v = state ? (VERDICT[state.verdict] || VERDICT.unknown) : null;
			const hasAlt = state && (state.ovpnConnected || state.relayEnabled);

			return el("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "8px", flex: "none",
					padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				},
			},
				el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					el("span", { style: { fontWeight: 600 } }, "入向可达性自检"),
					v && el("span", { style: { fontSize: "12px", color: v.color, fontWeight: 600 } }, `${v.icon} ${v.text}`),
					el("button", {
						disabled: busy, onClick: check,
						style: { marginLeft: "auto", padding: "2px 10px", fontSize: "12px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" },
					}, busy ? "检测中…" : "重新检测"),
				),
				err && el("div", { style: { fontSize: "12px", color: "#d9534f" } }, "检测失败：" + err),
				state && el("div", { style: { fontSize: "12px", opacity: 0.75, lineHeight: 1.6 } },
					state.publicIp && el("div", null, `公网出口 IP：${state.publicIp}${state.proxySuspected ? "（疑似代理出口，仅供参考）" : ""}`),
					state.wanIp && el("div", null, `路由器 WAN 口：${state.wanIp}`),
					state.gatewayDevice && el("div", null, `上游网关指纹：${state.gatewayDevice}`),
				),
				state && state.reasons && state.reasons.length > 0 && el("ul", {
					style: { margin: 0, paddingLeft: "18px", fontSize: "12px", opacity: 0.8, lineHeight: 1.6 },
				}, ...state.reasons.map((r, i) => el("li", { key: i }, r))),
				state && el("div", {
					style: {
						fontSize: "12px", lineHeight: 1.6, padding: "6px 8px", borderRadius: "6px",
						background: state.doubleNat ? "rgba(217,83,79,0.10)" : "rgba(46,158,91,0.10)",
					},
				}, state.advice),
				hasAlt && el("div", { style: { fontSize: "12px", color: "#2e9e5b" } },
					`已有可用通道：${[state.ovpnConnected && "OpenVPN 已连接", state.relayEnabled && "中继已启用"].filter(Boolean).join("、")}。`),
			);
		}

		function PublicCard() {
			const [url, setUrl] = react.useState("");
			const [loaded, setLoaded] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState("");

			react.useEffect(() => {
				fetch("/api/mobile/public", { credentials: "include" })
					.then((r) => r.json())
					.then((d) => { if (d && d.ok !== false) { setUrl(d.url || ""); setLoaded(true); } })
					.catch(() => {});
			}, []);

			const save = async () => {
				setBusy(true); setMsg("");
				try {
					const r = await fetch("/api/mobile/public", {
						method: "POST", credentials: "include",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ url: url.trim() }),
					});
					const d = await r.json();
					if (!d.ok) { setMsg("保存失败：" + d.error); return; }
					setMsg(d.url ? "已生效：配对二维码已包含公网入口（保存后请刷新二维码）" : "已清除公网入口");
				} catch (e) {
					setMsg("保存失败：" + String(e));
				} finally {
					setBusy(false);
				}
			};

			if (!loaded) return null;
			const input = { width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: "12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" };
			return el("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "8px", flex: "none",
					padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				},
			},
				el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					el("span", { style: { fontWeight: 600 } }, "公网入口（端口转发）"),
					url && el("span", { style: { fontSize: "12px", color: "#2e9e5b", fontWeight: 600 } }, "● 已配置"),
				),
				el("div", { style: { fontSize: "12px", opacity: 0.7 } },
					"无公网 IP + 不想装 VPN 客户端的场景：在 OpenVPN 网关面板配端口映射「公网端口 → 10.80.12.2:47896」，把公网地址填这里，手机扫码即经网关直连宿主（零安装）。"),
				el("div", { style: { display: "flex", gap: "6px" } },
					el("input", {
						style: input, value: url,
						placeholder: "http://117.36.156.68:1443",
						onInput: (e) => setUrl(e.target.value),
					}),
					el("button", {
						disabled: busy, onClick: save,
						style: { padding: "4px 12px", fontSize: "12px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", flex: "none" },
					}, busy ? "保存中…" : "保存"),
				),
				msg && el("div", { style: { fontSize: "12px", opacity: 0.8 } }, msg),
			);
		}

		/**
		 * 远程接入（M2 中继）卡片。
		 *
		 * 手机不在同一局域网时，让宿主主动出站连到中继（wss），手机经由中继访问本实例。
		 * 配置落在数据目录 relay.json（运行时覆盖 cordis.patch.yml），保存即热启停隧道，
		 * 无需重启 DSH。密钥只写不读：服务端仅回 hasKey。
		 */
		function RelayCard() {
			const [state, setState] = react.useState(null);
			const [form, setForm] = react.useState({ url: "", instanceId: "", key: "", enabled: false });
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState("");

			const load = () => fetch("/api/mobile/relay", { credentials: "include" })
				.then((r) => r.json())
				.then((d) => {
					if (!d || d.ok === false) return;
					setState(d);
					setForm((f) => ({
						url: d.config.url || f.url,
						instanceId: d.config.instanceId || f.instanceId,
						key: "",
						enabled: d.config.enabled === true,
					}));
				})
				.catch(() => {});
			react.useEffect(() => { load(); }, []);

			const save = async (patch) => {
				setBusy(true); setMsg("");
				try {
					const body = { enabled: form.enabled, url: form.url.trim(), instanceId: form.instanceId.trim(), ...patch };
					if (form.key.trim()) body.key = form.key.trim();
					const r = await fetch("/api/mobile/relay", {
						method: "POST", credentials: "include",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
					const d = await r.json();
					if (!d.ok) { setMsg("保存失败：" + d.error); return; }
					setMsg("已生效");
					setForm((f) => ({ ...f, key: "" }));
					load();
				} catch (e) {
					setMsg("保存失败：" + String(e));
				} finally {
					setBusy(false);
				}
			};

			if (!state) return null;
			const status = state.status || {};
			const color = status.state === "connected" ? "#2e9e5b"
				: status.state === "error" ? "var(--dsw-alias-state-error-primary,#d33)"
					: status.state === "disabled" ? "var(--dsw-alias-text-secondary,#888)" : "#c98a00";
			const input = { width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: "12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" };

			return el("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "8px", flex: "none",
					padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				},
			},
				el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					el("span", { style: { fontWeight: 600 } }, "远程接入（中继）"),
					el("span", { style: { fontSize: "12px", color, fontWeight: 600 } },
						status.state === "connected" ? "● 已连接"
							: status.state === "connecting" ? "● 连接中"
								: status.state === "error" ? "● 连接失败"
									: status.state === "incomplete" ? "● 配置不完整" : "● 未启用"),
					status.streams !== undefined && el("span", { style: { fontSize: "12px", opacity: 0.6 } },
						`并发流 ${status.streams}` + (status.bytes ? ` · ${Math.round(status.bytes / 1024)} KB` : "")),
				),
				el("div", { style: { fontSize: "12px", opacity: 0.7 } },
					"手机不在同一局域网时用：宿主主动连到中继，手机经中继访问本实例。留空密钥则沿用已保存的值。"),
				el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" } },
					el("label", { style: { fontSize: "12px" } }, "中继地址（ws:// 或 wss://）",
						el("input", { style: input, value: form.url, placeholder: "wss://relay.example.com", onInput: (e) => setForm((f) => ({ ...f, url: e.target.value })) })),
					el("label", { style: { fontSize: "12px" } }, "实例 ID",
						el("input", { style: input, value: form.instanceId, placeholder: "home-pc", onInput: (e) => setForm((f) => ({ ...f, instanceId: e.target.value })) })),
				),
				el("label", { style: { fontSize: "12px" } }, "中继密钥",
					el("input", { style: input, type: "password", value: form.key, placeholder: state.config.hasKey ? "（已保存，留空则不改）" : "与中继服务 --key 一致", onInput: (e) => setForm((f) => ({ ...f, key: e.target.value })) })),
				el("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
					el("label", { style: { fontSize: "12px", display: "flex", alignItems: "center", gap: "4px" } },
						el("input", { type: "checkbox", checked: form.enabled, onChange: (e) => setForm((f) => ({ ...f, enabled: e.target.checked })) }),
						"启用中继"),
					el("button", {
						disabled: busy, onClick: () => save({}),
						style: { padding: "4px 12px", fontSize: "12px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" },
					}, busy ? "保存中…" : "保存并生效"),
					state.config.enabled && el("button", {
						disabled: busy, onClick: () => save({ enabled: false }),
						style: { padding: "4px 12px", fontSize: "12px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" },
					}, "关闭中继"),
					msg && el("span", { style: { fontSize: "12px", opacity: 0.8 } }, msg),
				),
				status.accessUrl && el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					el("code", { style: { fontSize: "12px", wordBreak: "break-all", flex: "1" } }, status.accessUrl),
					el("button", {
						onClick: () => { navigator.clipboard?.writeText(status.accessUrl); setMsg("已复制访问地址"); },
						style: { padding: "3px 10px", fontSize: "12px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" },
					}, "复制"),
				),
				state.file && el("div", { style: { fontSize: "11px", opacity: 0.45, wordBreak: "break-all" } }, "配置：", state.file),
			);
		}

		/**
		 * 虚拟组网接口策略卡片。
		 * 默认剔除 Tailscale/ZeroTier 等虚拟网卡（防止误导性候选）；用户可手动放行，
		 * 覆盖「不同网络 + 无公网 IP」用虚拟组网直连的场景。保存即生效（下次配对载荷
		 * 重新采样），落盘 netconf.json。
		 */
		function VpnCard() {
			const [conf, setConf] = react.useState(null);
			const [mode, setMode] = react.useState("off");
			const [custom, setCustom] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState("");

			const currentMode = (v) => {
				if (v === true) return "all";
				if (Array.isArray(v) && v.length === 1) {
					const lc = String(v[0]).toLowerCase();
					if (lc.includes("tailscale")) return "ts";
					if (lc.includes("zerotier")) return "zt";
				}
				if (Array.isArray(v) && v.length) return "custom";
				return "off";
			};

			react.useEffect(() => {
				fetch("/api/mobile/netconf", { credentials: "include" })
					.then((r) => r.json())
					.then((d) => {
						if (!d || d.ok === false) return;
						setConf(d);
						const m = currentMode(d.virtual);
						setMode(m);
						if (m === "custom") setCustom(d.virtual.join(", "));
					})
					.catch(() => {});
			}, []);

			if (!conf) return null;
			const input = { width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: "12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" };

			const save = async () => {
				setBusy(true); setMsg("");
				let virtual;
				if (mode === "all") virtual = true;
				else if (mode === "ts") virtual = ["Tailscale"];
				else if (mode === "zt") virtual = ["ZeroTier"];
				else if (mode === "custom") virtual = custom.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
				else virtual = false;
				try {
					const r = await fetch("/api/mobile/netconf", {
						method: "POST", credentials: "include",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ virtual }),
					});
					const d = await r.json();
					if (!d.ok) { setMsg("保存失败：" + d.error); return; }
					setConf(d);
					setMsg("已生效，配对二维码已按新策略生成");
				} catch (e) {
					setMsg("保存失败：" + String(e));
				} finally {
					setBusy(false);
				}
			};

			return el("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "8px", flex: "none",
					padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				},
			},
				el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					el("span", { style: { fontWeight: 600 } }, "虚拟组网接口"),
					el("span", { style: { fontSize: "12px", opacity: 0.65 } },
						currentMode(conf.virtual) === "off" ? "默认：剔除虚拟网卡" : "已放行虚拟网卡")),
				el("div", { style: { fontSize: "12px", opacity: 0.7 } },
					"用于 Tailscale / ZeroTier 等组网方案（不同网络但无公网 IP）。放行后虚拟网卡地址会进入配对候选与二维码。"),
				el("div", { style: { display: "flex", gap: "6px" } },
					el("select", {
						style: { ...input, flex: "1" }, value: mode,
						onChange: (e) => setMode(e.target.value),
					},
						el("option", { value: "off" }, "自动剔除（默认）"),
						el("option", { value: "all" }, "放行全部虚拟接口"),
						el("option", { value: "ts" }, "仅 Tailscale"),
						el("option", { value: "zt" }, "仅 ZeroTier"),
						el("option", { value: "custom" }, "自定义（逗号分隔接口名）"),
					),
					el("button", {
						disabled: busy, onClick: save,
						style: { padding: "4px 12px", fontSize: "12px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit" },
					}, busy ? "保存中…" : "保存"),
				),
				mode === "custom" && el("input", {
					style: input, value: custom, placeholder: "Tailscale, ZeroTier, Radmin…",
					onInput: (e) => setCustom(e.target.value),
				}),
				msg && el("div", { style: { fontSize: "12px", opacity: 0.8 } }, msg),
			);
		}

		/**
		 * OpenVPN 通道卡片（自建 VPN 组网）。
		 * 宿主侧一键连接；手机侧用 OpenVPN Connect 导入同一份 client.ovpn 后，
		 * 虚拟 IP 会自动进入配对候选，手机即可像局域网一样直连宿主。
		 */
		function OvnCard() {
			const [st, setSt] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState("");
			const fileRef = react.useRef(null);

			const refresh = () => fetch("/api/mobile/ovpn", { credentials: "include" })
				.then((r) => r.json())
				.then((d) => { if (d && d.ok !== false) setSt(d); })
				.catch(() => {});

			react.useEffect(() => {
				refresh();
				const iv = setInterval(refresh, 3000); // 连接中轮询状态
				return () => clearInterval(iv);
			}, []);

			const act = async (path, doneMsg) => {
				setBusy(true); setMsg("");
				try {
					const r = await fetch(path, { method: "POST", credentials: "include" });
					const d = await r.json();
					if (!d.ok) { setMsg("操作失败：" + d.error); return; }
					setMsg(doneMsg);
					refresh();
				} catch (e) {
					setMsg("操作失败：" + String(e));
				} finally {
					setBusy(false);
				}
			};

			const onFile = async (e) => {
				const f = e.target.files && e.target.files[0];
				if (!f) return;
				setBusy(true); setMsg("");
				try {
					const content = await f.text();
					const r = await fetch("/api/mobile/ovpn/config", {
						method: "POST", credentials: "include",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ content }),
					});
					const d = await r.json();
					if (!d.ok) { setMsg("上传失败：" + d.error); return; }
					setMsg("client.ovpn 已保存（可点连接）");
					refresh();
				} catch (err) {
					setMsg("上传失败：" + String(err));
				} finally {
					setBusy(false);
					if (fileRef.current) fileRef.current.value = "";
				}
			};

			if (!st) return null;
			const color = st.state === "connected" ? "#2e9e5b"
				: st.state === "error" ? "var(--dsw-alias-state-error-primary,#d33)"
					: st.state === "connecting" ? "#c98a00" : "var(--dsw-alias-text-secondary,#888)";
			const btn = {
				padding: "4px 12px", fontSize: "12px", borderRadius: "6px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit",
			};

			return el("div", {
				style: {
					display: "flex", flexDirection: "column", gap: "8px", flex: "none",
					padding: "10px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
				},
			},
				el("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					el("span", { style: { fontWeight: 600 } }, "OpenVPN 通道"),
					el("span", { style: { fontSize: "12px", color, fontWeight: 600 } },
						st.state === "connected" ? "● 已连接" + (st.ip ? ` ${st.ip}` : "")
							: st.state === "connecting" ? "● 连接中…"
								: st.state === "error" ? "● 失败" : "● 未连接"),
				),
				el("div", { style: { fontSize: "12px", opacity: 0.7 } },
					"自建 OpenVPN 组网：宿主连入 VPN 后，虚拟 IP 自动进入配对候选。手机装 OpenVPN Connect 导入同一份 client.ovpn，连上即可扫码直连（适用无公网 IP 场景）。"),
				el("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
					st.hasConfig
						? (st.state === "connected"
							? el("button", { style: btn, disabled: busy, onClick: () => act("/api/mobile/ovpn/disconnect", "已断开") }, "断开")
							: el("button", { style: btn, disabled: busy, onClick: () => act("/api/mobile/ovpn/connect", "已发起连接") }, busy ? "处理中…" : "连接"))
						: el("span", { style: { fontSize: "12px", opacity: 0.6 } }, "尚未上传 client.ovpn"),
					el("button", { style: btn, disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, "上传 client.ovpn"),
					el("input", { ref: fileRef, type: "file", accept: ".ovpn,.conf,text/plain", style: { display: "none" }, onChange: onFile }),
					st.bin && el("span", { style: { fontSize: "11px", opacity: 0.5 } }, "OpenVPN: " + st.bin.split(/[\\/]/).slice(-2).join("/")),
				),
				msg && el("div", { style: { fontSize: "12px", opacity: 0.8 } }, msg),
			);
		}

		/**
		 * 设置分区内容：配对二维码头部 + 同源内嵌移动版 UI。
		 * 高度按视口取比（设置面板是居中模态，内容列约 700px 高），
		 * iframe 自带滚动，移动端全部交互（配对/聊天/插件/设置）可用。
		 */
		function MobileCompanionSection() {
			const [tab, setTab] = react.useState("pair");

			/** 顶部二级导航按钮样式（激活高亮） */
			const tabBtn = (id, label) => el("button", {
				onClick: () => setTab(id),
				style: {
					padding: "5px 14px",
					fontSize: "13px",
					fontWeight: tab === id ? 600 : 400,
					borderRadius: "999px",
					cursor: "pointer",
					border: "1px solid var(--dsw-alias-border-l2)",
					background: tab === id ? "var(--dsw-alias-state-business-primary)" : "transparent",
					color: tab === id ? "#fff" : "inherit",
				},
			}, label);

			return el("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					width: "100%",
					height: "62vh",
					minHeight: "420px",
					gap: "8px",
				},
			},
				// 二级导航：配对 / 中继 / 组网 / 完整界面 分页，不再平铺
				el("div", { style: { display: "flex", gap: "6px", flex: "none", flexWrap: "wrap" } },
					tabBtn("pair", "📱 配对"),
					tabBtn("relay", "🛰 中继"),
					tabBtn("net", "🌐 组网"),
					tabBtn("app", "🖥 完整界面"),
				),
				tab === "pair" ? el("div", { style: { flex: "1", overflowY: "auto", minHeight: "0", paddingRight: "2px" } },
					el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
						el(PairHeader),
						el(InboundCard),
						el(PublicCard),
					),
				) : null,
				tab === "relay" ? el("div", { style: { flex: "none" } }, el(RelayCard)) : null,
				tab === "net" ? el("div", { style: { flex: "1", overflowY: "auto", minHeight: "0", paddingRight: "2px" } },
					el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
						el(VpnCard),
						el(OvnCard),
					),
				) : null,
				el("div", { style: { flex: "1", display: "flex", flexDirection: "column", gap: "4px", minHeight: "0" } },
					el("iframe", {
						src: "/m/",
						title: "DSH 手机版",
						style: {
							flex: "1",
							width: "100%",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "10px",
							background: "transparent",
							// iframe 保活：切 tab 用 display 隐藏而非卸载，保持移动 UI 状态
							display: tab === "app" ? "block" : "none",
						},
					}),
					el("div", {
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "flex-end",
							fontSize: "12px",
							flex: "none",
						},
					},
						el("a", {
							href: "/m/",
							target: "_blank",
							rel: "noopener",
							style: {
								color: "var(--dsw-alias-state-business-primary)",
								textDecoration: "none",
							},
						}, "↗"),
					),
				),
			);
		}

		/**
		 * 客户端 cordis 服务注入：slots（设置插槽）与 locale（词典）。
		 * 与 bot-gateway 同构。
		 */
		const inject = ["slots", "locale"];

		/**
		 * 注册设置分区：order=6（bot-gateway 用 5，本插件排在其后）。
		 * slots.inject 保证目标插槽声明上账后才注册。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "mobile-companion: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-mobile-companion",
				order: 6,
				label: () => t("section.nav"),
				locale: NS,
			}, MobileCompanionSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
