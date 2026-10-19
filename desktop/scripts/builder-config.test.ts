import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const config = parse(readFileSync(path.resolve(__dirname, '../electron-builder.yml'), 'utf8')) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function targetNames(section: unknown): string[] {
  const targets = (section as { target?: unknown[] }).target ?? []
  return targets.map((target) => (typeof target === 'string' ? target : (target as { target: string }).target))
}

describe('electron-builder config', () => {
  it('builder targets and app id', () => {
    expect(config.appId).toBe('com.launchkit.desktop')
    expect(targetNames(config.mac).sort()).toEqual(['dmg', 'zip'])
    expect(targetNames(config.win)).toEqual(['nsis'])
    expect(targetNames(config.linux).sort()).toEqual(['AppImage', 'deb'])
  })

  it('does not depend on release variables, so unpublished builds need none', () => {
    expect(config.publish).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain('${env.LAUNCHKIT_DESKTOP_RELEASE')
  })

  it('ships the desktop frontend as an extra resource named frontend', () => {
    expect(config.extraResources).toContainEqual({ from: '../frontend/dist-desktop', to: 'frontend' })
  })

  it('reads signing from the environment instead of embedding it', () => {
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(JSON.stringify(config)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  })
})
