import type { Database } from '../db/client.ts'
import { getAppSetting } from './settings.ts'

/** `is_valid_timezone`: an IANA name the runtime can load, spelled with its canonical capitals. */
export function isValidTimezone(name: string): boolean {
  if (!/^[A-Z]/.test(name)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** `timezone_names`: every zone a person can pick, sorted. */
export function timezoneNames(): string[] {
  return [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])].sort()
}

/** `environment_timezone`: `TZ`, else the host zone, else UTC. */
export function environmentTimezone(): string {
  for (const name of [process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    if (name && isValidTimezone(name)) return name
  }
  return 'UTC'
}

/** The raw saved application timezone, valid or not, or null when nothing is saved. */
export async function savedTimezoneName(db: Database): Promise<string | null> {
  return (await getAppSetting(db, 'timezone')) || null
}

/** `get_timezone`: the saved zone when it loads, else the environment's. */
export async function applicationTimezone(db: Database): Promise<string> {
  const saved = await savedTimezoneName(db)
  return saved && isValidTimezone(saved) ? saved : environmentTimezone()
}
