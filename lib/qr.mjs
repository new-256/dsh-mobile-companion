/**
 * qr.mjs — 零依赖 QR Code 编码器（dsh-mobile-companion）。
 * 基于 bot-gateway lib/qrcode.js 的已验证实现（jsQR 回环测试通过）扩展：
 *   - 版本 1-13（级别 M，最大 ~332 字节，覆盖配对载荷）
 *   - 多分组块结构（v8+ 的 [[2,38],[2,39]] 形态）
 *   - 任意校正图形中心表（v7+ 三个中心）
 *   - v≥7 的版本信息块（BCH(18,6)，生成多项式 0x1F25）
 *
 * 导出：
 *   qrMatrix(text)      -> boolean[][]   模块矩阵（true=黑）
 *   qrSvg(text, opts)   -> string        SVG（浏览器/Node 皆可）
 *   qrPng(text, opts)   -> Buffer        PNG（仅 Node，用 node:zlib）
 *   qrCapacity          -> number        v13-M 最大字节数
 *
 * opts: { ec 固定 'M', scale: 4, quiet: 4, dark: '#000', light: '#fff' }
 * 实现遵循 ISO/IEC 18004；表数据从 jsQR@1.4.0 权威表提取（tools/dump-qr-tables.mjs）。
 */

import { deflateSync } from 'node:zlib'
import { VERSIONS_M } from './qr-tables.mjs'

const MAX_VERSION = 13
/** 字节模式长度字段位数：v1-9 = 8bit，v10-40 = 16bit（ISO/IEC 18004） */
const lenBitsOf = (v) => (v <= 9 ? 8 : 16)
/** 各版本实际可容纳字节数（含模式/计数/终止符开销） */
const capacityOf = (v) => Math.floor((dataCodewordTotal(v) * 8 - 4 - lenBitsOf(v) - 4) / 8)
export const qrCapacity = capacityOf(MAX_VERSION)

// ---------- GF(256) ----------
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x = (x << 1) ^ ((x & 0x80) ? 0x11d : 0)
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]])

// ---------- Reed-Solomon ----------
function rsGeneratorPoly(n) {
  let poly = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gmul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}
function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const rem = new Array(ecLen).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[i + 1], factor)
    }
  }
  return rem
}

// ---------- 版本选择与码字流 ----------
function dataCodewordTotal(v) {
  return VERSIONS_M[v].blocks.reduce((s, [cnt, per]) => s + cnt * per, 0)
}
function pickVersion(byteLen) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    // 模式(4bit) + 计数(8/16bit) + 数据 + 终止符(≤4bit)
    if (4 + lenBitsOf(v) + byteLen * 8 + 4 <= dataCodewordTotal(v) * 8) return v
  }
  throw new Error(`内容过长（${byteLen} 字节 > ${qrCapacity} 上限），请缩短配对载荷`)
}
function buildCodewords(bytes, version) {
  const { blocks, total, ec } = VERSIONS_M[version]
  const dataTotal = dataCodewordTotal(version)
  const numBlocks = blocks.reduce((s, [cnt]) => s + cnt, 0)

  const bits = []
  const pushBits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  pushBits(0b0100, 4)
  pushBits(bytes.length, lenBitsOf(version))
  for (const b of bytes) pushBits(b, 8)
  const terminator = Math.min(4, dataTotal * 8 - bits.length)
  pushBits(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)
  const dataCw = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    dataCw.push(b)
  }
  let pad = true
  while (dataCw.length < dataTotal) {
    dataCw.push(pad ? 0xec : 0x11)
    pad = !pad
  }

  // 分块 + RS（多分组：按 blocks 声明逐块切分）
  const dataBlocks = []
  const ecBlocks = []
  let off = 0
  for (const [cnt, per] of blocks) {
    for (let i = 0; i < cnt; i++) {
      const blk = dataCw.slice(off, off + per)
      off += per
      dataBlocks.push(blk)
      ecBlocks.push(rsEncode(blk, ec))
    }
  }
  if (total !== dataTotal + numBlocks * ec) {
    throw new Error(`版本表不一致 v${version}: total=${total} data+ec=${dataTotal + numBlocks * ec}`)
  }

  // 交织：数据码字按位置跨块，随后纠错码字
  const out = []
  const maxLen = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i])
  }
  for (let i = 0; i < ec; i++) {
    for (const blk of ecBlocks) out.push(blk[i])
  }
  return out
}

// ---------- 矩阵 ----------
function versionInfoBits(v) {
  // BCH(18,6)，生成多项式 0x1F25；结果 = (v<<12) | 余数。v7 验证 = 0x07C94。
  let rem = v << 12
  for (let bit = 17; bit >= 12; bit--) {
    if ((rem >>> bit) & 1) rem ^= 0x1f25 << (bit - 12)
  }
  return (v << 12) | rem
}

function buildMatrix(codewords, version) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(null))
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (r, c, v) => {
    modules[r][c] = !!v
    isFn[r][c] = true
  }

  // 1) 三个定位图形 + 分隔带
  const drawFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6)
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(rr, cc, inRing || inCore)
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  // 2) 校正图形：表中心的全组合，跳过与定位图形重叠的三个角
  const centers = VERSIONS_M[version].align
  for (const cr of centers) {
    for (const cc of centers) {
      if ((cr === 6 && cc === 6) || (cr === 6 && cc === centers[centers.length - 1]) || (cr === centers[centers.length - 1] && cc === 6)) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c))
          set(cr + r, cc + c, ring !== 1)
        }
      }
    }
  }

  // 3) 时序图形
  for (let i = 8; i < size - 8; i++) {
    if (!isFn[6][i]) set(6, i, i % 2 === 0)
    if (!isFn[i][6]) set(i, 6, i % 2 === 0)
  }

  // 4) 固定暗模块
  set(size - 8, 8, true)

  // 5) 预留格式信息区
  for (let i = 0; i <= 8; i++) {
    if (!isFn[8][i]) { modules[8][i] = false; isFn[8][i] = true }
    if (!isFn[i][8]) { modules[i][8] = false; isFn[i][8] = true }
  }
  for (let i = 0; i < 7; i++) {
    if (!isFn[size - 1 - i][8]) { modules[size - 1 - i][8] = false; isFn[size - 1 - i][8] = true }
  }
  for (let i = 0; i < 8; i++) {
    if (!isFn[8][size - 1 - i]) { modules[8][size - 1 - i] = false; isFn[8][size - 1 - i] = true }
  }

  // 6) 版本信息块（v≥7）
  if (version >= 7) {
    const bits = versionInfoBits(version)
    // 按解码器读取顺序放置：topRight 行 5→0、列 dim-9→dim-11（MSB 先）
    let k = 0
    for (let r = 5; r >= 0; r--) {
      for (let c = size - 9; c >= size - 11; c--) {
        set(r, c, (bits >>> (17 - k)) & 1)
        k++
      }
    }
    // bottomLeft 列 5→0、行 dim-9→dim-11（MSB 先）
    k = 0
    for (let c = 5; c >= 0; c--) {
      for (let r = size - 9; r >= size - 11; r--) {
        set(r, c, (bits >>> (17 - k)) & 1)
        k++
      }
    }
  }

  // 7) 数据 Zigzag 放置
  const bitLen = codewords.length * 8
  let bitIdx = 0
  let col = size - 1
  let upward = true
  while (col > 0) {
    if (col === 6) col--
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (!isFn[row][c]) {
          let bit = 0
          if (bitIdx < bitLen) {
            const byte = codewords[bitIdx >> 3]
            bit = (byte >> (7 - (bitIdx & 7))) & 1
          }
          modules[row][c] = !!bit
          bitIdx++
        }
      }
    }
    upward = !upward
    col -= 2
  }
  if (bitIdx > bitLen + 7) throw new Error(`数据位放置异常: ${bitIdx} > ${bitLen}+7`)
  return { size, modules, isFn }
}

// ---------- 掩码与格式信息 ----------
const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]
function formatBits(mask) {
  const data = mask // M 的 EC 位是 00
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}
function placeFormat(matrix, mask) {
  const { size, modules } = matrix
  const bits = formatBits(mask)
  const bit = (i) => (bits >>> i) & 1
  for (let i = 0; i <= 5; i++) modules[8][i] = !!bit(14 - i)
  modules[8][7] = !!bit(8)
  modules[8][8] = !!bit(7)
  modules[7][8] = !!bit(6)
  for (let r = 5; r >= 0; r--) modules[r][8] = !!bit(r)
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = !!bit(14 - i)
  for (let i = 0; i < 8; i++) modules[8][size - 8 + i] = !!bit(7 - i)
  modules[size - 8][8] = true
}

// ---------- 惩罚评分 ----------
function penalty(matrix) {
  const { size, modules } = matrix
  let score = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      let run = 1
      let prev = pass === 0 ? modules[i][0] : modules[0][i]
      for (let j = 1; j < size; j++) {
        const cur = pass === 0 ? modules[i][j] : modules[j][i]
        if (cur === prev) run++
        else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
          prev = cur
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const m = modules[r][c]
      if (modules[r][c + 1] === m && modules[r + 1][c] === m && modules[r + 1][c + 1] === m) score += 3
    }
  }
  const PAT_A = [true, false, true, true, true, false, true, false, false, false, false]
  const PAT_B = [false, false, false, false, true, false, true, true, true, false, true]
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let matchA = true, matchB = true
        for (let k = 0; k < 11; k++) {
          const v = pass === 0 ? modules[i][j + k] : modules[j + k][i]
          if (v !== PAT_A[k]) matchA = false
          if (v !== PAT_B[k]) matchB = false
        }
        if (matchA) score += 40
        if (matchB) score += 40
      }
    }
  }
  let dark = 0
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) if (modules[i][j]) dark++
  const ratio = Math.abs(dark * 100 / (size * size) - 50) / 5
  score += Math.floor(ratio) * 10
  return score
}

// ---------- 公共入口 ----------
/** 生成最终矩阵（自动选版本 + 掩码） */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text))
  const version = pickVersion(bytes.length)
  const codewords = buildCodewords(bytes, version)
  const base = buildMatrix(codewords, version)
  let best = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const { size, modules, isFn } = base
    const trial = { size, modules: modules.map((row) => row.slice()), isFn }
    placeFormat(trial, mask)
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFn[r][c] && MASK_FNS[mask](r, c)) trial.modules[r][c] = !trial.modules[r][c]
      }
    }
    const score = penalty(trial)
    if (score < bestScore) { bestScore = score; best = trial }
  }
  best.version = version
  return best.modules
}

/** SVG 输出 */
export function qrSvg(text, opts = {}) {
  const { scale = 4, quiet = 4, dark = '#000', light = '#fff' } = opts
  const modules = qrMatrix(text)
  const size = modules.length
  const full = (size + quiet * 2) * scale
  const rects = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        rects.push(`M${((c + quiet) * scale)} ${((r + quiet) * scale)}h${scale}v${scale}h-${scale}z`)
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${full}" height="${full}" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="${light}"/>` +
    `<path d="${rects.join('')}" fill="${dark}"/></svg>`
}

/** PNG 输出（仅 Node） */
export function qrPng(text, opts = {}) {
  const { scale = 4, quiet = 4, marginPx = 0 } = opts
  const modules = qrMatrix(text)
  const size = modules.length
  const full = (size + quiet * 2) * scale + marginPx * 2
  const raw = Buffer.alloc(full * full)
  raw.fill(0xff)
  const origin = marginPx + quiet * scale
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue
      const x0 = origin + c * scale
      const y0 = origin + r * scale
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) raw[(y0 + dy) * full + (x0 + dx)] = 0x00
      }
    }
  }
  // 按行滤波（filter 0）打包
  const stride = full
  const filtered = Buffer.alloc(full * (stride + 1))
  for (let y = 0; y < full; y++) {
    filtered[y * (stride + 1)] = 0
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(full, 0)
  ihdr.writeUInt32BE(full, 4)
  ihdr[8] = 8   // grayscale
  ihdr[9] = 0
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    const crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (const b of Buffer.concat([typeBuf, data])) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
