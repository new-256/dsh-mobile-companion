/**
 * app.js — 移动端主入口：认证检查、路由、会话列表、回收站、通用 UI 组件。
 */

import { rpc, Mux, authCheck, ApiError, uuid } from './api.js'
import { t, setLang } from './i18n.js'
import { openChat, activeChat } from './chat.js'
import { renderPlugins } from './plugins.js'
import { renderSettings } from './settings.js'

// ── 通用 DOM 工具 ────────────────────────────────────────────────────────────
export const $ = (sel, root) => (root || document).querySelector(sel)
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c.nodeType ? c : document.createTextNode(String(c)))
  }
  return el
}

let toastTimer = null
export function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600)
}

export function sheet({ title, body }) {
  const mask = $('#sheet')
  $('#sheetTitle').textContent = title
  const box = $('#sheetBody')
  box.replaceChildren(body)
  mask.classList.remove('hidden')
  const close = () => mask.classList.add('hidden')
  mask.onclick = (e) => { if (e.target === mask) close() }
  return close
}

export function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const sameDay = new Date(now).toDateString() === d.toDateString()
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function fmtBytes(n) {
  if (!n || n < 0) return '0'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

// ── 主题 ────────────────────────────────────────────────────────────────────
export function applyTheme(pref) {
  const resolved = pref === 'light' || pref === 'dark' ? pref : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.documentElement.dataset.theme = resolved
}

// ── 全局状态 ─────────────────────────────────────────────────────────────────
export const state = {
  mux: null,
  theme: localStorage.getItem('dsh.m.theme') || 'system',
  lang: localStorage.getItem('dsh.m.lang') || 'zh',
  workspaces: new Map(),      // workspaceId -> {path,title,sessionIds,updatedAt}
  archived: new Set(),        // archivedSessionIds
  sessions: new Map(),        // sessionId -> session/list 条目
  route: '',
}

export async function refreshSessions() {
  try {
    const res = await rpc('session/list', {})
    for (const item of res.items || []) state.sessions.set(item.sessionId, item)
    renderRoute()
  } catch { /* 静默：视图自行展示错误 */ }
}

// ── 会话列表视图 ─────────────────────────────────────────────────────────────
let sessTab = 'main'

function sessionTitle(s) {
  return s?.projections?.title || (s?.blank ? t('chat.newTask') : s?.sessionId?.slice(0, 8)) || '会话'
}

function renderSessions(view) {
  const head = h('div', { class: 'pagehead' },
    h('h1', null, t('sessions.title')),
    h('button', { class: 'iconbtn', title: t('sessions.trash'), onclick: () => { location.hash = '#/trash' } }, '🗑️'),
  )
  const seg = h('div', { class: 'seg' },
    h('button', { class: sessTab === 'main' ? 'active' : '', onclick: () => { sessTab = 'main'; renderRoute() } }, t('sessions.tabMain')),
    h('button', { class: sessTab === 'archived' ? 'active' : '', onclick: () => { sessTab = 'archived'; renderRoute() } }, t('sessions.tabArchived')),
  )
  const scroller = h('div', { class: 'scroller' })
  const wrap = h('div', { class: 'chat-wrap' }, head, seg, scroller,
    h('button', { class: 'fab', onclick: () => newTaskSheet() }, '+'))

  // 会话条目：按工作区分组
  const groups = new Map()
  for (const [wsId, ws] of state.workspaces) groups.set(wsId, { ws, items: [] })
  for (const s of state.sessions.values()) {
    const isArchived = state.archived.has(s.sessionId)
    if (sessTab === 'main' ? isArchived : !isArchived) continue
    if (s.parentSessionId) continue // 子代理会话不单独列出
    let bucket = null
    for (const [wsId, ws] of state.workspaces) if (ws.sessionIds?.includes(s.sessionId)) bucket = wsId
    if (!bucket && sessTab === 'main') continue
    if (bucket) groups.get(bucket).items.push(s)
    else groups.set(`__orphan_${s.sessionId}`, { ws: { title: '' }, items: [s] })
  }

  let any = false
  for (const [, g] of groups) {
    if (!g.items.length) continue
    any = true
    g.items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    scroller.append(h('div', { class: 'ws-section' },
      g.ws.title ? h('div', { class: 'ws-name' }, '📁 ', g.ws.title) : null,
      h('div', { class: 'sess-list' }, g.items.map((s) => sessionCard(s))),
    ))
  }
  if (!any) scroller.append(h('div', { class: 'empty' }, t('sessions.empty')))
  view.replaceChildren(wrap)
}

function sessionCard(s) {
  const title = sessionTitle(s)
  const running = !!s.running
  return h('div', {
    class: 'sess-card',
    onclick: () => { location.hash = `#/chat/${encodeURIComponent(s.sessionId)}` },
    oncontextmenu: (e) => { e.preventDefault(); sessionSheet(s) },
  },
    h('div', { class: 'sess-avatar' }, (title[0] || '·').toUpperCase()),
    h('div', { class: 'sess-main' },
      h('div', { class: 'sess-title' }, title),
      h('div', { class: 'sess-sub' }, s.cwd ? s.cwd.split(/[\\/]/).pop() : t('common.empty')),
    ),
    h('div', { class: 'sess-meta' },
      running ? h('span', { class: 'badge-run' }, t('sessions.running')) : null,
      h('span', null, fmtTime(s.updatedAt)),
    ),
  )
}

function sessionSheet(s) {
  const body = h('div', null,
    h('button', { class: 'btn', onclick: async () => {
      try {
        await rpc('workspace/archiveSession', { request: { sessionId: s.sessionId } })
        toast(t('sessions.archived'))
      } catch (e) { toast(e.message) }
      renderRoute()
    } }, t('chat.archive')),
    h('button', { class: 'btn danger', onclick: async () => {
      try {
        const res = await fetch('/api/session-cleaner/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: s.sessionId, confirm: 'DELETE' }),
        })
        const data = await res.json()
        if (!data.success) throw new Error(data.error || '失败')
        state.sessions.delete(s.sessionId)
        toast('已移入回收站')
      } catch (e) { toast(e.message) }
      renderRoute()
    } }, t('chat.delete')),
  )
  sheet({ title: sessionTitle(s), body })
}

function newTaskSheet() {
  const options = [...state.workspaces.values()].filter((w) => w.path)
  const sel = h('select', { style: { width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', font: 'inherit' } },
    options.length
      ? options.map((w) => h('option', { value: w.workspaceId || w.path }, w.title || w.path))
      : h('option', { value: '' }, t('sessions.newDesc')),
  )
  const titleInput = h('input', { type: 'text', placeholder: t('sessions.newPlaceholder'), style: { width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)', font: 'inherit', marginTop: '10px' } })
  const close = sheet({
    title: t('sessions.newTitle'),
    body: h('div', null, sel, titleInput,
      h('button', { class: 'btn primary', style: { width: '100%', marginTop: '12px' }, onclick: async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        try {
          const wsVal = sel.value
          const args = { request: {} }
          const ws = [...state.workspaces.entries()].find(([id, w]) => (id === wsVal || w.path === wsVal))
          if (ws && ws[1].path) args.request.cwd = ws[1].path
          if (titleInput.value.trim()) args.request.sessionId = titleInput.value.trim().slice(0, 80)
          const res = await rpc('session/create', args)
          close()
          const sid = res?.sessionId || res?.session?.id || titleInput.value.trim()
          if (sid) location.hash = `#/chat/${encodeURIComponent(sid)}`
          else { await refreshSessions(); renderRoute() }
        } catch (err) {
          toast(err.message || String(err))
          btn.disabled = false
        }
      } }, t('sessions.create')),
    ),
  })
}

// ── 回收站视图 ───────────────────────────────────────────────────────────────
async function renderTrash(view) {
  view.replaceChildren(h('div', { class: 'chat-wrap' },
    h('div', { class: 'pagehead' },
      h('button', { class: 'iconbtn', onclick: () => { location.hash = '#/sessions' } }, '‹'),
      h('h1', null, t('trash.title')),
    ),
    h('div', { class: 'scroller' }, h('div', { class: 'empty' }, t('common.loading'))),
  ))
  let data
  try {
    const res = await fetch('/api/session-cleaner/trash')
    data = await res.json()
  } catch {
    data = { success: false, error: '网络错误' }
  }
  const scroller = $('.scroller', view)
  if (!data.success || !data.trash?.length) {
    scroller.replaceChildren(h('div', { class: 'empty' }, data.success ? t('trash.empty') : `⚠️ ${data.error || '不可用'}`))
    return
  }
  const items = data.trash.slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
  scroller.replaceChildren(...items.map((it) => h('div', { class: 'card' },
    h('h3', null, it.title || it.sessionId),
    h('div', { class: 'desc' }, `${it.workspaceTitle || ''} · ${fmtTime(it.deletedAt)} · ${fmtBytes(it.dirSize)}`),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'btn small', onclick: async (e) => {
        e.currentTarget.disabled = true
        try {
          const res = await fetch('/api/session-cleaner/restore', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: it.sessionId }),
          })
          const r = await res.json()
          if (!r.success) throw new Error(r.error)
          toast('已恢复')
          renderRoute()
        } catch (err) { toast(err.message); e.currentTarget.disabled = false }
      } }, t('trash.restore')),
      h('button', { class: 'btn small danger', onclick: async (e) => {
        if (!confirm(t('trash.purgeConfirm'))) return
        e.currentTarget.disabled = true
        try {
          const res = await fetch('/api/session-cleaner/purge', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: it.sessionId }),
          })
          const r = await res.json()
          if (!r.success) throw new Error(r.error)
          toast('已彻底删除')
          renderRoute()
        } catch (err) { toast(err.message); e.currentTarget.disabled = false }
      } }, t('trash.purge')),
    ),
  )))
}

// ── 配对引导页 ───────────────────────────────────────────────────────────────
function renderPairNeeded(view) {
  view.replaceChildren(h('div', { class: 'scroller' },
    h('div', { class: 'pair-page' },
      h('div', { class: 'big' }, '📱'),
      h('h2', null, t('pair.needTitle')),
      h('p', null, t('pair.needBody')),
      h('p', { style: { fontSize: '12px' } }, t('pair.hintBrowser')),
      h('button', { class: 'btn primary', style: { marginTop: '16px' }, onclick: () => location.reload() }, t('pair.retry')),
    ),
  ))
}

// ── 路由 ─────────────────────────────────────────────────────────────────────
function setTabbar(route) {
  const bar = $('#tabbar')
  bar.classList.remove('hidden')
  for (const btn of bar.querySelectorAll('.tab')) {
    btn.classList.toggle('active', route.startsWith(btn.dataset.route))
  }
}

export function renderRoute() {
  const view = $('#view')
  const hash = location.hash || '#/sessions'
  const route = hash.slice(2) // 去掉 #/
  state.route = route
  const top = route.split('/')[0]

  if (top === 'chat') {
    $('#tabbar').classList.add('hidden')
    const sid = decodeURIComponent(route.split('/')[1] || '')
    openChat(view, sid)
    return
  }
  setTabbar(route)

  if (top === 'sessions' || top === '') renderSessions(view)
  else if (top === 'plugins') renderPlugins(view)
  else if (top === 'settings') renderSettings(view)
  else if (top === 'trash') renderTrash(view)
  else renderSessions(view)
}

window.addEventListener('hashchange', () => {
  if (activeChat) activeChat.close()
  renderRoute()
})

// ── 启动 ─────────────────────────────────────────────────────────────────────
async function boot() {
  setLang(state.lang)
  applyTheme(state.theme)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyTheme('system')
  })

  const ok = await authCheck()
  if (!ok) {
    renderPairNeeded($('#view'))
    return
  }

  // mux + 工作区流
  const mux = new Mux()
  state.mux = mux
  mux.onstatus = (s) => {
    const bar = $('#netbar')
    if (s === 'open') bar.classList.add('hidden')
    else {
      bar.textContent = t('net.offline')
      bar.classList.remove('hidden')
    }
  }
  mux.connect()
  mux.open('workspace/follow', {}, {
    onItem: (frame) => {
      if (frame?.type === 'baseline') {
        state.workspaces.clear()
        state.archived = new Set(frame.value?.archivedSessionIds || [])
        for (const w of frame.value?.items || []) {
          state.workspaces.set(w.workspaceId, w)
        }
        refreshSessions()
      } else if (frame?.type === 'upsert') {
        state.workspaces.set(frame.workspace.workspaceId, frame.workspace)
        refreshSessions()
      } else if (frame?.type === 'remove') {
        state.workspaces.delete(frame.workspaceId)
        renderRoute()
      } else if (frame?.type === 'order') {
        // 排序信息 v0.1 忽略（按 updatedAt 排序）
      } else if (frame?.type === 'archived') {
        state.archived = new Set(frame.archivedSessionIds)
        renderRoute()
      }
    },
  })
  refreshSessions()

  // 标签栏点击
  for (const btn of document.querySelectorAll('#tabbar .tab')) {
    btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.route}` })
  }
  renderRoute()
}

boot()
