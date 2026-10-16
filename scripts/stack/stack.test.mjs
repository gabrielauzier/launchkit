// Proofs C1-C6 (and, later, C7, C17, C18): the Compose stacks. Run one case with
//   node --test --test-name-pattern='^C1 ' scripts/stack/stack.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dockerLogs, project, waitForHealth } from './lib.mjs'

const NODE_SERVICES = ['backend-node', 'db', 'frontend', 'redis', 'scheduler-node', 'worker-node']
const PYTHON_SERVICES = ['backend', 'celery-beat', 'celery-worker', 'db', 'frontend', 'redis']
const TABLES = ['app_settings', 'files', 'user_passkeys', 'users', 'workspace_members', 'workspaces']
const TIMEOUT = { timeout: 900_000 }

async function upAndWait(name, options) {
  const p = await project(name, options)
  try {
    p.up()
    const body = await waitForHealth(p.frontend)
    return { p, body }
  } catch (error) {
    console.error(dockerLogs(name))
    p.down()
    throw error
  }
}

test('C1 BACKEND_STACK=node starts the six Node services and no Python service', TIMEOUT, async () => {
  const { p } = await upAndWait('c1', { stack: 'node' })
  try {
    assert.deepEqual(p.running(), NODE_SERVICES)
    for (const python of ['backend', 'celery-worker', 'celery-beat']) assert.ok(!p.running().includes(python))
  } finally {
    p.down()
  }
})

for (const [label, stack] of [['python', 'python'], ['absent', undefined]]) {
  test(`C2 BACKEND_STACK ${label} starts the six Python services and no Node service`, TIMEOUT, async () => {
    const { p } = await upAndWait(`c2-${label}`, { stack })
    try {
      assert.deepEqual(p.running(), PYTHON_SERVICES)
    } finally {
      p.down()
    }
  })
}

test('C3 BACKEND_STACK=go fails before creating containers and says why', TIMEOUT, async () => {
  const p = await project('c3', { stack: 'go' })
  try {
    const result = p.run(['up', '--build', '-d'])
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /BACKEND_STACK must be python or node \(got: go\)/)
    assert.equal(p.must(['ps', '-a', '-q']).trim(), '')
  } finally {
    p.down()
  }
})

test('C4 BACKEND_STACK=node answers /api/health through the frontend and the frontend reaches http://backend:8000', TIMEOUT, async () => {
  const { p, body } = await upAndWait('c4', { stack: 'node' })
  try {
    assert.deepEqual(body, { status: 'healthy' })
    const inside = p.must(['exec', '-T', 'frontend', 'node', '-e', "fetch('http://backend:8000/api/health').then(async r => console.log(r.status, await r.text()))"])
    assert.match(inside.trim(), /^200 \{"status":"healthy"\}$/)
  } finally {
    p.down()
  }
})

test('C5 on an empty database the six tables exist at the first 200 and a restart reruns the migration without DDL', TIMEOUT, async () => {
  const p = await project('c5', { stack: 'node' })
  try {
    p.up()
    await waitForHealth(p.frontend)
    const tables = () => p.sql("select table_name from information_schema.tables where table_schema='public' order by 1").split('\n')
    assert.deepEqual(tables(), TABLES)
    // pg_dump >= 16.10 writes a random \restrict token on every run.
    const dump = () =>
      p
        .must(['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'launchkit', '--schema-only', '--schema=public'])
        .split('\n')
        .filter((line) => !/^\\(un)?restrict /.test(line))
        .join('\n')
    const before = dump()
    p.must(['restart', 'backend-node'])
    await waitForHealth(p.frontend)
    const applied = p.must(['logs', '--no-color', 'backend-node']).match(/migrations applied/g) ?? []
    assert.equal(applied.length, 2)
    assert.equal(dump(), before)
    assert.deepEqual(tables(), TABLES)
  } finally {
    p.down()
  }
})

test('C6 a failing migration exits non-zero and the API never starts', TIMEOUT, async () => {
  const p = await project('c6', { stack: 'node' })
  try {
    p.must(['up', '--build', '-d', '--wait', 'db', 'redis'])
    const result = p.run(['run', '--rm', '--no-deps', '-e', 'DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/does_not_exist', 'backend-node'])
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout + result.stderr, /listening/i)
  } finally {
    p.down()
  }
})
