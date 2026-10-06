/**
 * api.js — DSH Wire 协议客户端（浏览器版）。
 *
 * 一元 RPC：POST /api/<endpoint>，信封 {type:'client-request', rpcId, method, payload:{args}}
 *          响应 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}
 * 流：WebSocket /api/remote.mux
 *      → {type:'open', streamId, endpoint, payload:{args}} / {type:'cancel', streamId}
 *      ← {type:'item', streamId, value} / {type:'end', streamId} / {type:'error', streamId, error}
 *
 * Mux 自动重连（指数退避）并重放活动流；follow 端点重开时重新发送快照，
 * 上层用 seq 去重即可。
 */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

let rpcSeq = 0

/** 一元 RPC 调用 */
export async function rpc(endpoint, args = {}) {
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `m-${Date.now()}-${++rpcSeq}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (res.status === 401 || res.status === 403) throw new ApiError('unauthorized', res.status)
  let env
  try {
    env = await res.json()
  } catch {
    throw new ApiError(`HTTP ${res.status}`, res.status)
  }
  if (env?.type !== 'server-response') throw new ApiError('协议信封错误', 0)
  const result = env.result
  if (result?.ok) return result.value
  const err = result?.error || {}
  throw new ApiError(err.message || '调用失败', 0, err.code)
}

/** Cookie 认证探测（401 → 未配对） */
export async function authCheck() {
  try {
    const res = await fetch('/api/mobile/pair-info', { credentials: 'include' })
    return res.status === 200
  } catch {
    return false
  }
}

export class Mux {
  constructor() {
    this.ws = null
    this.streams = new Map() // streamId -> {endpoint, args, handlers, closed}
    this.nextId = 1
    this.backoff = 800
    this.alive = false
    this.onstatus = null // (state: 'connecting'|'open'|'closed') => void
  }

  connect() {
    if (this.alive) return
    this.alive = true
    this._open()
  }

  _open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.onstatus?.('connecting')
    const ws = new WebSocket(`${proto}//${location.host}/api/remote.mux`)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 800
      this.onstatus?.('open')
      for (const [id, s] of this.streams) {
        if (!s.closed) ws.send(JSON.stringify({ type: 'open', streamId: id, endpoint: s.endpoint, payload: { args: s.args } }))
      }
    }
    ws.onmessage = (ev) => {
      let frame
      try {
        frame = JSON.parse(ev.data)
      } catch {
        return
      }
      const s = this.streams.get(frame.streamId)
      if (!s) return
      if (frame.type === 'item') s.handlers.onItem?.(frame.value)
      else if (frame.type === 'end') {
        s.closed = true
        this.streams.delete(frame.streamId)
        s.handlers.onEnd?.()
      } else if (frame.type === 'error') {
        s.handlers.onError?.(frame.error || {})
      }
    }
    ws.onclose = () => {
      this.onstatus?.('closed')
      if (!this.alive) return
      setTimeout(() => { if (this.alive) this._open() }, this.backoff)
      this.backoff = Math.min(this.backoff * 2, 15000)
    }
    ws.onerror = () => { /* onclose 兜底重连 */ }
  }

  /** 打开流。返回 streamId。 */
  open(endpoint, args, handlers = {}) {
    const id = `s${this.nextId++}`
    this.streams.set(id, { endpoint, args, handlers, closed: false })
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'open', streamId: id, endpoint, payload: { args } }))
    }
    return id
  }

  cancel(id) {
    const s = this.streams.get(id)
    if (!s) return
    s.closed = true
    this.streams.delete(id)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel', streamId: id }))
    }
  }

  dispose() {
    this.alive = false
    for (const id of [...this.streams.keys()]) this.cancel(id)
    try {
      this.ws?.close()
    } catch { /* ignore */ }
  }
}

/** uuid（crypto.randomUUID 不可用时的回退） */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
