/**
 * test-netconflict.mjs — 局域网地址选择与代理冲突识别回归测试。
 *
 * 背景：本机常并存代理 TUN（198.18/100.64 假 IP）、Radmin VPN、Tailscale、
 * Hyper-V/WSL vEthernet、蓝牙 PAN 等虚拟接口。os.networkInterfaces() 的返回
 * 顺序不稳定，若直接取 [0] 会把二维码铸造到手机不可达的地址上。
 *
 * sampleLanIps()/diagnoseInterfaces() 支持注入接口表（首参），本测试直接传假表。
 */

import assert from 'node:assert/strict'
import { sampleLanIps, diagnoseInterfaces } from '../lib/pairing.mjs'

let pass = 0
const ok = (msg) => { console.log(`  ✅ ${msg}`); pass++ }

const v4 = (address, extra = {}) => ({
  address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', ...extra,
})

console.log('局域网地址选择与代理冲突识别')

// 1. 真实用户环境（Radmin 在前、真 LAN 在中）
{
  const table = {
    'Radmin VPN': [v4('26.16.84.99')],
    'Tailscale': [v4('169.254.83.107')],
    '以太网 4': [v4('192.168.5.124')],
    'vEthernet (Default Switch)': [v4('172.22.176.1')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.19.96.1')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', { internal: true })],
  }
  const ips = sampleLanIps(table)
  assert.deepEqual(ips, ['192.168.5.124'], `期望仅真实 LAN，实际 ${JSON.stringify(ips)}`)
  ok('真实环境：跳过 Radmin/Tailscale/Hyper-V/WSL，只留 192.168.5.124')

  const diag = diagnoseInterfaces(table)
  assert.equal(diag.length, 5, 'internal 接口应被排除')
  assert.equal(diag.find(d => d.name === 'Radmin VPN').virtual, true)
  assert.equal(diag.find(d => d.name === 'Tailscale').annoying, true)
  assert.equal(diag.find(d => d.name === '以太网 4').virtual, false)
  assert.equal(diag.find(d => d.name === '以太网 4').annoying, false)
  ok('诊断表正确标注 virtual / annoying')
}

// 2. 代理 TUN 假 IP 段必须被剔除
{
  const ips = sampleLanIps({
    'Clash': [v4('198.18.0.1')],
    'Mihomo TUN': [v4('198.19.0.1')],
    'Tailscale': [v4('100.101.102.103')],
    'Wi-Fi': [v4('192.168.1.50')],
  })
  assert.deepEqual(ips, ['192.168.1.50'], `代理假 IP 未被剔除：${JSON.stringify(ips)}`)
  ok('代理 TUN 假 IP（198.18/198.19）与 CGNAT（100.64-127）全部剔除')
}

// 3. link-local 单独出现时不得被选中
{
  const ips = sampleLanIps({
    'WLAN': [v4('169.254.162.104')],
    'WLAN 2': [v4('169.254.251.18')],
    '以太网': [v4('10.0.0.7')],
  })
  assert.deepEqual(ips, ['10.0.0.7'])
  ok('169.254 link-local 全部剔除，保留 10.0.0.7')
}

// 4. 多个真实网卡时全部保留且保持稳定顺序
{
  const ips = sampleLanIps({
    '以太网': [v4('192.168.5.124')],
    'Wi-Fi': [v4('192.168.1.50')],
  })
  assert.deepEqual(ips, ['192.168.5.124', '192.168.1.50'])
  ok('多物理网卡全部保留，顺序稳定')
}

// 5. 只有虚拟接口时降级返回（而非空数组导致铸造失败）
{
  const ips = sampleLanIps({
    'vEthernet (WSL)': [v4('172.19.96.1')],
    'Radmin VPN': [v4('26.16.84.99')],
  })
  assert.ok(ips.length > 0, '不得返回空数组')
  assert.ok(!ips.includes('127.0.0.1'), '有虚拟接口时不应回退 loopback')
  ok(`无物理网卡时降级到虚拟接口：${ips.join(', ')}`)
}

// 6. 完全无非 internal 接口时回退 loopback（不抛异常）
{
  const ips = sampleLanIps({
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', { internal: true })],
  })
  assert.deepEqual(ips, ['127.0.0.1'])
  ok('全无外部接口时回退 127.0.0.1，不抛异常')
}

// 7. IPv6 条目不得混入
{
  const ips = sampleLanIps({
    '以太网': [
      v4('192.168.5.124'),
      { address: 'fe80::1', family: 'IPv6', internal: false, netmask: 'ffff::', mac: '00:00:00:00:00:00' },
    ],
  })
  assert.deepEqual(ips, ['192.168.5.124'])
  ok('IPv6 条目被正确忽略')
}

// 8. 真机现场校验：当前宿主机不得选出虚拟地址
{
  const live = sampleLanIps()
  const diag = diagnoseInterfaces()
  const chosen = live[0]
  const chosenIface = diag.find(d => d.address === chosen)
  if (chosenIface) {
    assert.equal(chosenIface.annoying, false, `选中地址 ${chosen} 属无效段`)
  }
  ok(`真机采样 = ${live.join(', ')}（接口「${chosenIface?.name ?? 'loopback 回退'}」）`)
}

// 9. 虚拟组网策略：virtual=true 放行全部虚拟接口（Tailscale 直连场景）
{
  const table = {
    'Radmin VPN': [v4('26.16.84.99')],
    'Tailscale': [v4('100.101.102.103')],
    '以太网 4': [v4('192.168.5.124')],
    'vEthernet (WSL)': [v4('172.19.96.1')],
  }
  const ips = sampleLanIps(table, { virtual: true })
  assert.ok(ips.includes('100.101.102.103'), `virtual=true 应包含 Tailscale，实际 ${JSON.stringify(ips)}`)
  assert.ok(ips.includes('26.16.84.99'), 'virtual=true 应包含 Radmin')
  assert.ok(ips.includes('192.168.5.124'), '真实网卡仍保留')
  ok(`virtual=true 放行全部虚拟接口：${ips.join(', ')}`)
}

// 10. 虚拟组网策略：只放行指定模式（['Tailscale']）
{
  const table = {
    'Radmin VPN': [v4('26.16.84.99')],
    'Tailscale': [v4('100.101.102.103')],
    '以太网 4': [v4('192.168.5.124')],
    'vEthernet (WSL)': [v4('172.19.96.1')],
  }
  const ips = sampleLanIps(table, { virtual: ['Tailscale'] })
  assert.ok(ips.includes('100.101.102.103'), '指定 Tailscale 应放行')
  assert.ok(!ips.includes('26.16.84.99'), '未指定的 Radmin 不放行')
  assert.deepEqual(ips, ['192.168.5.124', '100.101.102.103'], `顺序：物理在前、放行虚拟在后，实际 ${JSON.stringify(ips)}`)
  ok('virtual=["Tailscale"] 只放行 Tailscale')

  const diag = diagnoseInterfaces(table, { virtual: ['Tailscale'] })
  assert.equal(diag.find(d => d.name === 'Tailscale').allowed, true, 'Tailscale 标记 allowed')
  assert.equal(diag.find(d => d.name === 'Radmin VPN').allowed, false, 'Radmin 仍虚拟未放行')
  ok('诊断表按策略标注 allowed')
}

// 11. 虚拟组网策略：默认/off 仍剔除（回归默认行为）
{
  const table = {
    'Radmin VPN': [v4('26.16.84.99')],
    'Tailscale': [v4('100.101.102.103')],
    '以太网 4': [v4('192.168.5.124')],
  }
  assert.deepEqual(sampleLanIps(table, { virtual: false }), ['192.168.5.124'], 'virtual=false 保持剔除')
  assert.deepEqual(sampleLanIps(table, { virtual: undefined }), ['192.168.5.124'], '缺省保持剔除')
  ok('virtual=false / 缺省：默认行为不变')
}

console.log(`\n局域网冲突识别测试全部通过（${pass} 例）`)
