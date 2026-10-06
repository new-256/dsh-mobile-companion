# 代理软件 / 虚拟网卡冲突排查

> 适用：`dsh-mobile-companion` v0.1.2+
> 本机实测环境：Clash Verge + Tailscale ×2 + Cloudflare WARP + Radmin VPN + Hyper-V + WSL

## 一、结论速查

| 冲突源 | 是否影响手机接入 | 插件是否已自动处理 |
|---|---|---|
| 代理 TUN 假 IP（198.18/198.19） | ⚠️ 会把二维码铸造到不可达地址 | ✅ 已自动剔除 |
| Tailscale CGNAT（100.64–100.127） | ⚠️ 同上 | ✅ 已自动剔除 |
| Radmin VPN（26.x.x.x） | ⚠️ 同上 | ✅ 按接口名剔除 |
| Hyper-V / WSL vEthernet（172.x） | ⚠️ 同上 | ✅ 按接口名剔除 |
| link-local（169.254.x） | ⚠️ 同上 | ✅ 已自动剔除 |
| 系统代理（HTTP_PROXY 等） | ❌ 不影响 | 插件不发起出网请求 |
| 代理 TUN **劫持入站** | ⚠️ 可能 | ❌ 需手动加绕过规则 |
| **网卡被判定 Public** | 🔴 **直接导致连不上** | ❌ **需手动改 Private** |
| 端口被代理占用 | ⚠️ 可能 | ✅ 端口冲突时可换端口 |

## 二、插件自动处理的部分

`lib/pairing.mjs` 的 `sampleLanIps()` 按以下规则筛选，只把**真实物理网卡地址**写进二维码：

**按 IP 段剔除**
- `169.254.0.0/16` — link-local（网卡未拿到 DHCP）
- `100.64.0.0/10` — CGNAT，Tailscale 等使用
- `198.18.0.0/15` — 基准测试保留段，Clash / Mihomo / sing-box 的 fake-ip 默认段

**按接口名剔除**（不区分大小写包含匹配）
```
hyper-v, vEthernet, default switch, docker, nat, br-, wsl,
tailscale, zerotier, vmware, virtualbox, radmin,
bluetooth, loopback, tun, tap, ndis, pseudo, 本地连接
```

**降级策略**：无物理网卡时才回退虚拟接口；全无外部接口才回退 `127.0.0.1`。不会返回空数组导致铸造失败。

### 自检命令

```powershell
cd <DSH>\plugins\mobile-companion
node -e "import('./lib/pairing.mjs').then(m=>{console.log('选中:',m.sampleLanIps());console.table(m.diagnoseInterfaces())})"
```

本机实测输出：

```
选中: [ '192.168.5.124' ]
┌─────────┬──────────────────────────────────────┬──────────────────┬─────────┬──────────┐
│ (index) │ name                                 │ address          │ virtual │ annoying │
├─────────┼──────────────────────────────────────┼──────────────────┼─────────┼──────────┤
│ 0       │ 'Radmin VPN'                         │ '26.16.84.99'    │ true    │ false    │
│ 1       │ 'Tailscale'                          │ '169.254.83.107' │ true    │ true     │
│ 2       │ '以太网 4'                            │ '192.168.5.124'  │ false   │ false    │
│ 3       │ 'vEthernet (Default Switch)'         │ '172.22.176.1'   │ true    │ false    │
│ 4       │ 'vEthernet (WSL (Hyper-V firewall))' │ '172.19.96.1'    │ true    │ false    │
└─────────┴──────────────────────────────────────┴──────────────────┴─────────┴──────────┘
```

### 在线自检端点

```
GET /api/mobile/net-check
```

返回 `chosen`（最终选中地址）、`interfaces`（全量诊断表）、`warnings`（冲突告警）。若 `warnings` 非空，按提示处理。

## 三、需要你手动处理的部分

### 3.1 🔴 网卡被判定为 Public（本机命中）

Windows 把「以太网 4」标为 **Public**，此时防火墙默认拦截入站，**手机一定连不上**。

```powershell
# 查看
Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory

# 改为 Private（管理员 PowerShell）
Set-NetConnectionProfile -InterfaceAlias "以太网 4" -NetworkCategory Private
```

或图形界面：设置 → 网络和 Internet → 以太网 → 网络配置文件类型 → **专用网络**。

### 3.2 放通入站端口

```powershell
# 管理员 PowerShell，<PORT> 换成实际端口
netsh advfirewall firewall add rule name="DSH Mobile" dir=in action=allow protocol=TCP localport=<PORT>

# 撤销
netsh advfirewall firewall delete rule name="DSH Mobile"
```

### 3.3 代理软件绕过规则

TUN / 增强模式开启时，代理可能接管全部流量。按需加规则：

**Clash / Mihomo / Clash Verge** — 配置文件加直连规则：
```yaml
rules:
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
```

TUN 模式再加：
```yaml
tun:
  enable: true
  # 让局域网段不走 TUN
  route-exclude-address:
    - 192.168.0.0/16
    - 10.0.0.0/8
    - 172.16.0.0/12
```

**sing-box** — `route.rules` 加 `ip_cidr` + `outbound: direct`。

**Cloudflare WARP** — Split Tunnel 中确认私有网段在排除列表（默认已排除 RFC1918）。

**Tailscale** — 不影响局域网直连；若要走 Tailscale 访问，用 `100.x.x.x` 地址并把它写进 `config.lanIps`。

### 3.4 端口冲突

常见占用：Clash `7890/7891/7897/9090`、WARP `40000+`。若目标端口被占：

```powershell
Get-NetTCPConnection -LocalPort <PORT> -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName }
```

换端口即可，无需改插件代码。

## 四、强制指定地址（终极兜底）

自动探测在复杂网络下仍可能选错时，在 `cordis.patch.yml` 显式指定：

```yaml
- insert:
    - id: mobile-companion
      name: dsh-mobile-companion
      config:
        dataPath: '<...>/mobile-companion'
        lanIps: ['192.168.5.124']   # 显式指定，跳过全部自动探测
```

`config.lanIps` 优先级最高，直接覆盖 `webRuntime.lanAddresses` 与 `sampleLanIps()`。

## 五、完整排障流程

```
手机打不开 /m/
  │
  ├─ 1. 电脑本机能开 http://127.0.0.1:<port>/m/ 吗？
  │      否 → 插件未挂载：查 cordis.patch.yml 并重启 DSH
  │      是 → 继续
  │
  ├─ 2. GET /api/mobile/net-check 的 reachable 是 true 吗？
  │      否 → 仅绑定 127.0.0.1，需开启局域网监听或做端口转发
  │      是 → 继续
  │
  ├─ 3. net-check 的 warnings 有内容吗？
  │      有 → 按提示处理（多为选中了虚拟网卡）
  │      无 → 继续
  │
  ├─ 4. 网卡 NetworkCategory 是 Private 吗？
  │      否 → 见 3.1 改为 Private        ← 本机命中
  │      是 → 继续
  │
  ├─ 5. 手机和电脑在同一网段吗？（手机 WLAN 详情看 IP 前三段）
  │      否 → 关闭手机流量/换同一 Wi-Fi；或手机也接入 Tailscale
  │      是 → 继续
  │
  ├─ 6. 手机关闭自己的代理/VPN 后能连吗？
  │      能 → 手机端代理拦截，加绕过规则
  │      不能 → 继续
  │
  ├─ 7. 电脑防火墙放通该端口了吗？（见 3.2）
  │      否 → 加规则
  │      是 → 继续
  │
  └─ 8. 电脑代理 TUN 关闭后能连吗？
         能 → 见 3.3 加绕过规则
         不能 → 用 config.lanIps 强制指定地址（见第四节）
```

## 六、回归测试

```bash
node test/test-netconflict.mjs    # 9 例：假表注入 + 真机现场校验
npm test                          # 全套 4 个套件
```

测试覆盖：真实用户环境接口表、代理假 IP 段、CGNAT、link-local、多物理网卡、纯虚拟降级、全无接口回退、IPv6 混入、真机现场采样。
