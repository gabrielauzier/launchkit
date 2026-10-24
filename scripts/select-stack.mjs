#!/usr/bin/env node
// Leaves a project made from this template with one backend stack.
//
//   node scripts/select-stack.mjs --stack python|node
//
// Exit codes: 0 done (or already selected), 1 failure (including a dirty working tree), 2 usage.
//
// What it does, in order:
//   1. deletes the other stack's directories and the files that only make sense with both stacks;
//   2. in every tracked text file, handles blocks fenced by lines that contain
//        select-stack:begin <python|node|multi>   ...   select-stack:end
//      a block is kept (markers removed, `#~ text` lines turned into `text`) when it names the
//      chosen stack and dropped otherwise; `multi` blocks are always dropped;
//   3. resolves the chart's stack conditionals and the BACKEND_STACK include in the Compose files;
//   4. edits renovate.json.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STACKS = ['python', 'node']
const USAGE = 'Usage: node scripts/select-stack.mjs --stack python|node'

const REMOVE = {
  python: ['backend-node', 'contracts', 'compose/dev/node.yml', 'compose/prod/node.yml', 'scripts/stack'],
  node: ['backend', 'contracts', 'compose/dev/python.yml', 'compose/prod/python.yml', 'scripts/stack', '.pre-commit-config.yaml'],
}
// Never rewritten: documentation, the other source trees, lockfiles and this tool.
const SKIP_PREFIXES = ['docs/', '.tasks/', '.checks/', 'backend/', 'backend-node/', 'contracts/', 'frontend/', 'scripts/stack/', 'scripts/select-stack.mjs']

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  let stack
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stack') stack = argv[(i += 1)]
    else if (arg.startsWith('--stack=')) stack = arg.slice('--stack='.length)
    else fail(2, `Unknown option: ${arg}\n${USAGE}`)
  }
  if (!STACKS.includes(stack)) fail(2, `${stack === undefined ? 'Missing --stack' : `Unsupported stack: ${stack}`}\n${USAGE}`)
  return stack
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

export function applyMarkers(text, stack) {
  const out = []
  let block = null
  for (const line of text.split('\n')) {
    const begin = line.match(/select-stack:begin\s+(python|node|multi)\b/)
    if (begin) {
      block = begin[1]
      continue
    }
    if (block !== null && /select-stack:end\b/.test(line)) {
      block = null
      continue
    }
    if (block === null) out.push(line)
    else if (block === stack) out.push(line.replace(/^(\s*)#~ ?/, '$1'))
  }
  return out.join('\n')
}

const STACK_IF =
  /(\{\{-?)\s*if eq \(include "launchkit\.backendStack" \.\) "node"\s*(-?\}\})([\s\S]*?)(\{\{-?)\s*else\s*(-?\}\})([\s\S]*?)(\{\{-?)\s*end\s*(-?\}\})/

/** Resolves `{{ if eq (include "launchkit.backendStack" .) "node" }}A{{ else }}B{{ end }}` with Go's trim rules. */
export function resolveChart(text, stack) {
  let result = text
  for (let match = STACK_IF.exec(result); match; match = STACK_IF.exec(result)) {
    const [whole, open, afterIf, ifBody, openElse, afterElse, elseBody, openEnd, afterEnd] = match
    let before = result.slice(0, match.index)
    let after = result.slice(match.index + whole.length)
    if (open === '{{-') before = before.replace(/\s+$/, '')
    if (afterEnd === '-}}') after = after.replace(/^\s+/, '')
    let chosen
    if (stack === 'node') {
      chosen = ifBody
      if (afterIf === '-}}') chosen = chosen.replace(/^\s+/, '')
      if (openElse === '{{-') chosen = chosen.replace(/\s+$/, '')
    } else {
      chosen = elseBody
      if (afterElse === '-}}') chosen = chosen.replace(/^\s+/, '')
      if (openEnd === '{{-') chosen = chosen.replace(/\s+$/, '')
    }
    result = before + chosen + after
  }
  result = result.replaceAll(
    '{{ include "launchkit.backendImage" . }}',
    '{{ .Values.backend.image.repository }}:{{ .Values.backend.image.tag }}',
  )
  if (stack === 'node') {
    result = result
      .replaceAll('celeryWorker', 'worker')
      .replaceAll('celeryBeat', 'scheduler')
      .replaceAll('Celery Worker', 'Worker')
      .replaceAll('Celery Beat', 'Scheduler')
  }
  return result
}

export function editRenovate(text, stack) {
  if (stack !== 'node') return text
  const config = JSON.parse(text)
  config.packageRules = (config.packageRules ?? []).filter((rule) => !(rule.matchManagers ?? []).includes('pep621'))
  config.customManagers = (config.customManagers ?? []).filter(
    (manager) => !(manager.fileMatch ?? []).some((pattern) => pattern.includes('backend/')),
  )
  if (config.customManagers.length === 0) delete config.customManagers
  return `${JSON.stringify(config, null, 2)}\n`
}

function main() {
  const stack = parseArgs(process.argv.slice(2))
  const other = stack === 'python' ? 'node' : 'python'
  const dirs = { python: 'backend', node: 'backend-node' }

  if (existsSync(join(ROOT, dirs[stack])) && !existsSync(join(ROOT, dirs[other]))) {
    console.log(`already selected: ${stack}`)
    return
  }
  if (!existsSync(join(ROOT, dirs[stack]))) fail(1, `select-stack: ${dirs[stack]}/ does not exist, nothing to select`)

  let dirty
  try {
    dirty = git('status', '--porcelain')
  } catch {
    fail(1, 'select-stack: not a git working tree')
  }
  if (dirty.trim() !== '') fail(1, 'working tree not clean')

  const tracked = git('ls-files', '-z').split('\0').filter(Boolean)

  for (const path of REMOVE[stack]) rmSync(join(ROOT, path), { recursive: true, force: true })

  let updated = 0
  for (const path of tracked) {
    const file = join(ROOT, path)
    if (!existsSync(file) || SKIP_PREFIXES.some((prefix) => path.startsWith(prefix)) || path.endsWith('package-lock.json')) continue
    const buffer = readFileSync(file)
    if (buffer.includes(0)) continue
    const original = buffer.toString('utf8')
    let text = applyMarkers(original, stack)
    if (path.startsWith('charts/')) text = resolveChart(text, stack)
    if (/^docker-compose.*\.yml$/.test(path)) text = text.replaceAll('${BACKEND_STACK:-python}', stack)
    if (path === 'renovate.json') text = editRenovate(text, stack)
    if (text !== original) {
      writeFileSync(file, text)
      updated += 1
    }
  }

  for (const path of tracked) {
    if (!path.startsWith('charts/') || !existsSync(join(ROOT, path))) continue
    if (readFileSync(join(ROOT, path), 'utf8').includes('launchkit.backendStack')) fail(1, `select-stack: unresolved stack conditional in ${path}`)
  }

  console.log(`selected: ${stack}`)
  console.log(`removed: ${REMOVE[stack].join(', ')}`)
  console.log(`updated: ${updated} files`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    fail(1, `select-stack failed: ${error instanceof Error ? error.message : error}`)
  }
}
