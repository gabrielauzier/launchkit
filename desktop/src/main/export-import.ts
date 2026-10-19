import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * Imports an export into a new installation, all or nothing. The archive is read and checked first
 * (names, sizes, checksums, manifest); `files/` is written to a folder beside the real one and swapped
 * in, the backend then restores the database in one transaction (and refuses one that has users or a
 * dump outside the dump's grammar). Any failure swaps the old files back, so `db` and `files` end up
 * exactly as they were.
 */
export async function importData(options: {
  source: string
  filesDir: string
  restore: (dump: DataDump) => Promise<RestoreResult>
}): Promise<ImportResult> {
  const parsed = parseExport(options.source)
  if (!parsed) return { ok: false, reason: 'invalid' }

  const staging = `${options.filesDir}.import-new`
  const previous = `${options.filesDir}.import-old`
  rmSync(staging, { recursive: true, force: true })
  rmSync(previous, { recursive: true, force: true })
  try {
    mkdirSync(staging, { recursive: true })
    for (const entry of parsed.files) {
      const target = path.join(staging, ...entry.name.slice('files/'.length).split('/'))
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  const hadFiles = existsSync(options.filesDir)
  if (hadFiles) renameSync(options.filesDir, previous)
  renameSync(staging, options.filesDir)
  const revert = () => {
    rmSync(options.filesDir, { recursive: true, force: true })
    if (hadFiles) renameSync(previous, options.filesDir)
  }

  let restored: RestoreResult
  try {
    restored = await options.restore({ sql: parsed.sql, schemaRevision: parsed.manifest.schemaRevision })
  } catch (error) {
    revert()
    throw error
  }
  if (!restored.ok) {
    revert()
    return { ok: false, reason: restored.reason === 'has-users' ? 'not-new' : 'invalid' }
  }
  rmSync(previous, { recursive: true, force: true })
  return { ok: true }
}
