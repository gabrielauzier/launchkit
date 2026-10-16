import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const DESKTOP_ROOT = path.resolve(__dirname, '../..')
export const MAIN_ENTRY = path.join(DESKTOP_ROOT, 'out/main/index.js')

/** Path of the Electron binary, for tests that start a process themselves. */
export function electronBinary(): string {
  return process.env.LAUNCHKIT_E2E_EXECUTABLE ?? (require('electron') as string) // eslint-disable-line @typescript-eslint/no-require-imports
}

/** With `LAUNCHKIT_E2E_EXECUTABLE` set, the tests drive a packaged app instead of `out/`. */
export function launchArgs(userDataDir: string): string[] {
  const userData = `--user-data-dir=${userDataDir}`
  return process.env.LAUNCHKIT_E2E_EXECUTABLE ? [userData] : [MAIN_ENTRY, userData]
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
  configPath: string
}

const launched: ElectronApplication[] = []
const tempDirs: string[] = []

export function newUserDataDir(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'launchkit-e2e-'))
  tempDirs.push(dir)
  if (config) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
  }
  return dir
}

export async function launchApp(options: { userDataDir?: string; serverUrl?: string } = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? newUserDataDir(options.serverUrl ? { serverUrl: options.serverUrl } : undefined)
  const app = await electron.launch({
    executablePath: process.env.LAUNCHKIT_E2E_EXECUTABLE,
    args: launchArgs(userDataDir),
    cwd: DESKTOP_ROOT,
  })
  launched.push(app)
  const page = await app.firstWindow()
  return { app, page, userDataDir, configPath: path.join(userDataDir, 'config.json') }
}

export function readConfig(configPath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function closeAll(): Promise<void> {
  while (launched.length) {
    const app = launched.pop()!
    await app.close().catch(() => {})
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
}
