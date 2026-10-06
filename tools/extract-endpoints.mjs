#!/usr/bin/env node
/**
 * extract-endpoints.mjs — 从已安装的 dsh 包中提取 Typert Remote 端点定义 v2，
 * 含全部端点（stream 在内）、参数 wire 名、取消支持、以及参数/结果 zod schema 源文本。
 * 用法: node extract-endpoints.mjs <backend-root> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const backendRoot = process.argv[2]
const outPath = process.argv[3]
if (!backendRoot || !outPath) {
  console.error('usage: node extract-endpoints.mjs <backend-root> <out.json>')
  process.exit(1)
}

const NM = join(backendRoot, 'node_modules', '@deepseek-ai')
const PACKAGES = [
  'dsh-api-session-controller',
  'dsh-api-workspace-controller',
  'dsh-api-settings-controller',
  'dsh-host-plugin-inventory',
]

// 提取全部 zod schema 常量定义: const NAME = z.object({...})
// 以「下一个 ^const 或 ^export」为边界截取（括号配平会被字符串中的括号干扰）
function extractSchemaConsts(src) {
  const consts = {}
  const re = /^const (_[A-Za-z0-9_$]+) = /gm
  let m
  while ((m = re.exec(src)) !== null) {
    const next = re.exec(src) // 先看下一个匹配（注意 lastIndex 状态）
    const end = next ? next.index : src.length
    re.lastIndex = m.index + m[0].length // 恢复当前扫描位置
    consts[m[1]] = src.slice(m.index, end).trim().replace(/,?$/, '')
  }
  return consts
}

function resolveSchemaRef(text, consts, depth = 0) {
  // 把 schema 文本里引用的常量展开（一层即可，防循环）
  if (depth > 2 || !text) return text
  return text.replace(/(_[A-Za-z0-9_$]+)(?![\w$])/g, (name) => {
    if (!consts[name] || name.startsWith('_schema')) return name
    // 避免递归展开自身
    if (consts[name] === text) return name
    return `/*${name}*/ ` + resolveSchemaRef(consts[name], consts, depth + 1)
  })
}

function extractPackage(pkg) {
  const file = join(NM, pkg, 'lib', 'typert.host.js')
  let src
  try { src = readFileSync(file, 'utf8') } catch { return { error: 'not found' } }
  const consts = extractSchemaConsts(src)
  const endpoints = []
  // 每个 invocation: 从 "id: 'pkg#endpoint'" 开始，到 "sourceLocation" 结束
  const re = /id:\s*'[^']*#([^']+)',\s*\n\s*service:\s*'([^']+)',\s*\n\s*namespace:\s*'([^']+)',\s*\n\s*method:\s*'([^']+)',\s*\n(?:\s*mode:\s*'([^']+)',\s*\n)?\s*invocation:\s*\{([\s\S]*?)\},\s*\n\s*parameters:\s*\[([\s\S]*?)\],\s*\n(?:\s*cancellation:\s*\{([^}]*)\},\s*\n)?\s*result:\s*\{([\s\S]*?)\},\s*\n\s*sourceLocation:/g
  let m
  while ((m = re.exec(src)) !== null) {
    const [, endpoint, service, namespace, method, modeRaw, invocationRaw, paramsRaw, cancellationRaw, resultRaw] = m
    const params = []
    // 参数块: { name: '...', wire: '...', source: '...', codec: { mode, ..., schema: VAR } }
    const pre = /\{\s*name:\s*'([^']+)',\s*wire:\s*'([^']+)',\s*source:\s*'([^']+)',[\s\S]*?schema:\s*([A-Za-z0-9_$]+)/g
    let pm
    while ((pm = pre.exec(paramsRaw)) !== null) {
      const [, name, wire, source, schemaVar] = pm
      params.push({ name, wire, source, schema: consts[schemaVar] ? resolveSchemaRef(consts[schemaVar], consts) : schemaVar })
    }
    const isStream = /mode:\s*'stream'/.test(resultRaw)
    const resultSchemaVar = (resultRaw.match(/schema:\s*([A-Za-z0-9_$]+)/) || [])[1]
    endpoints.push({
      endpoint,
      namespace,
      method,
      service,
      stream: isStream,
      cancellable: Boolean(cancellationRaw),
      invocation: /kind:\s*'context'/.test(invocationRaw) ? 'context' : 'direct',
      params,
      resultSchema: consts[resultSchemaVar] ? resolveSchemaRef(consts[resultSchemaVar], consts) : (resultSchemaVar || null),
    })
  }
  return { endpoints }
}

const result = { generatedAt: new Date().toISOString(), packages: {} }
for (const pkg of PACKAGES) result.packages[pkg] = extractPackage(pkg)

writeFileSync(outPath, JSON.stringify(result, null, 2))
const total = Object.values(result.packages).reduce((n, p) => n + (p.endpoints?.length || 0), 0)
console.log(`extracted ${total} endpoints -> ${outPath}`)
for (const [pkg, p] of Object.entries(result.packages)) {
  console.log(`  ${pkg}: ${p.endpoints?.length ?? 0}`)
  for (const e of p.endpoints || []) console.log(`    ${e.endpoint}${e.stream ? ' [stream]' : ''}(${e.params.map((x) => x.wire).join(', ')})`)
}
