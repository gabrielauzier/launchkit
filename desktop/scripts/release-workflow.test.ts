import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const file = path.resolve(__dirname, '../../.github/workflows/desktop-release.yml')
const text = readFileSync(file, 'utf8')
const workflow = parse(text) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('desktop-release workflow', () => {
  it('release workflow shape', () => {
    expect(workflow.on.push.tags).toEqual(['desktop-v*'])
    const job = workflow.jobs['desktop-release']
    expect(job.strategy.matrix.os.slice().sort()).toEqual(['macos-latest', 'ubuntu-latest', 'windows-latest'])
    expect(job.strategy['fail-fast']).toBe(false)
    expect(job['runs-on']).toBe('${{ matrix.os }}')
    // Publishes through electron-builder to the configurable repository.
    const publish = job.steps.find((step: { run?: string }) => step.run?.includes('--publish always'))
    expect(publish, 'a publish step').toBeDefined()
    expect(text).toContain('vars.LAUNCHKIT_DESKTOP_RELEASE_REPO')
    expect(publish.env.GH_TOKEN).toContain('secrets.')
    expect(job.permissions.contents).toBe('write')
  })

  it('signs only when the signing secrets exist', () => {
    const job = workflow.jobs['desktop-release']
    const sign = job.steps.find((step: { env?: Record<string, string> }) => step.env?.CSC_LINK)
    expect(sign.env.CSC_LINK).toContain('secrets.')
    expect(sign.env.APPLE_ID).toContain('secrets.')
    expect(text).toContain('LAUNCHKIT_DESKTOP_SIGNED')
  })
})
