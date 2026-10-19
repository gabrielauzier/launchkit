// Proofs C12-C16 (select-stack), always on a throwaway clone of HEAD.
//   node --test --test-name-pattern='^C12 ' scripts/stack/select-stack.test.mjs
// C14 honours ONLY_STACK=python|node (the CI matrix runs one stack per job).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, containerArgs, dockerRun } from './lib.mjs'

const SCOPE = ['docker-compose.yml', 'docker-compose.prod.yml', 'compose', '.github', 'charts', 'README.md', 'CONTRIBUTING.md', 'mise.toml', 'renovate.json', '.pre-commit-config.yaml']
const PYTHON_WORDS = 'celery|alembic|uvicorn|pytest|ruff'
const NODE_WORDS = 'fastify|drizzle|bullmq'
// Pinned so a local run and the CI run use the same tools.
export const HELM_IMAGE = 'alpine/helm:4.3.0'
export const ACTIONLINT_IMAGE = 'rhysd/actionlint:1.7.12'

function copy() {
  const dir = mkdtempSync(join(tmpdir(), 't02-select-'))
  const clone = spawnSync('git', ['clone', '-q', '--no-hardlinks', ROOT, dir], { encoding: 'utf8' })
  assert.equal(clone.status, 0, clone.stderr)
  return dir
}

function select(dir, ...args) {
  return spawnSync('node', ['scripts/select-stack.mjs', ...args], { cwd: dir, encoding: 'utf8' })
}

function grepScope(dir, words) {
  const paths = SCOPE.filter((p) => existsSync(join(dir, p)))
  const result = spawnSync('grep', ['-rIlE', words, '--exclude=package-lock.json', ...paths], { cwd: dir, encoding: 'utf8' })
  return result.stdout.split('\n').filter(Boolean)
}

const docker = dockerRun

test('C12 select-stack node removes backend/ and contracts/ and leaves no Python word in scope', () => {
  const dir = copy()
  const result = select(dir, '--stack', 'node')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!existsSync(join(dir, 'backend')))
  assert.ok(!existsSync(join(dir, 'contracts')))
  assert.ok(existsSync(join(dir, 'backend-node/src/db/migrate.ts')))
  assert.deepEqual(grepScope(dir, PYTHON_WORDS), [])
})

test('C13 select-stack python removes backend-node/ and contracts/ and leaves no Node word in scope', () => {
  const dir = copy()
  const result = select(dir, '--stack', 'python')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!existsSync(join(dir, 'backend-node')))
  assert.ok(!existsSync(join(dir, 'contracts')))
  assert.ok(existsSync(join(dir, 'backend/app')))
  assert.deepEqual(grepScope(dir, NODE_WORDS), [])
})

for (const stack of ['python', 'node']) {
  if (process.env.ONLY_STACK && process.env.ONLY_STACK !== stack) continue
  test(`C14 after select-stack ${stack}: compose config, helm lint, actionlint and the CI tests pass`, { timeout: 600_000 }, () => {
    const dir = copy()
    const result = select(dir, '--stack', stack)
    assert.equal(result.status, 0, result.stderr)
    const env = { ...process.env }
    delete env.BACKEND_STACK
    const compose = spawnSync('docker', ['compose', 'config', '-q'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(compose.status, 0, compose.stderr)
    const prod = spawnSync('docker', ['compose', '-f', 'docker-compose.prod.yml', 'config', '-q'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(prod.status, 0, prod.stderr)
    // The CI job runs on a copy without usable git metadata: actionlint refuses to look for
    // workflows then ("no project was found"), so nothing below may depend on .git.
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    const lint = docker(dir, HELM_IMAGE, ['lint', 'charts/launchkit'])
    assert.equal(lint.status, 0, lint.stdout + lint.stderr)
    const workflows = readdirSync(join(dir, '.github/workflows')).map((name) => `.github/workflows/${name}`)
    const actionlint = docker(dir, ACTIONLINT_IMAGE, workflows)
    assert.equal(actionlint.status, 0, actionlint.stdout + actionlint.stderr)
    for (const file of ['test_changes.py', 'test_workflow_jobs.py']) {
      const py = spawnSync('python3', [`.github/ci/${file}`], { cwd: dir, encoding: 'utf8' })
      assert.equal(py.status, 0, `${file}\n${py.stdout}${py.stderr}`)
    }
  })
}

test('C14 the copy handed to a container is readable by another user', () => {
  const dir = copy() // mkdtemp creates it 0700; the clone's files can be 0600 under a restrictive umask
  chmodSync(dir, 0o700)
  chmodSync(join(dir, '.github/workflows/release.yml'), 0o600)
  assert.equal(statSync(dir).mode & 0o055, 0, 'precondition: restrictive copy')
  const args = containerArgs(dir)
  assert.equal(statSync(dir).mode & 0o055, 0o055)
  assert.equal(statSync(join(dir, '.github/workflows/release.yml')).mode & 0o044, 0o044)
  assert.deepEqual(args.slice(0, 2), ['--user', `${process.getuid()}:${process.getgid()}`])
})

test('C15 no --stack or an invalid value exits 2 with the usage', () => {
  const dir = copy()
  for (const args of [[], ['--stack', 'go'], ['--stack']]) {
    const result = select(dir, ...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /python\|node/)
  }
})

test('C15 a stack that is already the only one present exits 0 with "already selected" and changes nothing', () => {
  for (const stack of ['python', 'node']) {
    const dir = copy()
    assert.equal(select(dir, '--stack', stack).status, 0)
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout
    const again = select(dir, '--stack', stack)
    assert.equal(again.status, 0, again.stderr)
    assert.equal(again.stdout.trim(), `already selected: ${stack}`)
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout, before)
  }
})

test('C16 a working tree with uncommitted changes exits 1, says so and deletes nothing', () => {
  for (const dirty of [(dir) => appendFileSync(join(dir, 'README.md'), 'edit\n'), (dir) => writeFileSync(join(dir, 'untracked.txt'), 'x\n')]) {
    const dir = copy()
    dirty(dir)
    const result = select(dir, '--stack', 'node')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /working tree not clean/)
    for (const kept of ['backend', 'backend-node', 'contracts']) assert.ok(existsSync(join(dir, kept)), kept)
  }
})
