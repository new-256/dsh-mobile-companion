/**
 * settings.js — 设置视图：外观（主题/语言）、连接信息、配对设备管理、关于。
 */

import { t, setLang } from './i18n.js'
import { $, h, toast, sheet, state, applyTheme, fmtTime, renderRoute } from './app.js'

export async function renderSettings(view) {
  view.replaceChildren(h('div', { class: 'chat-wrap' },
    h('div', { class: 'pagehead' }, h('h1', null, t('settings.title'))),
    h('div', { class: 'scroller' }, h('div', { class: 'empty' }, t('common.loading'))),
  ))
  const scroller = $('.scroller', view)

  // ── 外观 ──
  const themeBtns = ['system', 'light', 'dark'].map((mode) => h('button', {
    class: 'btn ' + (state.theme === mode ? 'active' : ''),
    onclick: () => {
      state.theme = mode
      localStorage.setItem('dsh.m.theme', mode)
      applyTheme(mode)
      renderRoute()
    },
  }, t(`settings.theme${mode[0].toUpperCase()}${mode.slice(1)}`)))

  const langSel = h('select', null,
    h('option', { value: 'zh', selected: state.lang === 'zh' ? '' : undefined }, '中文'),
    h('option', { value: 'en', selected: state.lang === 'en' ? '' : undefined }, 'English'),
  )
  langSel.addEventListener('change', () => {
    state.lang = langSel.value
    localStorage.setItem('dsh.m.lang', langSel.value)
    setLang(langSel.value)
    renderRoute()
  })

  // ── 连接信息 + 设备 ──
  let pairInfo = null
  let devices = []
  let netconf = null
  try {
    const res = await fetch('/api/mobile/pair-info', { credentials: 'include' })
    if (res.ok) pairInfo = await res.json()
  } catch { /* ignore */ }
  try {
    const res = await fetch('/api/mobile/devices', { credentials: 'include' })
    if (res.ok) devices = (await res.json()).devices || []
  } catch { /* ignore */ }
  try {
    const res = await fetch('/api/mobile/netconf', { credentials: 'include' })
    if (res.ok) netconf = await res.json()
  } catch { /* ignore */ }

  const kids = []

  kids.push(h('div', { class: 'card' },
    h('h3', null, t('settings.appearance')),
    h('div', { class: 'form-item' }, h('label', null, t('settings.theme')),
      h('div', { class: 'radio-row' }, themeBtns)),
    h('div', { class: 'form-item' }, h('label', null, '语言 / Language'), langSel),
  ))

  if (pairInfo && !pairInfo.error) {
    // 虚拟组网开关（Tailscale / ZeroTier 等虚拟网卡是否进配对候选）
    const vpnOn = netconf?.virtual === true || Array.isArray(netconf?.virtual)
    const vpnToggle = h('input', { type: 'checkbox', checked: vpnOn })
    vpnToggle.addEventListener('change', async () => {
      try {
        const res = await fetch('/api/mobile/netconf', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ virtual: vpnToggle.checked ? true : false }),
        })
        const r = await res.json()
        if (!r.ok) throw new Error(r.error)
        toast(vpnToggle.checked ? '已放行虚拟组网接口' : '已恢复默认（剔除虚拟接口）')
      } catch (e) {
        vpnToggle.checked = !vpnToggle.checked
        toast(e.message || String(e))
      }
    })
    kids.push(h('div', { class: 'card' },
      h('h3', null, t('settings.connection')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'lbl' }, '主机'), h('div', { class: 'sub' }, pairInfo.name || '—')), h('span', { class: 'pill on' }, pairInfo.reachable ? 'LAN 可达' : '仅本机')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'lbl' }, '端口'), h('div', { class: 'sub' }, String(pairInfo.port || '—')))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'lbl' }, '地址'), h('div', { class: 'sub' }, (pairInfo.urls || []).join(' · ')))),
      h('div', { class: 'form-item' },
        h('label', null, t('settings.vpn'), vpnToggle),
        h('div', { class: 'sub', style: { color: 'var(--fg-3)', fontSize: '12px' } },
          vpnOn ? '已包含 Tailscale/ZeroTier 等虚拟网卡地址' : '默认剔除虚拟网卡；用虚拟组网时请开启（桌面端可精确指定）')),
      pairInfo.lanUrl ? h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'lbl' }, t('settings.showQr')),
          h('div', { class: 'sub' }, '扫码或发送此链接给手机')),
        h('button', { class: 'btn small', onclick: () => {
          navigator.clipboard?.writeText(pairInfo.lanUrl).then(() => toast('已复制'), () => toast(pairInfo.lanUrl))
        } }, '复制'),
      ) : null,
    ))
    kids.push(h('div', { class: 'card', style: { textAlign: 'center' } },
      h('h3', { style: { textAlign: 'left' } }, t('settings.showQr')),
      h('div', { class: 'qr-box' }, h('img', { src: '/api/mobile/qr.svg', alt: 'QR' })),
      h('div', { style: { fontSize: '12px', color: 'var(--fg-3)' } }, '用 DSH 手机版 App 扫码配对'),
    ))
  }

  kids.push(h('div', { class: 'card' },
    h('h3', null, t('settings.devices')),
    devices.length
      ? devices.map((d) => h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'lbl' }, d.name || d.deviceId.slice(0, 10)),
            h('div', { class: 'sub' }, `${d.platform || ''} · 最近活跃 ${fmtTime(d.lastSeenAt || d.createdAt)}`)),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!confirm(t('settings.revokeConfirm'))) return
            try {
              const res = await fetch('/api/mobile/devices/revoke', {
                method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ deviceId: d.deviceId }),
              })
              const r = await res.json()
              if (!r.ok) throw new Error(r.error)
              toast('已移除')
              renderRoute()
            } catch (e) { toast(e.message || String(e)) }
          } }, t('settings.revoke')),
        ))
      : h('div', { class: 'sub', style: { color: 'var(--fg-3)', fontSize: '13px' } }, t('settings.devicesEmpty')),
  ))

  kids.push(h('div', { class: 'card' },
    h('h3', null, t('settings.about')),
    h('div', { class: 'sub', style: { color: 'var(--fg-2)', fontSize: '13px', whiteSpace: 'pre-line' } }, t('settings.aboutText')),
  ))

  // ── 通知 / 免打扰（M2 推送脚手架：注册状态 + 每设备免打扰窗口）──
  let pushStatus = null
  try {
    const res = await fetch('/api/mobile/push/status', { credentials: 'include' })
    if (res.ok) pushStatus = await res.json()
  } catch { /* ignore */ }

  const dndRow = (d, cur) => {
    const from = h('input', { type: 'time', value: cur?.from || '22:00' })
    const to = h('input', { type: 'time', value: cur?.to || '08:00' })
    const on = h('input', { type: 'checkbox', checked: cur?.enabled === true })
    const save = async () => {
      try {
        const res = await fetch('/api/mobile/push/dnd', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ deviceId: d.deviceId, enabled: on.checked, from: from.value, to: to.value }),
        })
        const r = await res.json()
        if (!r.ok) throw new Error(r.error || '保存失败')
        toast(on.checked ? '免打扰已开启' : '免打扰已关闭')
      } catch (e) { toast(e.message || String(e)) }
    }
    on.addEventListener('change', save)
    from.addEventListener('change', save)
    to.addEventListener('change', save)
    return h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('div', { class: 'lbl' }, '免打扰', on),
        h('div', { class: 'sub' }, `${d.name || d.deviceId.slice(0, 10)} · 窗口 ${from.value} – ${to.value}（跨午夜支持）`)),
    )
  }

  kids.push(h('div', { class: 'card' },
    h('h3', null, '通知 / 免打扰'),
    h('div', { class: 'sub', style: { color: 'var(--fg-3)', fontSize: '12px', marginBottom: '4px' } },
      pushStatus?.registered
        ? `${pushStatus.registered} 台设备已注册推送（${pushStatus.devices.map((x) => `${x.platform}·${x.deviceId.slice(0, 6)}`).join('、')}）`
        : '推送未注册：App 配对后会自动注册；FCM 服务端凭据配置见《配置手册》'),
    devices.length ? devices.map((d) => dndRow(d, pushStatus?.dnd?.[d.deviceId])) : null,
  ))

  scroller.replaceChildren(...kids)
}
