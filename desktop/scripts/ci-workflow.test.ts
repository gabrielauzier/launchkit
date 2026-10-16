import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Step {
  name?: string
  run?: string
  uses?: string
  if?: string
  'continue-on-error'?: boolean
}
interface Job {
  strategy?: { matrix: { os: string[] }; 'fail-fast'?: boolean }
  steps: Step[]
  'continue-on-error'?: boolean
}

const ci = parse(readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }

function commands(job: Job): string[] {
  return job.steps.flatMap((step) => (step.run ? [step.run] : []))
}

describe('ci workflow', () => {
  it('desktop-checks runs lint typecheck vitest and unsigned build', () => {
    const job = ci.jobs['desktop-checks']
    expect(job, 'desktop-checks job').toBeDefined()
    const runs = commands(job)
    for (const command of ['npm run lint', 'npm run typecheck', 'npm test', 'npm run package:dir']) {
      expect(runs, command).toContain(command)
    }
    // A failing step must fail the job.
    expect(job['continue-on-error']).toBeUndefined()
    for (const step of job.steps) expect(step['continue-on-error'], step.name).toBeUndefined()
    // No signing secret is needed to prove the app builds.
    expect(JSON.stringify(job)).not.toContain('secrets.')
  })

  it('desktop-checks guards the web bundle against window.launchkit', () => {
    const job = ci.jobs['desktop-checks']
    const guard = job.steps.findIndex((step) => step.run === 'npm run check:web-bundle')
    expect(guard, 'a check:web-bundle step').toBeGreaterThan(-1)
    expect(job.steps[guard].if).toContain('run_desktop')
    // It builds the web app, so it comes after the frontend dependencies are installed.
    expect(guard).toBeGreaterThan(job.steps.findIndex((step) => step.run?.includes('npm ci --prefix ../frontend')))
  })

  it('desktop-e2e matrix covers the three systems', () => {
    const job = ci.jobs['desktop-e2e']
    expect(job, 'desktop-e2e job').toBeDefined()
    expect([...job.strategy!.matrix.os].sort()).toEqual(['macos-latest', 'ubuntu-latest', 'windows-latest'])
    expect(job.strategy!['fail-fast']).toBe(false)
    expect(commands(job).some((command) => command.includes('playwright test'))).toBe(true)
  })

  it('both desktop jobs are gated on run_desktop', () => {
    for (const name of ['desktop-checks', 'desktop-e2e']) {
      const gated = ci.jobs[name].steps.filter((step) => step.if?.includes('run_desktop'))
      expect(gated.length, name).toBeGreaterThan(3)
    }
  })
})
