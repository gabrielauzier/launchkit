import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/client.ts'
import { applyMigrations } from '../../src/db/migrate.ts'
import { InvalidDumpError, NotANewInstallationError, dumpData, restoreData } from '../../src/local/data-transfer.ts'

const open: PGlite[] = []

async function fresh(): Promise<PGlite> {
  const client = new PGlite()
  open.push(client)
  await applyMigrations(drizzle(client) as unknown as Database)
  return client
}

async function counts(client: PGlite) {
  const result = await client.query<{ table: string; n: number }>(
    `SELECT 'users' AS "table", count(*)::int AS n FROM users UNION ALL SELECT 'workspaces', count(*)::int FROM workspaces UNION ALL SELECT 'files', count(*)::int FROM files`,
  )
  return Object.fromEntries(result.rows.map((row) => [row.table, row.n]))
}

async function seed(client: PGlite) {
  await client.exec(`
    INSERT INTO users (id, email, hashed_password, is_active, is_superuser, is_verified, is_2fa_enabled, preferences) VALUES ('11111111-1111-1111-1111-111111111111', 'o''brien@example.com', 'x', true, false, true, false, '{"n":"O''Brien \\\\ q"}');
    INSERT INTO workspaces (id, name, created_by_user_id, is_archived, created_at) VALUES ('22222222-2222-2222-2222-222222222222', 'Notes', '11111111-1111-1111-1111-111111111111', false, now());
  `)
}

afterEach(async () => {
  while (open.length) await open.pop()!.close()
})

describe('data transfer', () => {
  it('dumps and restores users, workspaces and quoting into a new database', async () => {
    const source = await fresh()
    await seed(source)
    const dump = await dumpData(source)
    expect(dump.schemaRevision).toBeGreaterThan(0)

    const target = await fresh()
    await restoreData(target, dump)
    expect(await counts(target)).toEqual({ users: 1, workspaces: 1, files: 0 })
    const prefs = await target.query<{ email: string; preferences: { n: string } }>(`SELECT email, preferences FROM users`)
    expect(prefs.rows[0]).toEqual({ email: "o'brien@example.com", preferences: { n: "O'Brien \\ q" } })
  })

  it('refuses a database with users and leaves it alone', async () => {
    const source = await fresh()
    await seed(source)
    const dump = await dumpData(source)
    await expect(restoreData(source, dump)).rejects.toBeInstanceOf(NotANewInstallationError)
    expect(await counts(source)).toEqual({ users: 1, workspaces: 1, files: 0 })
  })

  it('rolls back a dump that fails halfway and refuses a newer schema', async () => {
    const target = await fresh()
    await expect(restoreData(target, { schemaRevision: 1, sql: `INSERT INTO users (id, email, hashed_password, is_active, is_superuser, is_verified, is_2fa_enabled) VALUES ('11111111-1111-1111-1111-111111111111','a@b.c','x',true,false,true,false);\nINSERT INTO nowhere VALUES (1);` })).rejects.toBeInstanceOf(InvalidDumpError)
    expect(await counts(target)).toEqual({ users: 0, workspaces: 0, files: 0 })
    await expect(restoreData(target, { schemaRevision: 999, sql: '' })).rejects.toBeInstanceOf(InvalidDumpError)
    void sql
  })
})
