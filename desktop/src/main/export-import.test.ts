import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportData, importData, recoverImport, type ImportHooks } from './export-import'
import type { RestoreResult } from './local-backend'
import { readZip, writeZip } from './zip'
import { checksumDir } from './test-support'

// Lets one test make the next write fail, to see what the importer leaves behind.
const failWrites = vi.hoisted(() => ({ after: -1 }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (failWrites.after === 0) throw new Error('disk full')
      if (failWrites.after > 0) failWrites.after--
      return fs.writeFileSync(...args)
    }) as typeof fs.writeFileSync,
  }
})

let root = ''
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'launchkit-export-'))
  failWrites.after = -1
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const DUMP = { sql: 'TRUNCATE "users" CASCADE;\nINSERT INTO "users" ("id") VALUES (\'1\');\n', schemaRevision: 3 }
const OK: RestoreResult = { ok: true }

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

interface Backend {
  check?: () => Promise<RestoreResult>
  restore?: (dump: typeof DUMP, id: string) => Promise<RestoreResult>
  hasImport?: (id: string) => Promise<boolean>
}

function run(source: string, filesDir: string, backend: Backend = {}, hooks?: ImportHooks, userData = path.join(root, 'userData')) {
  return importData({
    source,
    filesDir,
    userData,
    check: backend.check ?? (async () => OK),
    restore: backend.restore ?? (async () => OK),
    hasImport: backend.hasImport ?? (async () => false),
    hooks,
  })
}

const journalOf = (userData = path.join(root, 'userData')) => path.join(userData, 'import.journal.json')

describe('export and import', () => {
  it('exports manifest db.sql and files', async () => {
    const target = await exported({ 'ws/plan.pdf': '%PDF-1.4', 'a.txt': 'hello' })
    const entries = Object.fromEntries(readZip(readFileSync(target)).map((entry) => [entry.name, entry.data]))
    expect(Object.keys(entries).sort()).toEqual(['db.sql', 'files/a.txt', 'files/ws/plan.pdf', 'manifest.json'])
    expect(JSON.parse(entries['manifest.json'].toString())).toEqual({ formatVersion: 1, appVersion: '1.2.3', schemaRevision: 3 })
    expect(entries['db.sql'].toString()).toBe(DUMP.sql)
    expect(entries['files/ws/plan.pdf'].toString()).toBe('%PDF-1.4')
  })

  it('imports into a new installation, hands the backend the dump and an id, and leaves no trace of the swap', async () => {
    const target = await exported({ 'ws/plan.pdf': '%PDF-1.4', 'b.bin': 'bytes' })
    const restore = vi.fn(async () => OK)
    const filesDir = filesWith({ 'old.txt': 'original' })
    expect(await run(target, filesDir, { restore })).toEqual({ ok: true })
    expect(restore).toHaveBeenCalledWith(DUMP, expect.any(String))
    expect(readFileSync(path.join(filesDir, 'ws', 'plan.pdf'), 'utf8')).toBe('%PDF-1.4')
    expect(existsSync(path.join(filesDir, 'old.txt'))).toBe(false)
    // The old folder is removed only now that the import finished, and so is the journal.
    expect(existsSync(`${filesDir}.import-old`)).toBe(false)
    expect(existsSync(`${filesDir}.import-new`)).toBe(false)
    expect(existsSync(journalOf())).toBe(false)
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
      const check = vi.fn(async () => OK)
      expect(await run(source, filesDir, { check }), label).toEqual({ ok: false, reason: 'invalid' })
      expect(check, label).not.toHaveBeenCalled()
      expect(checksumDir(filesDir), label).toBe(before)
    }
  })

  it('a refused import writes nothing: no staging, no journal, and it never removes an old folder', async () => {
    const target = await exported()
    for (const check of [async () => ({ ok: false, reason: 'has-users' }) as RestoreResult, async () => ({ ok: false, reason: 'invalid' }) as RestoreResult]) {
      const filesDir = filesWith({ 'keep.txt': 'untouched' })
      // What a crashed import left, with no journal: it is the user's only copy.
      mkdirSync(`${filesDir}.import-old`)
      writeFileSync(path.join(`${filesDir}.import-old`, 'precious.txt'), 'original files')
      const before = { files: checksumDir(filesDir), old: checksumDir(`${filesDir}.import-old`) }
      const restore = vi.fn(async () => OK)
      const result = await run(target, filesDir, { check, restore })
      expect(result.ok).toBe(false)
      expect(restore).not.toHaveBeenCalled()
      expect({ files: checksumDir(filesDir), old: checksumDir(`${filesDir}.import-old`) }).toEqual(before)
      expect(existsSync(`${filesDir}.import-new`)).toBe(false)
      expect(existsSync(journalOf())).toBe(false)
    }
  })

  it('keeps an unsettled import-old under another name on the next import and drops a leftover staging folder', async () => {
    const target = await exported()
    const filesDir = filesWith({ 'keep.txt': 'untouched' })
    mkdirSync(`${filesDir}.import-old`)
    writeFileSync(path.join(`${filesDir}.import-old`, 'precious.txt'), 'original files')
    mkdirSync(`${filesDir}.import-new`)
    writeFileSync(path.join(`${filesDir}.import-new`, 'garbage.txt'), 'x')
    expect(await run(target, filesDir)).toEqual({ ok: true })
    const kept = readdirSync(root).filter((name) => name.includes('.import-old.'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(path.join(root, kept[0], 'precious.txt'), 'utf8')).toBe('original files')
    expect(existsSync(path.join(filesDir, 'garbage.txt'))).toBe(false)
  })

  it('puts the old files back when the restore fails, answers no or throws', async () => {
    const target = await exported()
    const cases: Backend[] = [
      { restore: async () => ({ ok: false, reason: 'invalid' }) },
      { restore: async () => { throw new Error('backend died') }, hasImport: async () => false },
    ]
    for (const backend of cases) {
      const filesDir = filesWith({ 'keep.txt': 'untouched', 'sub/deep.txt': 'x' })
      const before = checksumDir(filesDir)
      await run(target, filesDir, backend).catch(() => undefined)
      expect(checksumDir(filesDir)).toBe(before)
      expect(existsSync(`${filesDir}.import-new`)).toBe(false)
      expect(existsSync(`${filesDir}.import-old`)).toBe(false)
      expect(existsSync(journalOf())).toBe(false)
    }
  })

  it('keeps the new files when the restore threw after it had committed', async () => {
    const target = await exported({ 'new.txt': 'imported' })
    const filesDir = filesWith({ 'old.txt': 'original' })
    await expect(run(target, filesDir, { restore: async () => { throw new Error('reply lost') }, hasImport: async () => true })).rejects.toThrow('reply lost')
    expect(readFileSync(path.join(filesDir, 'new.txt'), 'utf8')).toBe('imported')
    expect(existsSync(`${filesDir}.import-old`)).toBe(false)
  })

  it('removes the staging folder when writing it fails and leaves files alone', async () => {
    const target = await exported({ 'a.txt': 'one', 'b.txt': 'two' })
    const filesDir = filesWith({ 'keep.txt': 'untouched' })
    const before = checksumDir(filesDir)
    failWrites.after = 1
    await expect(run(target, filesDir)).rejects.toThrow('disk full')
    failWrites.after = -1
    expect(existsSync(`${filesDir}.import-new`)).toBe(false)
    expect(checksumDir(filesDir)).toBe(before)
    expect(existsSync(journalOf())).toBe(false)
  })

  it('refuses a hostile archive before the check or any write', async () => {
    const manifest = { name: 'manifest.json', data: Buffer.from(JSON.stringify({ formatVersion: 1, appVersion: '1', schemaRevision: 1 })) }
    const db = { name: 'db.sql', data: Buffer.from('') }
    const one = (name: string) => ({ name, data: Buffer.from('1') })
    const hostile: Array<[string, Array<{ name: string; data: Buffer }>]> = [
      ['duplicate', [manifest, db, one('files/a'), one('files/a')]],
      ['empty segment', [manifest, db, one('files//x')]],
      ['dot segment', [manifest, db, one('files/./x')]],
      ['drive', [manifest, db, one('files/C:/x')]],
      ['stream', [manifest, db, one('files/x:ads')]],
      ['nul', [manifest, db, one('files/a\0b')]],
      ['file and folder', [manifest, db, one('files/a'), one('files/a/b')]],
      ['case collision', [manifest, db, one('files/Readme.txt'), one('files/README.TXT')]],
      ['reserved name', [manifest, db, one('files/CON')]],
      ['reserved name with extension', [manifest, db, one('files/nul.txt')]],
      ['trailing dot', [manifest, db, one('files/a.')]],
      ['trailing space', [manifest, db, one('files/a ')]],
    ]
    for (const [label, entries] of hostile) {
      const source = path.join(root, 'hostile.zip')
      writeFileSync(source, writeZip(entries))
      const filesDir = filesWith({ 'keep.txt': 'untouched' })
      const before = checksumDir(filesDir)
      const check = vi.fn(async () => OK)
      expect(await run(source, filesDir, { check }), label).toEqual({ ok: false, reason: 'invalid' })
      expect(check, label).not.toHaveBeenCalled()
      expect(checksumDir(filesDir), label).toBe(before)
    }
  })
})

describe('recovering an interrupted import', () => {
  const ORIGINAL = { 'old.txt': 'original', 'sub/o.txt': 'o' }
  const IMPORTED = { 'new.txt': 'imported' }

  /** The folders each crash point leaves, with the journal written. */
  function layout(point: 'journaled' | 'mid-swap' | 'swapped', hadFiles: boolean) {
    const filesDir = path.join(root, 'files')
    const put = (dir: string, content: Record<string, string>) => {
      for (const [name, text] of Object.entries(content)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        writeFileSync(path.join(dir, name), text)
      }
    }
    if (point === 'journaled') {
      if (hadFiles) put(filesDir, ORIGINAL)
      put(`${filesDir}.import-new`, IMPORTED)
    } else if (point === 'mid-swap') {
      if (hadFiles) put(`${filesDir}.import-old`, ORIGINAL)
      put(`${filesDir}.import-new`, IMPORTED)
    } else {
      if (hadFiles) put(`${filesDir}.import-old`, ORIGINAL)
      put(filesDir, IMPORTED)
    }
    mkdirSync(path.join(root, 'userData'), { recursive: true })
    writeFileSync(journalOf(), JSON.stringify({ id: 'abc', hadFiles }))
    return filesDir
  }

  it('after a crash, files and database are both before or both after', async () => {
    for (const hadFiles of [true, false]) {
      for (const point of ['journaled', 'mid-swap', 'swapped'] as const) {
        for (const committed of [false, true]) {
          // The commit only happens after the swap.
          if (committed && point !== 'swapped') continue
          rmSync(root, { recursive: true, force: true })
          mkdirSync(root, { recursive: true })
          const filesDir = layout(point, hadFiles)
          await recoverImport({ userData: path.join(root, 'userData'), filesDir, hasImport: async (id) => id === 'abc' && committed })
          const label = `${point} hadFiles=${hadFiles} committed=${committed}`
          if (committed) {
            expect(readFileSync(path.join(filesDir, 'new.txt'), 'utf8'), label).toBe('imported')
            expect(existsSync(path.join(filesDir, 'old.txt')), label).toBe(false)
          } else if (hadFiles) {
            expect(readFileSync(path.join(filesDir, 'old.txt'), 'utf8'), label).toBe('original')
            expect(existsSync(path.join(filesDir, 'new.txt')), label).toBe(false)
          } else {
            expect(existsSync(filesDir), label).toBe(false)
          }
          expect(existsSync(`${filesDir}.import-old`), label).toBe(false)
          expect(existsSync(`${filesDir}.import-new`), label).toBe(false)
          expect(existsSync(journalOf()), label).toBe(false)
        }
      }
    }
  })

  it('without a journal it drops a staging folder and keeps an old one', async () => {
    const filesDir = path.join(root, 'files')
    mkdirSync(`${filesDir}.import-new`, { recursive: true })
    mkdirSync(`${filesDir}.import-old`, { recursive: true })
    writeFileSync(path.join(`${filesDir}.import-old`, 'x'), 'x')
    await recoverImport({ userData: path.join(root, 'userData'), filesDir, hasImport: async () => false })
    expect(existsSync(`${filesDir}.import-new`)).toBe(false)
    expect(existsSync(path.join(`${filesDir}.import-old`, 'x'))).toBe(true)
  })
})
