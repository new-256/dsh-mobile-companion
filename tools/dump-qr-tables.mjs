// dump-qr-tables.mjs — 从 jsQR.cjs 提取 QR 版本表（级别 M，v1-13）为紧凑 JS 源
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

// jsQR.cjs 的 VERSIONS 表未通过 bundle 导出 —— 从源文本提取对象字面量并求值
const src = readFileSync('C:/Users/lcl/Desktop/DSH/bot-gateway/test/jsQR.cjs', 'utf8')
const start = src.indexOf('exports.VERSIONS = [')
if (start < 0) throw new Error('VERSIONS table not found in jsQR.cjs')
const arrStart = src.indexOf('[', start)
// 括号配平截取完整数组字面量（表中只有数字/null，无含括号字符串）
let depth = 0, arrEnd = -1
for (let i = arrStart; i < src.length; i++) {
  if (src[i] === '[') depth++
  else if (src[i] === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break } }
}
const literal = src.slice(arrStart, arrEnd)
const jsQR = { VERSIONS: new Function(`return (${literal})`)() }

const lines = []
lines.push('// 由 tools/dump-qr-tables.mjs 从 jsQR@1.4.0 权威表生成（级别 M，v1-13）')
lines.push('// blocks: [[numBlocks, dataCodewordsPerBlock], ...]；align: 校正图形中心坐标')
lines.push('export const VERSIONS_M = {')
for (const v of jsQR.VERSIONS.slice(0, 13)) {
  const m = v.errorCorrectionLevels[1] // jsQR 顺序 [L, M, Q, H]
  const blocks = m.ecBlocks.map((b) => `[${b.numBlocks}, ${b.dataCodewordsPerBlock}]`).join(', ')
  const total = m.ecBlocks.reduce((s, b) => s + b.numBlocks * (b.dataCodewordsPerBlock + m.ecCodewordsPerBlock), 0)
  const data = m.ecBlocks.reduce((s, b) => s + b.numBlocks * b.dataCodewordsPerBlock, 0)
  lines.push(`  ${v.versionNumber}: { ec: ${m.ecCodewordsPerBlock}, blocks: [${blocks}], total: ${total}, data: ${data}, align: [${v.alignmentPatternCenters.join(', ')}] },`)
}
lines.push('}')
writeFileSync('C:/Users/lcl/Desktop/DSH/plugins/mobile-companion/lib/qr-tables.mjs', lines.join('\n') + '\n')
console.log('written. capacities (bytes, level M):')
for (const v of jsQR.VERSIONS.slice(0, 13)) {
  const m = v.errorCorrectionLevels[1]
  const data = m.ecBlocks.reduce((s, b) => s + b.numBlocks * b.dataCodewordsPerBlock, 0)
  const cap = Math.floor((data * 8 - 4 - 8 - 4) / 8)
  console.log(`  v${v.versionNumber}: ${data} data cw, ~${cap} bytes payload`)
}
