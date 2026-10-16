import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const release = path.resolve(__dirname, '..', 'release')

/** The unpacked app that `electron-builder --dir` leaves in release/, per operating system. */
function packagedApp(): string | null {
  if (!existsSync(release)) return null
  for (const dir of readdirSync(release)) {
    const base = path.join(release, dir)
    if (dir.startsWith('mac') && existsSync(path.join(base, 'launchkit.app'))) return path.join(base, 'launchkit.app')
    if (dir === 'linux-unpacked' && existsSync(path.join(base, 'launchkit'))) return path.join(base, 'launchkit')
    if (dir === 'win-unpacked' && existsSync(path.join(base, 'launchkit.exe'))) return path.join(base, 'launchkit.exe')
  }
  return null
}

function readFuses(app: string): Record<string, boolean> {
  const output = execFileSync('npx', ['--no-install', '@electron/fuses', 'read', '--app', app], { encoding: 'utf8' })
  const fuses: Record<string, boolean> = {}
  for (const line of output.split('\n')) {
    const match = /^\s*(\w+) is (Enabled|Disabled|Removed)/i.exec(line)
    if (match) fuses[match[1]] = match[2].toLowerCase() === 'enabled'
  }
  return fuses
}

const app = packagedApp()

describe('packaged app fuses', () => {
  // `npm run package:dir` produces the app. Locally, without it there is nothing
  // to read and the test skips; in CI (CI is set) a missing app is a failure,
  // otherwise the job would pass without ever reading a fuse.
  it('packaged app fuses', (context) => {
    if (!app) {
      if (process.env.CI) expect.fail('no packaged app in release/: run `npm run package:dir` before the tests')
      context.skip()
    }
    const fuses = readFuses(app!)
    expect(fuses.RunAsNode).toBe(false)
    expect(fuses.EnableNodeCliInspectArguments).toBe(false)
    expect(fuses.EnableEmbeddedAsarIntegrityValidation).toBe(true)
    expect(fuses.OnlyLoadAppFromAsar).toBe(true)
  })
})
