/**
 * plugins.js — 插件中心：插件清单 + 设置命名空间表单（schema 驱动）。
 *
 * pluginInventory/list → {entries: [{entryId, moduleName, enabled, fiberPhase}]}
 * settings/describe()  → {namespaces: [{ns, schema, value, base?, user?, applies, secrets, revision}]}
 * settings/apply(namespace, patch)（若可用）→ 保存
 *
 * schema 为 schemastery 序列化 JSON：{type:'string'|'number'|'boolean'|'object'|'array',
 * ...}。v0.1 覆盖标量 + 常见形态；未知类型回退为 JSON 文本域。
 */

import { rpc } from './api.js'
import { t } from './i18n.js'
import { $, h, toast, sheet } from './app.js'

/** 命名空间显示名：去掉 'dsh-' 前缀 */
const prettyNs = (ns) => String(ns || '').replace(/^dsh-/, '').replace(/-/g, '.')

function schemaField(key, schema, value, isSecret) {
  const label = h('label', null, key + (isSecret ? ' 🔒' : ''))
  const type = schema?.type || typeof value
  if (type === 'boolean' || value === true || value === false) {
    const cb = h('input', { type: 'checkbox' })
    cb.checked = value === true
    return h('div', { class: 'form-item', 'data-key': key }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      h('div', { class: 'grow' }, label), h('span', { class: 'switch' }, cb, h('i'))))
  }
  if (type === 'number') {
    return h('div', { class: 'form-item', 'data-key': key, 'data-type': 'number' }, label,
      h('input', { type: 'number', step: 'any', value: String(value ?? '') }))
  }
  if (type === 'string') {
    if (Array.isArray(schema?.values) || schema?.enum) {
      const opts = (schema.values || schema.enum)
      const sel = h('select', null, opts.map((o) => h('option', { value: String(o), selected: String(o) === String(value) ? '' : undefined }, String(o))))
      return h('div', { class: 'form-item', 'data-key': key }, label, sel)
    }
    const input = h('input', { type: isSecret ? 'password' : 'text', value: String(value ?? '') })
    return h('div', { class: 'form-item', 'data-key': key }, label, input)
  }
  // object/array/未知 → JSON 文本域
  const ta = h('textarea', { spellcheck: 'false' })
  ta.value = JSON.stringify(value ?? null, null, 2)
  return h('div', { class: 'form-item', 'data-key': key, 'data-type': 'json' }, label, ta)
}

function collectForm(container) {
  const patch = {}
  const changed = {}
  for (const item of container.querySelectorAll('.form-item')) {
    const key = item.dataset.key
    let val
    if (item.querySelector('input[type="checkbox"]')) val = item.querySelector('input[type="checkbox"]').checked
    else if (item.dataset.type === 'number') {
      const raw = item.querySelector('input').value
      if (raw === '') continue
      val = Number(raw)
    } else if (item.dataset.type === 'json') {
      try { val = JSON.parse(item.querySelector('textarea').value || 'null') } catch { toast(`「${key}」不是有效 JSON`); return null }
    } else {
      const el = item.querySelector('input,select')
      val = el.value
      if (val === '') continue
    }
    patch[key] = val
    changed[key] = true
  }
  return { patch, changed }
}

function namespaceSheet(nsMeta) {
  const ns = nsMeta.ns
  const value = nsMeta.user ?? nsMeta.value ?? {}
  const props = nsMeta.schema?.type === 'object' && nsMeta.schema?.dict ? null : (nsMeta.schema?.props || nsMeta.schema?.dict)
  const container = h('div')

  if (props && typeof props === 'object') {
    for (const [key, sub] of Object.entries(props)) {
      if (nsMeta.secrets?.list?.includes(key)) continue // 只读密钥跳过
      container.append(schemaField(key, sub, value?.[key], nsMeta.secrets?.list?.includes(key)))
    }
  } else {
    const ta = h('textarea', { spellcheck: 'false' })
    ta.value = JSON.stringify(value, null, 2)
    container.append(h('div', { class: 'form-item', 'data-key': '*', 'data-type': 'json' }, h('label', null, 'JSON'), ta))
  }

  const close = sheet({
    title: prettyNs(ns),
    body: h('div', null, container,
      h('button', { class: 'btn primary', style: { width: '100%', marginTop: '12px' }, onclick: async (e) => {
        const form = collectForm(container)
        if (!form) return
        const patch = form.patch
        if (!Object.keys(patch).length) { toast(t('plugins.saved')); close(); return }
        try {
          // settings/update：{ns, patch, expectedRevision}（乐观并发）
          await rpc('settings/update', { ns, patch, expectedRevision: nsMeta.revision })
          toast(t('plugins.saved'))
          close()
        } catch (err) {
          toast(err.message || String(err))
        }
      } }, t('plugins.save'))),
  })
}

export async function renderPlugins(view) {
  view.replaceChildren(h('div', { class: 'chat-wrap' },
    h('div', { class: 'pagehead' }, h('h1', null, t('plugins.title'))),
    h('div', { class: 'scroller' }, h('div', { class: 'empty' }, t('common.loading'))),
  ))
  const scroller = $('.scroller', view)

  let plugins = null
  let namespaces = null
  try {
    const inv = await rpc('pluginInventory/list', {})
    plugins = inv.entries || []
  } catch { /* 插件清单不可用 */ }
  try {
    const desc = await rpc('settings/describe', {})
    namespaces = desc.namespaces || []
  } catch { /* 设置描述不可用 */ }

  const kids = []

  if (plugins) {
    kids.push(h('div', { class: 'ws-section' }, h('div', { class: 'ws-name' }, '🧩 ' + t('plugins.title'), ` (${plugins.length})`)))
    for (const p of plugins) {
      kids.push(h('div', { class: 'card', style: { margin: '0 16px 8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('h3', { style: { flex: '1' } }, prettyNs(p.moduleName || p.entryId)),
          h('span', { class: 'pill ' + (p.enabled ? 'on' : '') }, p.enabled ? t('plugins.enabled') : t('plugins.disabled')),
        ),
      ))
    }
  }

  if (namespaces?.length) {
    kids.push(h('div', { class: 'ws-section', style: { marginTop: '16px' } }, h('div', { class: 'ws-name' }, '⚙️ ' + t('plugins.settings'), ` (${namespaces.length})`)))
    for (const n of namespaces) {
      kids.push(h('div', { class: 'card', style: { margin: '0 16px 8px' }, onclick: () => namespaceSheet(n) },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('h3', { style: { flex: '1' } }, prettyNs(n.ns)),
          h('span', { style: { color: 'var(--fg-3)', fontSize: '18px' } }, '›'),
        ),
      ))
    }
  }

  if (!kids.length) kids.push(h('div', { class: 'empty' }, t('plugins.noSettings')))
  else {
    // 富插件面板：在完整界面中打开（v0.1 通过 iframe 层承载桌面 GUI 路由）
    kids.push(h('div', { style: { margin: '20px 16px' } },
      h('button', { class: 'btn', style: { width: '100%' }, onclick: () => openFrame('/', 'DSH') }, t('plugins.openFull')),
    ))
  }
  scroller.replaceChildren(...kids)
}

export function openFrame(src, title) {
  const layer = h('div', { class: 'frame-layer' },
    h('div', { class: 'frame-head' },
      h('button', { class: 'iconbtn', onclick: () => layer.remove() }, '‹'),
      h('h1', { style: { flex: '1', fontSize: '16px', margin: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
    ),
    h('iframe', { src }),
  )
  document.body.append(layer)
}
