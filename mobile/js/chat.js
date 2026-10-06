/**
 * chat.js — 会话聊天视图。
 *
 * 数据流：
 *   session/follow（mux 流，assistantStream: true）
 *     · snapshot → 渲染尾部历史（records）+ projections（标题）
 *     · event    → 追加持久事件（seq 去重）
 *     · assistant-stream → start/chunk/end 实时增量（临时渲染，提交后由 event 取代）
 *   session/page（一元 RPC）→ 上拉加载更早消息（throughSeq = 当前最早 seq）
 *   session/prompt → 发消息（mode: 'queue'）
 *   session/cancel → 停止生成
 */

import { rpc, uuid } from './api.js'
import { t } from './i18n.js'
import { $, h, toast, state, fmtBytes } from './app.js'

export let activeChat = null

/** 附件单文件上限（与服务端 imageLimits/批策略同量级，超出即在前端拦下） */
const MAX_ATTACH_BYTES = 25 * 1024 * 1024

/** 事件 → 可显示的消息块列表 */
function eventToBlocks(ev) {
  const type = ev.type
  const data = ev.data
  if (type === 'user/message') {
    const text = (data?.content || []).map((c) => {
      if (c.type === 'text') return c.text
      if (c.type === 'file') return `📎 ${c.attachment?.name || '文件'}`
      if (c.type === 'image') return '[图片]'
      return `[${c.type}]`
    }).join(' ')
    return [{ kind: 'user', text, meta: '' }]
  }
  if (type === 'assistant/message') {
    const text = (data?.message?.content || []).map((c) => {
      if (c.type === 'text') return c.text
      if (c.type === 'image') return '[图片]'
      return `[${c.type}]`
    }).join('')
    const model = data?.message?.source?.model ? ` · ${data.message.source.model}` : ''
    return [{ kind: 'ai', text, meta: model }]
  }
  if (type === 'system/message') {
    const text = (data?.message?.content || []).map((c) => c.text || '').join('')
    if (!text) return []
    return [{ kind: 'sys', text, meta: '' }]
  }
  if (type === 'tool/call') {
    const name = data?.name || data?.toolName || 'tool'
    const argPreview = JSON.stringify(data?.arguments || data?.args || '').slice(0, 80)
    return [{ kind: 'tool', text: `${name} ${argPreview}`, meta: '' }]
  }
  if (type === 'tool/result') {
    const name = data?.message?.source?.callId || ''
    const inner = (data?.message?.content?.[0]?.content || [])
      .map((c) => c.text || '').join('').slice(0, 100)
    return [{ kind: 'tool', text: `✓ ${name} ${inner}`, meta: '' }]
  }
  if (type === 'assistant/attempt') return [] // 草稿，最终消息由 assistant/message 呈现
  if (type === 'request/header') {
    const cfg = data?.header?.config || {}
    return [{ kind: 'sys', text: `⚙ ${cfg.provider || ''}/${cfg.model || ''}`, meta: '' }]
  }
  if (type === 'turn/start' || type === 'turn/end') return []
  if (type === 'error') {
    return [{ kind: 'sys', text: `⚠ ${typeof data === 'string' ? data : (data?.message || JSON.stringify(data).slice(0, 120))}`, meta: '' }]
  }
  return [{ kind: 'sys', text: `· ${type}`, meta: '' }]
}

function renderBlock(b) {
  if (b.kind === 'user') return h('div', { class: 'msg user', 'data-seq': b.seq }, h('div', { class: 'bubble' }, b.text || ' ', b.meta ? h('span', { class: 'meta' }, b.meta) : null))
  if (b.kind === 'ai') return h('div', { class: 'msg ai', 'data-seq': b.seq }, h('div', { class: 'bubble' }, b.text || ' ', b.meta ? h('span', { class: 'meta' }, b.meta) : null))
  if (b.kind === 'sys') return h('div', { class: 'msg sys', 'data-seq': b.seq }, h('div', { class: 'bubble' }, b.text))
  return h('div', { class: 'toolrow', 'data-seq': b.seq }, h('b', null, '🔧 '), b.text)
}

export function openChat(view, sessionId) {
  if (!sessionId) { location.hash = '#/sessions'; return }
  const chat = { sessionId, closed: false, oldestSeq: null, hasMore: false, loadingOlder: false, seqSeen: new Set(), streamId: null, running: false }
  activeChat = chat

  // ── 布局 ──
  const titleEl = h('h1', null, t('common.loading'))
  const scroll = h('div', { class: 'chat-scroll' })
  const hint = h('div', { class: 'chat-hint hidden' })
  const ta = h('textarea', { placeholder: t('chat.inputPh'), rows: '1' })
  const sendBtn = h('button', { class: 'sendbtn', onclick: () => send() }, t('chat.send'))
  const stopBtn = h('button', { class: 'stopbtn hidden', onclick: () => stop() }, t('chat.stop'))

  // ── 附件：拍照 / 相册 / 文件 ──────────────────────────────────────────
  // 通道：POST /api/session/uploadFileBinary?sessionId=&name=（原始字节，Cookie 鉴权）
  //       → { receiptId, file:{attachmentId,name,bytes} }
  // 发送：content 里带 { type:'file', receiptId }，由宿主解析为暂存附件
  //       （见 dsh-api-session-controller resolvePromptFileReceipts）
  const attach = []
  const clipBtn = h('button', { class: 'clipbtn', title: t('chat.attach'), onclick: () => fileInput.click() }, '📎')
  const chips = h('div', { class: 'attach-chips hidden' })
  const fileInput = h('input', { type: 'file', class: 'hidden', multiple: true, accept: 'image/*,.pdf,.txt,.md,.json,.csv,.log,.zip' })
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files || []) void uploadOne(f)
    fileInput.value = ''
  })

  const renderChips = () => {
    chips.replaceChildren(...attach.map((a) => h('span', { class: `attach-chip ${a.status}` },
      h('span', { class: 'ac-name' }, a.name),
      h('span', { class: 'ac-size' }, a.status === 'uploading' ? t('chat.attachUploading') : fmtBytes(a.bytes)),
      h('button', { class: 'ac-del', onclick: () => { const i = attach.indexOf(a); if (i >= 0) attach.splice(i, 1); renderChips() } }, '×'),
    )))
    chips.classList.toggle('hidden', attach.length === 0)
  }

  async function uploadOne(file) {
    if (file.size > MAX_ATTACH_BYTES) {
      toast(t('chat.attachTooBig').replace('{n}', fmtBytes(MAX_ATTACH_BYTES)))
      return
    }
    const item = { name: file.name || 'file', bytes: file.size, status: 'uploading' }
    attach.push(item)
    renderChips()
    try {
      const q = new URLSearchParams({ sessionId })
      if (file.name) q.set('name', file.name)
      const res = await fetch(`/api/session/uploadFileBinary?${q.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        credentials: 'include',
        body: file,
      })
      if (res.status === 401 || res.status === 403) throw new Error(t('chat.attachAuth'))
      const data = await res.json().catch(() => null)
      if (!data?.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`)
      item.receiptId = data.receiptId
      item.bytes = data.file?.bytes ?? file.size
      item.status = 'ready'
    } catch (e) {
      item.status = 'error'
      toast(`${item.name}: ${e.message || String(e)}`)
    }
    renderChips()
  }

  const composer = h('div', { class: 'composer' }, clipBtn, ta, sendBtn, stopBtn)
  view.replaceChildren(h('div', { class: 'chat-wrap' },
    h('div', { class: 'pagehead' },
      h('button', { class: 'iconbtn', onclick: () => { location.hash = '#/sessions' } }, '‹'),
      titleEl,
      h('button', { class: 'iconbtn', title: t('chat.archive'), onclick: () => actionsSheet() }, '⋯'),
    ),
    scroll, chips, composer, fileInput,
  ))

  ta.addEventListener('input', () => {
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
  })

  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80
  const autoScroll = () => { scroll.scrollTop = scroll.scrollHeight }

  // ── 实时增量渲染 ──
  let liveEl = null
  let liveText = ''
  const clearLive = () => { liveEl?.remove(); liveEl = null; liveText = '' }
  const appendLiveChunk = (chunk) => {
    if (typeof chunk === 'string') liveText += chunk
    else if (chunk && typeof chunk === 'object') liveText += (chunk.text ?? chunk.delta ?? JSON.stringify(chunk))
    if (!liveEl) {
      liveEl = h('div', { class: 'msg ai' }, h('div', { class: 'live-bubble' }, liveText || h('span', { class: 'typing-dots' }, h('i'), h('i'), h('i'))))
      scroll.append(liveEl)
    } else {
      liveEl.firstElementChild.textContent = liveText
    }
    autoScroll()
  }

  // ── 事件渲染（持久，seq 去重）──
  const appendEvent = (ev, prepend = false) => {
    if (chat.seqSeen.has(ev.seq)) return
    chat.seqSeen.add(ev.seq)
    if (chat.oldestSeq === null || ev.seq < chat.oldestSeq) chat.oldestSeq = ev.seq
    for (const b of eventToBlocks(ev)) {
      b.seq = ev.seq
      const el = renderBlock(b)
      if (prepend) scroll.prepend(el)
      else {
        // live 增量在提交后由持久事件取代
        if (b.kind === 'ai' && liveEl) clearLive()
        scroll.append(el)
        if (atBottom() || b.kind === 'user') autoScroll()
      }
    }
  }

  // ── follow 流 ──
  const mux = state.mux
  chat.streamId = mux.open('session/follow', {
    request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 60 },
  }, {
    onItem: (frame) => {
      if (chat.closed) return
      if (frame?.type === 'snapshot') {
        scroll.replaceChildren()
        chat.seqSeen = new Set()
        chat.oldestSeq = null
        clearLive()
        const title = frame.projections?.values?.title
        if (title) titleEl.textContent = title
        else titleEl.textContent = t('chat.newTask')
        const records = (frame.records || []).slice().sort((a, b) => a.event.seq - b.event.seq)
        for (const r of records) appendEvent(r.event)
        chat.hasMore = !!frame.hasMore
        hint.textContent = chat.hasMore ? t('chat.loadOlder') : t('chat.noMore')
        hint.classList.toggle('hidden', !chat.hasMore)
        scroll.prepend(hint)
        autoScroll()
        updateRunning(frame.projections?.values)
      } else if (frame?.type === 'event') {
        appendEvent(frame.event)
        const title = frame.event.type === 'user/message'
        // 标题更新懒加载：返回列表时刷新
      } else if (frame?.type === 'assistant-stream') {
        const f = frame.frame || frame
        if (f.type === 'start') { liveText = ''; appendLiveChunk('') }
        else if (f.type === 'chunk') appendLiveChunk(f.chunk)
        else if (f.type === 'end') { /* 提交事件随后到达；短暂保留 live */ }
      }
    },
    onError: (err) => {
      if (chat.closed) return
      scroll.append(h('div', { class: 'chat-hint' }, `⚠ ${err.message || '流错误'}`))
    },
  })

  // ── 运行状态投影（复用 session/list 简化实现：跟随 events 推断）──
  const updateRunning = () => {
    const s = state.sessions.get(sessionId)
    chat.running = !!s?.running
    stopBtn.classList.toggle('hidden', !chat.running)
    sendBtn.classList.toggle('hidden', chat.running)
  }
  updateRunning()

  // ── 上拉加载更早 ──
  scroll.addEventListener('scroll', () => {
    if (scroll.scrollTop < 60 && chat.hasMore && !chat.loadingOlder && chat.oldestSeq !== null) {
      chat.loadingOlder = true
      const prevHeight = scroll.scrollHeight
      rpc('session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq: chat.oldestSeq, maxMessages: 50 },
      }).then((page) => {
        const records = (page?.records || []).slice().sort((a, b) => a.event.seq - b.event.seq)
        for (const r of records) appendEvent(r.event, true)
        chat.hasMore = !!page?.hasMore && records.length > 0
        hint.textContent = chat.hasMore ? t('chat.loadOlder') : t('chat.noMore')
        // 保持滚动位置
        scroll.scrollTop = scroll.scrollHeight - prevHeight + scroll.scrollTop
      }).catch(() => { /* 静默 */ })
        .finally(() => { chat.loadingOlder = false })
    }
  })

  // ── 发送 / 停止 ──
  async function send() {
    const text = ta.value.trim()
    const ready = attach.filter((a) => a.status === 'ready')
    if (!text && ready.length === 0) return
    if (attach.some((a) => a.status === 'uploading')) return void toast(t('chat.attachUploading'))
    const failed = attach.filter((a) => a.status === 'error')
    if (failed.length) {
      // 上传失败的附件不能进 prompt（宿主会报 FILE_NOT_STAGED），先清掉再发
      for (const f of failed) attach.splice(attach.indexOf(f), 1)
      renderChips()
    }
    ta.value = ''
    ta.style.height = 'auto'
    try {
      await rpc('session/prompt', {
        request: {
          requestId: uuid(),
          sessionId,
          mode: 'queue',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...ready.map((a) => ({ type: 'file', receiptId: a.receiptId })),
          ],
        },
      })
      attach.length = 0
      renderChips()
    } catch (e) {
      const msg = e.message || String(e)
      toast(msg)
      ta.value = text
      // 回执是一次性的：被宿主拒绝后必须重新添加附件
      if (/attachment|receipt|staged|附件/i.test(msg)) {
        attach.length = 0
        renderChips()
        toast(t('chat.attachRetry'))
      }
    }
  }

  async function stop() {
    try {
      await rpc('session/cancel', { request: { sessionId } })
      toast('已请求停止')
    } catch (e) { toast(e.message || String(e)) }
  }

  function actionsSheet() {
    import('./app.js').then(({ sheet }) => {
      sheet({
        title: titleEl.textContent,
        body: h('div', null,
          h('button', { class: 'btn', onclick: async () => {
            try {
              await rpc('workspace/archiveSession', { request: { sessionId } })
              toast(t('sessions.archived'))
              location.hash = '#/sessions'
            } catch (e) { toast(e.message) }
          } }, t('chat.archive')),
          h('button', { class: 'btn danger', onclick: async () => {
            try {
              const res = await fetch('/api/session-cleaner/delete', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, confirm: 'DELETE' }),
              })
              const data = await res.json()
              if (!data.success) throw new Error(data.error)
              toast('已移入回收站')
              location.hash = '#/sessions'
            } catch (e) { toast(e.message) }
          } }, t('chat.delete')),
        ),
      })
    })
  }

  // 返回列表时刷新标题
  chat.close = () => {
    chat.closed = true
    if (chat.streamId && mux) mux.cancel(chat.streamId)
    clearLive()
    import('./app.js').then(({ refreshSessions }) => refreshSessions())
    if (activeChat === chat) activeChat = null
  }
}
