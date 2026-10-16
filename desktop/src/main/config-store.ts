import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type Config = Record<string, unknown>

function read(file: string): Config {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Config) : {}
  } catch {
    return {}
  }
}

/** `userData/config.json`: the server URL (and, later, the window bounds). */
export function createConfigStore(file: string) {
  function update(patch: Config) {
    const next = { ...read(file), ...patch }
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2))
    renameSync(temporary, file)
  }

  return {
    getServerUrl(): string | null {
      const value = read(file).serverUrl
      return typeof value === 'string' && value !== '' ? value : null
    },
    setServerUrl(url: string) {
      update({ serverUrl: url })
    },
  }
}
