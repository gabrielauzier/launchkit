import net, { type AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { checksumDir } from '../src/main/test-support'
import { startTestServer, type TestServer } from './support/test-server'
import { closeAll, launchApp, newUserDataDir, readConfig } from './support/launch'
import { api, backendPids, backendPort, createLocalData, isAlive, listData, signIn, startLocalMode } from './support/local'

const servers: TestServer[] = []

test.afterEach(async () => {
  await closeAll()
  while (servers.length) await servers.pop()!.close()
})

const OFFLINE = ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1']

test('first launch shows the mode choice and makes no api calls', async () => {
  const { page } = await launchApp()
  await expect(page.getByRole('button', { name: 'Connect to a server' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use this computer' })).toBeVisible()
  await page.waitForTimeout(500)
  const apiCalls = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => new URL(name).pathname.startsWith('/api')),
  )
  expect(apiCalls).toEqual([])
})

test('connect to a server leads to the connect screen', async () => {
  const remote = await startTestServer()
  servers.push(remote)
  const { page, configPath } = await launchApp()
  await page.getByRole('button', { name: 'Connect to a server' }).click()
  await expect(page.getByRole('heading', { name: 'Connect to a server' })).toBeVisible()
  await page.getByLabel('Server URL').fill(remote.url)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page).toHaveURL('app://launchkit/login')
  expect(readConfig(configPath)).toMatchObject({ mode: 'remote', serverUrl: remote.url })
})

test('use this computer starts a utility process on a loopback port', async () => {
  const { app, page, userDataDir } = await launchApp()
  await startLocalMode(page)
  expect((await backendPids(app)).length).toBe(1)
  const port = backendPort(userDataDir)
  expect(port).toBeGreaterThan(1023)
  const direct = await fetch(`http://127.0.0.1:${port}/api/health`)
  expect(direct.status).toBe(401)
  expect(readConfig(path.join(userDataDir, 'config.json')).mode).toBe('local')
})

test('use this computer lands on /setup with has_users false', async () => {
  const { page } = await launchApp()
  await page.getByRole('button', { name: 'Use this computer' }).click()
  await expect(page.getByRole('progressbar')).toBeVisible()
  await expect(page).toHaveURL('app://launchkit/setup', { timeout: 45_000 })
  const status = await api(page, '/api/setup/status')
  expect(status).toEqual({ status: 200, body: { has_users: false } })
})

test('the page reaches the backend and a direct call without the token is 401', async () => {
  const { page, userDataDir } = await launchApp()
  await startLocalMode(page)
  expect((await api(page, '/api/health')).status).toBe(200)
  const port = backendPort(userDataDir)
  const bare = await fetch(`http://127.0.0.1:${port}/api/setup/status`)
  expect(bare.status).toBe(401)
  expect(await bare.json()).toEqual({ detail: 'Unauthorized' })
  const guessed = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { headers: { 'X-Launchkit-Local-Token': 'guess' } })
  expect(guessed.status).toBe(401)
})

test('the local port refuses connections on the LAN address', async () => {
  const { page, userDataDir } = await launchApp()
  await startLocalMode(page)
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  expect(lan, 'this machine has no non-internal IPv4 address to test with').toBeTruthy()
  const port = backendPort(userDataDir)
  const outcome = await new Promise<string>((resolve) => {
    const socket = net.connect({ host: lan!.address, port, timeout: 5000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve('timeout')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
  })
  expect(outcome).toBe('ECONNREFUSED')
})

test('data survives a restart with the network blocked', async () => {
  const first = await launchApp({ args: OFFLINE })
  await startLocalMode(first.page)
  const data = await createLocalData(first.page)
  const token = await signIn(first.page, data.email)
  const before = await listData(first.page, token, data.workspaceId)
  expect(JSON.stringify(before.files)).toContain('plan.pdf')
  await first.app.close()

  expect(existsSync(path.join(first.userDataDir, 'db', 'PG_VERSION'))).toBe(true)
  expect(readdirSync(path.join(first.userDataDir, 'files')).length).toBeGreaterThan(0)

  const second = await launchApp({ userDataDir: first.userDataDir, args: OFFLINE })
  // The gate holds the app back until the local backend listens.
  await expect(second.page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 45_000 })
  const again = await signIn(second.page, data.email)
  const after = await listData(second.page, again, data.workspaceId)
  expect(after).toEqual(before)
})

test('local mode opens no redis connection', async () => {
  let connections = 0
  const decoy = net.createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => decoy.listen(0, '127.0.0.1', resolve))
  try {
    const { page } = await launchApp({ env: { REDIS_URL: `redis://127.0.0.1:${(decoy.address() as AddressInfo).port}/0` } })
    await startLocalMode(page)
    await createLocalData(page)
    await page.waitForTimeout(500)
    expect(connections).toBe(0)
  } finally {
    await new Promise((resolve) => decoy.close(resolve))
  }
})

function corruptDatabase(userDataDir: string) {
  const db = path.join(userDataDir, 'db')
  mkdirSync(path.join(db, 'base'), { recursive: true })
  writeFileSync(path.join(db, 'PG_VERSION'), 'not a postgres cluster')
  writeFileSync(path.join(db, 'base', 'junk.bin'), Buffer.from('this is not a database page'.repeat(100)))
  return db
}

test('a corrupt database shows the failure screen and stays intact', async () => {
  const userDataDir = newUserDataDir({ mode: 'local' })
  const db = corruptDatabase(userDataDir)
  const before = checksumDir(db)
  const { page } = await launchApp({ userDataDir })
  await expect(page.getByText('Could not start the local backend')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open logs' })).toBeVisible()
  expect(checksumDir(db)).toBe(before)
})

test('open logs opens the logs folder and try again restarts the backend', async () => {
  const userDataDir = newUserDataDir({ mode: 'local' })
  const db = corruptDatabase(userDataDir)
  const { app, page } = await launchApp({ userDataDir })
  await expect(page.getByText('Could not start the local backend')).toBeVisible({ timeout: 60_000 })

  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __paths?: string[] }).__paths = opened
    shell.openPath = async (target: string) => {
      opened.push(target)
      return ''
    }
  })
  await page.getByRole('button', { name: 'Open logs' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { __paths?: string[] }).__paths)).toEqual([path.join(realpathSync(userDataDir), 'logs')])

  const log = readFileSync(path.join(userDataDir, 'logs', 'backend.log'), 'utf8')
  expect(log).toContain('did not start')
  expect(log.toLowerCase()).not.toContain('x-launchkit-local-token')

  // The database is repaired (here: removed); Try again starts the backend.
  rmSync(db, { recursive: true, force: true })
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page).toHaveURL('app://launchkit/setup', { timeout: 60_000 })
  const secret = readFileSync(path.join(userDataDir, 'secret.key'), 'utf8').trim()
  expect(readFileSync(path.join(userDataDir, 'logs', 'backend.log'), 'utf8')).not.toContain(secret)
})

test('quitting the app ends the backend process', async () => {
  const { app, page } = await launchApp()
  await startLocalMode(page)
  const [pid] = await backendPids(app)
  expect(pid).toBeGreaterThan(0)
  expect(isAlive(pid)).toBe(true)
  const started = Date.now()
  await app.close()
  while (isAlive(pid) && Date.now() - started < 8000) await new Promise((resolve) => setTimeout(resolve, 50))
  expect(isAlive(pid)).toBe(false)
  expect(Date.now() - started).toBeLessThan(5500)
})

test('switching server in local mode keeps the data', async () => {
  const { app, page, userDataDir } = await launchApp()
  await startLocalMode(page)
  const data = await createLocalData(page)
  const token = await signIn(page, data.email)
  const before = await listData(page, token, data.workspaceId)
  const filesBefore = checksumDir(path.join(userDataDir, 'files'))

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!.getMenuItemById('switch-server')!.click()
  })
  await expect(page).toHaveURL('app://launchkit/mode')
  await expect(page.getByRole('button', { name: 'Use this computer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect to a server' })).toBeVisible()
  expect(existsSync(path.join(userDataDir, 'db', 'PG_VERSION'))).toBe(true)
  expect(checksumDir(path.join(userDataDir, 'files'))).toBe(filesBefore)
  expect(readConfig(path.join(userDataDir, 'config.json')).mode).toBeNull()

  // The data is still there: the setup screen sends a database with users to the login.
  await page.getByRole('button', { name: 'Use this computer' }).click()
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 60_000 })
  const again = await signIn(page, data.email)
  expect(await listData(page, again, data.workspaceId)).toEqual(before)
})
