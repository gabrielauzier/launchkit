import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportData, importData } from './export-import'
import { readZip, writeZip } from './zip'
import { checksumDir } from './test-support'

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'launchkit-export-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const DUMP = { sql: "TRUNCATE \"users\" CASCADE;\nINSERT INTO \"users\" (\"id\") VALUES ('1');\n", schemaRevision: 3 }

function filesWith(content: Record<string, string>) {
  const dir = path.join(root, `files-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(content)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text)
  }
  return dir
}

async function exported(files: Record<string, string> = { 'ws/plan.pdf': '%PDF-1.4' }) {
  const target = path.join(root, 'export.zip')
  await exportData({ dump: async () => DUMP, filesDir: filesWith(files), appVersion: '1.2.3', target })
  return target
}

describe('export and import', () => {
  it('exports manifest db.sql and files', async () => {
    const target = await exported({ 'ws/plan.pdf': '%PDF-1.4', 'a.txt': 'hello' })
    const entries = Object.fromEntries(readZip(readFileSync(target)).map((entry) => [entry.name, entry.data]))
    expect(Object.keys(entries).sort()).toEqual(['db.sql', 'files/a.txt', 'files/ws/plan.pdf', 'manifest.json'])
    expect(JSON.parse(entries['manifest.json'].toString())).toEqual({ formatVersion: 1, appVersion: '1.2.3', schemaRevision: 3 })
    expect(entries['db.sql'].toString()).toBe(DUMP.sql)
    expect(entries['files/ws/plan.pdf'].toString()).toBe('%PDF-1.4')
  })

  it('imports into a new installation and restores the counts', async () => {
    const target = await exported({ 'ws/plan.pdf': '%PDF-1.4', 'b.bin': 'bytes' })
    const restore = vi.fn(async () => ({ ok: true as const }))
    const filesDir = path.join(root, 'new-files')
    expect(await importData({ source: target, filesDir, restore })).toEqual({ ok: true })
    expect(restore).toHaveBeenCalledWith(DUMP)
    expect(readFileSync(path.join(filesDir, 'ws', 'plan.pdf'), 'utf8')).toBe('%PDF-1.4')
    expect(readFileSync(path.join(filesDir, 'b.bin'), 'utf8')).toBe('bytes')
  })

  it('refuses a file that is not a valid export and changes nothing', async () => {
    const good = readFileSync(await exported())
    const manifest = (formatVersion: number) => ({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ formatVersion, appVersion: '1', schemaRevision: 1 })) })
    const cases: Array<[string, Buffer]> = [
      ['plain text', Buffer.from('this is not a zip file at all')],
      ['truncated zip', good.subarray(0, Math.floor(good.length / 2))],
      ['formatVersion 2', writeZip([manifest(2), { name: 'db.sql', data: Buffer.from('') }])],
      ['no db.sql', writeZip([manifest(1)])],
      ['entry escaping the folder', writeZip([manifest(1), { name: 'db.sql', data: Buffer.from('') }, { name: 'files/../../evil', data: Buffer.from('x') }])],
      ['corrupt bytes', Buffer.concat([good.subarray(0, 40), Buffer.from('CORRUPT'), good.subarray(47)])],
    ]
    for (const [label, bytes] of cases) {
      const source = path.join(root, 'bad.zip')
      writeFileSync(source, bytes)
      const filesDir = filesWith({ 'keep.txt': 'untouched' })
      const before = checksumDir(filesDir)
      const restore = vi.fn(async () => ({ ok: true as const }))
      expect(await importData({ source, filesDir, restore }), label).toEqual({ ok: false, reason: 'invalid' })
      expect(restore, label).not.toHaveBeenCalled()
      expect(checksumDir(filesDir), label).toBe(before)
    }
  })

  it('refuses to import when the database already has users', async () => {
    const target = await exported()
    const filesDir = filesWith({ 'mine.txt': 'existing' })
    const before = checksumDir(filesDir)
    const restore = vi.fn(async () => ({ ok: false as const, reason: 'has-users' as const }))
    expect(await importData({ source: target, filesDir, restore })).toEqual({ ok: false, reason: 'not-new' })
    expect(checksumDir(filesDir)).toBe(before)
  })
})
