// Fails when a built bundle reaches for the desktop bridge: the web build may
// only ask `window.launchkit?.isDesktop` (always undefined in a browser).
// Usage: node scripts/check-web-bundle.mjs <build output directory>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: check-web-bundle.mjs <directory>')
  process.exit(2)
}

function* scripts(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) yield* scripts(full)
    else if (/\.(js|mjs|cjs)$/.test(name)) yield full
  }
}

let files = 0
const violations = []
for (const file of scripts(root)) {
  files += 1
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/window\.launchkit(?!\?\.isDesktop)/g)) {
    violations.push(`${file}: ${text.slice(Math.max(0, match.index - 30), match.index + 60).replace(/\s+/g, ' ')}`)
  }
}

if (files === 0) {
  console.error(`no scripts found in ${root}`)
  process.exit(2)
}
if (violations.length > 0) {
  console.error(`The bundle references window.launchkit beyond ?.isDesktop (${violations.length}):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`ok: ${files} scripts, no window.launchkit reference besides ?.isDesktop`)
