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

  const USER = `INSERT INTO "users" ("id", "email", "hashed_password", "is_active", "is_superuser", "is_verified", "is_2fa_enabled") VALUES ('11111111-1111-1111-1111-111111111111', 'a@b.c', 'x', 'true', 'false', 'true', 'false');`

  it('refuses a dump with transaction control or statements outside the dump grammar, leaving the database untouched', async () => {
    const hostile: Array<[string, string]> = [
      ['commit in the middle', `${USER}\nCOMMIT;\nDROP TABLE workspaces;\nINSERT INTO nowhere VALUES (1);`],
      ['commit then failure', `${USER}\nCOMMIT;\nINSERT INTO "nowhere" ("a") VALUES ('1');`],
      ['rollback and begin', `BEGIN;\n${USER}\nROLLBACK;`],
      ['ddl', `DROP TABLE "workspaces";`],
      ['alter', `ALTER TABLE "users" ADD COLUMN "x" text;`],
      ['create', `CREATE TABLE "evil" ("a" int);`],
      ['update', `UPDATE "users" SET "email" = 'x';`],
      ['delete', `DELETE FROM "users";`],
      ['select', `SELECT pg_sleep(0);`],
      ['function call in values', `INSERT INTO "users" ("id") VALUES (pg_sleep(0));`],
      ['two statements in one line', `${USER} DROP TABLE "users";`],
      ['insert into another schema', `INSERT INTO "drizzle"."__drizzle_migrations" ("id") VALUES ('1');`],
      ['truncate another schema', `TRUNCATE "drizzle"."__drizzle_migrations" CASCADE;`],
      ['comment hiding a statement', `-- ok\n${USER}\n/* x */ DROP TABLE "users";`],
      ['unterminated literal', `INSERT INTO "users" ("id") VALUES ('1);`],
      ['copy', `COPY "users" FROM STDIN;`],
    ]
    const target = await fresh()
    const before = await counts(target)
    const schemaBefore = (await target.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0]!.n
    for (const [label, text] of hostile) {
      await expect(restoreData(target, { schemaRevision: 1, sql: text }), label).rejects.toBeInstanceOf(InvalidDumpError)
      expect(await counts(target), label).toEqual(before)
    }
    const schemaAfter = (await target.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0]!.n
    expect(schemaAfter).toBe(schemaBefore)
  })

  it('still restores literals that contain semicolons, newlines and keywords', async () => {
    const source = await fresh()
    await source.exec(`INSERT INTO users (id, email, hashed_password, is_active, is_superuser, is_verified, is_2fa_enabled, preferences) VALUES ('11111111-1111-1111-1111-111111111111', 'a@b.c', 'x', true, false, true, false, '{"n":"COMMIT; DROP TABLE x;\\nline -- two"}')`)
    const target = await fresh()
    await restoreData(target, await dumpData(source))
    const row = await target.query<{ preferences: { n: string } }>(`SELECT preferences FROM users`)
    expect(row.rows[0]?.preferences.n).toBe('COMMIT; DROP TABLE x;\nline -- two')
  })
})
