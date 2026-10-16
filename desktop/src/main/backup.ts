import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Backups kept after a successful migration. */
export const KEPT_BACKUPS = 3

interface Options<T> {
  userData: string
  /** Starts the backend on `userData/db`; resolves with how many migrations it applied. */
  run: () => Promise<T & { migrationsApplied: number }>
  now?: () => number
}

// ISO 8601 without ':' and '.', which Windows does not allow in a folder name.
const stamp = (time: number) => new Date(time).toISOString().replace(/[:.]/g, '-')

async function prune(backupsDir: string): Promise<void> {
  const names = (await readdir(backupsDir)).filter((name) => /^db-/.test(name)).sort()
  for (const old of names.slice(0, Math.max(0, names.length - KEPT_BACKUPS))) {
    await rm(path.join(backupsDir, old), { recursive: true, force: true })
  }
}

/**
 * Copies the database before anything opens it (opening already rewrites files), runs the backend,
 * and keeps the copy as `backups/db-<ISO>` only if migrations ran. If the backend fails the copy is
 * put back over `db`, so the failed start leaves the database exactly as it was.
 */
export async function startWithBackup<T>({ userData, run, now = Date.now }: Options<T>): Promise<T & { migrationsApplied: number }> {
  const dbDir = path.join(userData, 'db')
  const backupsDir = path.join(userData, 'backups')
  const pending = path.join(backupsDir, '.pending')
  const hadDatabase = existsSync(dbDir)

  if (hadDatabase) {
    await mkdir(backupsDir, { recursive: true })
    await rm(pending, { recursive: true, force: true })
    await cp(dbDir, pending, { recursive: true })
  }

  let result: T & { migrationsApplied: number }
  try {
    result = await run()
  } catch (error) {
    await rm(dbDir, { recursive: true, force: true })
    if (hadDatabase) await rename(pending, dbDir)
    throw error
  }

  if (hadDatabase) {
    if (result.migrationsApplied > 0) {
      await rename(pending, path.join(backupsDir, `db-${stamp(now())}`))
      await prune(backupsDir)
    } else {
      await rm(pending, { recursive: true, force: true })
    }
  }
  return result
}
