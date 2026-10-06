// test-qr.mjs — jsQR 回环测试：对 v1-13 每个版本生成 QR 并解码验证
import { qrPng, qrSvg, qrMatrix, qrCapacity } from '../lib/qr.mjs'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const jsqrPath = 'C:/Users/lcl/Desktop/DSH/bot-gateway/test/jsQR.cjs'
if (!existsSync(jsqrPath)) {
  console.log('⊘ 跳过：jsQR.cjs 不存在')
  process.exit(0)
}
const require = createRequire(import.meta.url)
const jsQR = require(jsqrPath)

// PNG 解码（灰度 8bit）：解析 IHDR + IDAT
function pngToGray(png) {
  let off = 8
  let w = 0, h = 0, colorType = 0
  const idat = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = colorType === 0 ? w : w * 4
  const out = { w, h, gray: new Uint8Array(w * h) }
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < w; x++) {
      let v = row[colorType === 0 ? x : x * 4]
      if (filter === 1) v = (v + (x > 0 ? out.gray[y * w + x - 1] : 0)) & 0xff
      else if (filter === 2) v = (v + (y > 0 ? out.gray[(y - 1) * w + x] : 0)) & 0xff
      else if (filter === 3) v = (v + Math.floor(((x > 0 ? out.gray[y * w + x - 1] : 0) + (y > 0 ? out.gray[(y - 1) * w + x] : 0)) / 2)) & 0xff
      else if (filter === 4) {
        const a = x > 0 ? out.gray[y * w + x - 1] : 0
        const b = y > 0 ? out.gray[(y - 1) * w + x] : 0
        const c = x > 0 && y > 0 ? out.gray[(y - 1) * w + x - 1] : 0
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      out.gray[y * w + x] = v
    }
  }
  return out
}

// 测试负载：每个版本的边界长度（该版本容量 -1）+ 真实配对载荷
const cases = []
const dataTotal = { 1:16,2:28,3:44,4:64,5:86,6:108,7:124,8:154,9:182,10:216,11:254,12:290,13:334 }
const capOf = (v) => Math.floor((dataTotal[v] * 8 - 4 - (v <= 9 ? 8 : 16) - 4) / 8)
for (let v = 1; v <= 13; v++) {
  cases.push('x'.repeat(Math.max(1, capOf(v) - 1)))
}
// 实际配对负载样例（URL 与 JSON 两种形态）
const token = 'a'.repeat(48)
cases.push(`http://192.168.1.5:47896/?token=${token}`)
cases.push(JSON.stringify({ v: 1, type: 'dsh-pair', name: 'OFFICE-PC', host: '192.168.1.5', port: 47896, urls: ['http://192.168.1.5:47896'], token }))
cases.push(JSON.stringify({ v: 1, type: 'dsh-pair', name: '云服务器-01', host: '10.0.0.8', port: 47896, urls: ['http://10.0.0.8:47896', 'http://100.64.12.34:47896'], token: 'b'.repeat(64), relay: { url: 'wss://relay.example.com', instanceId: 'cloud-01' } }))

let failed = 0
for (const text of cases) {
  const png = qrPng(text, { scale: 4, quiet: 4 })
  const { w, h, gray } = pngToGray(png)
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const g = gray[i]
    rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255
  }
  const result = jsQR(rgba, w, h)
  const ok = result && result.data === text
  if (!ok) { failed++; console.log(`✗ FAIL len=${text.length}: ${result ? 'decode mismatch: ' + JSON.stringify(result.data.slice(0, 60)) : 'undecodable'}`) }
  else console.log(`✓ OK len=${text.length} (v${result.version || '?'})`)
}
console.log(failed === 0 ? `\n全部通过（${cases.length} 例，含 v1-13 边界 + 真实配对载荷）容量上限 ${qrCapacity} 字节` : `\n${failed} 例失败`)
process.exit(failed === 0 ? 0 : 1)
