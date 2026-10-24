import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPackagedApp } from './packaged-app'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function releaseWith(entry: string, file: string) {
  const release = mkdtempSync(path.join(tmpdir(), 'launchkit-rel-'))
  dirs.push(release)
  mkdirSync(path.join(release, entry), { recursive: true })
  writeFileSync(path.join(release, entry, file), '')
  return release
}

describe('findPackagedApp', () => {
  it('finds the Linux binary, which electron-builder names after the npm package (launchkit-desktop)', () => {
    const release = releaseWith('linux-unpacked', 'launchkit-desktop')
    expect(findPackagedApp(release)).toBe(path.join(release, 'linux-unpacked', 'launchkit-desktop'))
  })

  it('finds the macOS and Windows apps', () => {
    const mac = releaseWith('mac-arm64', 'launchkit.app')
    expect(findPackagedApp(mac)).toBe(path.join(mac, 'mac-arm64', 'launchkit.app'))
    const win = releaseWith('win-unpacked', 'launchkit.exe')
    expect(findPackagedApp(win)).toBe(path.join(win, 'win-unpacked', 'launchkit.exe'))
  })

  it('returns null when release/ is missing or holds no app', () => {
    expect(findPackagedApp(path.join(tmpdir(), 'launchkit-does-not-exist'))).toBeNull()
    expect(findPackagedApp(releaseWith('linux-unpacked', 'other'))).toBeNull()
  })
})
