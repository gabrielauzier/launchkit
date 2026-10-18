import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DataDump, RestoreResult } from './local-backend'
import { readZip, writeZip, ZipError, type ZipEntry } from './zip'

export const FORMAT_VERSION = 1

export interface Manifest {
  formatVersion: number
  appVersion: string
  schemaRevision: number
}

function listFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else found.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  try {
    walk(root)
  } catch {
    // no uploads yet
  }
  return found
}

/** Writes `manifest.json`, `db.sql` and `files/` into a zip at `target` (via a temporary name, so a failure leaves nothing half written). */
export async function exportData(options: { dump: () => Promise<DataDump>; filesDir: string; appVersion: string; target: string }): Promise<void> {
  const dump = await options.dump()
  const manifest: Manifest = { formatVersion: FORMAT_VERSION, appVersion: options.appVersion, schemaRevision: dump.schemaRevision }
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'db.sql', data: Buffer.from(dump.sql) },
    ...listFiles(options.filesDir).map((relative) => ({ name: `files/${relative}`, data: readFileSync(path.join(options.filesDir, relative)) })),
  ]
  const temporary = `${options.target}.partial`
  writeFileSync(temporary, writeZip(entries))
  renameSync(temporary, options.target)
}

export type ImportResult = { ok: true } | { ok: false; reason: 'invalid' | 'not-new' }

/** Reads and checks the archive without touching anything; null when it is not a valid export. */
function parseExport(source: string): { manifest: Manifest; sql: string; files: ZipEntry[] } | null {
  let entries: ZipEntry[]
  try {
    entries = readZip(readFileSync(source))
  } catch (error) {
    if (error instanceof ZipError || error instanceof RangeError) return null
    throw error
  }
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  const dbEntry = entries.find((entry) => entry.name === 'db.sql')
  if (!manifestEntry || !dbEntry) return null
  let manifest: Manifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as Manifest
  } catch {
    return null
  }
  if (manifest.formatVersion !== FORMAT_VERSION || !Number.isInteger(manifest.schemaRevision)) return null
  return { manifest, sql: dbEntry.data.toString('utf8'), files: entries.filter((entry) => entry.name.startsWith('files/') && !entry.name.endsWith('/')) }
}

/**
 * Imports an export into a new installation. Nothing is touched until the archive and its manifest
 * check out; the backend then restores the database all or nothing and refuses one that has users,
 * and only after that the files are written.
 */
export async function importData(options: {
  source: string
  filesDir: string
  restore: (dump: DataDump) => Promise<RestoreResult>
}): Promise<ImportResult> {
  const parsed = parseExport(options.source)
  if (!parsed) return { ok: false, reason: 'invalid' }
  const restored = await options.restore({ sql: parsed.sql, schemaRevision: parsed.manifest.schemaRevision })
  if (!restored.ok) return { ok: false, reason: restored.reason === 'has-users' ? 'not-new' : 'invalid' }
  for (const entry of parsed.files) {
    const target = path.join(options.filesDir, ...entry.name.slice('files/'.length).split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
  return { ok: true }
}
