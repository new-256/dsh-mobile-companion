/**
 * lib/ws-framing.mjs — 零依赖 WebSocket 帧编解码（客户端侧）。
 *
 * 仅包含隧道客户端所需的最小子集：文本/二进制帧编码、帧解析、握手。
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { request } from 'node:http'
import { request as sRequest } from 'node:https'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 生成 base64 随机 Sec-WebSocket-Key */
export function wsKey() {
  return randomBytes(16).toString('base64')
}

/** 计算 Sec-WebSocket-Accept */
export function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 编码一条 WS 帧 */
export function encodeWSFrame(opcode, payload, { mask = false } = {}) {
  const len = payload.length
  let headerLen = 2
  if (len >= 65536) headerLen += 8
  else if (len >= 126) headerLen += 2
  if (mask) headerLen += 4
  const frame = Buffer.allocUnsafe(headerLen + len)
  frame[0] = 0x80 | (opcode & 0x0f)
  let off = 2
  if (len >= 65536) {
    frame[1] = (mask ? 0x80 : 0) | 127
    frame.writeBigUInt64BE(BigInt(len), 2)
    off = 10
  } else if (len >= 126) {
    frame[1] = (mask ? 0x80 : 0) | 126
    frame.writeUInt16BE(len, 2)
    off = 4
  } else {
    frame[1] = (mask ? 0x80 : 0) | len
  }
  if (mask) {
    const key = randomBytes(4)
    key.copy(frame, off)
    for (let i = 0; i < len; i++) {
      frame[off + 4 + i] = payload[i] ^ key[i % 4]
    }
  } else {
    payload.copy(frame, off)
  }
  return frame
}

export function encodeText(text) { return encodeWSFrame(0x01, Buffer.from(text, 'utf8')) }
export function encodeBinary(payload) { return encodeWSFrame(0x02, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)) }
export function encodePing(payload = Buffer.alloc(0)) { return encodeWSFrame(0x09, payload) }
export function encodePong(payload = Buffer.alloc(0)) { return encodeWSFrame(0x0a, payload) }
export function encodeClose(code = 1000, reason = '') {
  const rbuf = Buffer.from(reason, 'utf8')
  const payload = Buffer.allocUnsafe(2 + rbuf.length)
  payload.writeUInt16BE(code, 0)
  rbuf.copy(payload, 2)
  return encodeWSFrame(0x08, payload)
}

/** 解析 buffer 中的所有 WS 帧 */
export function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let len = second & 0x7f
    let headerLen = 2
    if (len === 126) {
      if (offset + 4 > buffer.length) break
      len = buffer.readUInt16BE(offset + 2)
      headerLen = 4
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break
      len = Number(buffer.readBigUInt64BE(offset + 2))
      headerLen = 10
    }
    let maskKey = null
    if (masked) {
      if (offset + headerLen + 4 > buffer.length) break
      maskKey = buffer.slice(offset + headerLen, offset + headerLen + 4)
      headerLen += 4
    }
    if (offset + headerLen + len > buffer.length) break
    let payload = buffer.slice(offset + headerLen, offset + headerLen + len)
    if (masked && maskKey) {
      payload = Buffer.from(payload)
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    }
    frames.push({ fin, opcode, masked, maskKey, payload })
    offset += headerLen + len
  }
  return { frames, rest: buffer.slice(offset) }
}

/** 建立 outbound WSS/WS 连接 */
export function clientWSConnect(url, extraHeaders = {}) {
  const u = new URL(url)
  const isSecure = u.protocol === 'wss:'
  const key = wsKey()
  const headers = {
    'Host': u.host,
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...extraHeaders,
  }
  const path = u.pathname + u.search

  return new Promise((resolve, reject) => {
    const req = (isSecure ? sRequest : request)({
      hostname: u.hostname,
      port: u.port || (isSecure ? 443 : 80),
      method: 'GET',
      path,
      headers,
      createConnection: (opts) => connect({ host: opts.hostname, port: opts.port }),
    })

    req.on('error', reject)
    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept']
      if (accept !== wsAccept(key)) {
        socket.destroy()
        return reject(new Error('Sec-WebSocket-Accept 不匹配'))
      }
      resolve({ socket, head })
    })
    req.on('response', (res) => {
      reject(new Error(`WS 握手收到非 101 响应: ${res.statusCode}`))
    })
    req.end()
  })
}
