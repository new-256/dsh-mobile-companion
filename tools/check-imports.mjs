// tools/check-imports.mjs — 静态验证 mobile/js 模块 import 图可解析（无 DOM 环境）
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const files = ['mobile/js/api.js', 'mobile/js/i18n.js', 'mobile/js/chat.js', 'mobile/js/plugins.js', 'mobile/js/settings.js', 'mobile/js/app.js']
let bad = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  for (const imp of imports) {
    if (!imp.startsWith('.')) continue
    const base = resolve(dirname(f), imp)
    if (!existsSync(base) && !existsSync(base + '.js') && !existsSync(base + '.mjs')) {
      console.log(`MISSING: ${f} -> ${imp}`)
      bad++
    }
  }
  console.log(`IMPORTS OK: ${f} (${imports.length})`)
}
process.exit(bad ? 1 : 0)
