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
    expect(config.publish.provider).toBe('github')
  })

  it('takes the release repository from the environment', () => {
    expect(config.publish.owner).toBe('${env.LAUNCHKIT_DESKTOP_RELEASE_OWNER}')
    expect(config.publish.repo).toBe('${env.LAUNCHKIT_DESKTOP_RELEASE_REPO_NAME}')
  })

  it('ships the desktop frontend as an extra resource named frontend', () => {
    expect(config.extraResources).toContainEqual({ from: '../frontend/dist-desktop', to: 'frontend' })
  })

  it('reads signing from the environment instead of embedding it', () => {
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(JSON.stringify(config)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  })

  it('declares the launchkit protocol', () => {
    expect(config.protocols).toContainEqual({ name: 'launchkit', schemes: ['launchkit'] })
  })
})
