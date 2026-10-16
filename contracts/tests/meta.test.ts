import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const TESTS_DIR = import.meta.dirname

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

describe('suite hygiene', () => {
  it('C4 no case is skipped or conditioned on the stack', () => {
    const offenders: string[] = []
    for (const file of files(TESTS_DIR).filter((f) => f.endsWith('.test.ts'))) {
      if (file === import.meta.filename) continue
      const source = readFileSync(file, 'utf8')
      const patterns = [
        /\.(skip|skipIf|todo|only|runIf)\b/,
        /\b(?:xit|xdescribe|xtest)\b/,
        /stack\s*(?:===|!==|==|!=)\s*['"](?:python|node)['"]/,
        /inject\(['"]stack['"]\)/,
        /CONTRACT_STACK/,
      ]
      for (const pattern of patterns) {
        if (pattern.test(source)) offenders.push(`${relative(TESTS_DIR, file)}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
