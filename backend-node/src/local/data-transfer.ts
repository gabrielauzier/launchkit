import type { PGlite } from '@electric-sql/pglite'

/** Raised by `restoreData` when the database already holds users: import is for new installations only. */
export class NotANewInstallationError extends Error {
  constructor() {
    super('Import is only available on a new installation')
    this.name = 'NotANewInstallationError'
  }
}

/** The dump cannot be applied: its schema is newer than this build's, or the SQL does not run. */
export class InvalidDumpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidDumpError'
  }
}

export interface DataDump {
  sql: string
  schemaRevision: number
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`

/** The number of applied migrations: what the dump's `schemaRevision` means. */
export async function schemaRevision(client: PGlite): Promise<number> {
  try {
    const result = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"')
    return result.rows[0]?.n ?? 0
  } catch {
    return 0
  }
}

/** Tables of `public`, parents before the tables that reference them. */
async function orderedTables(client: PGlite): Promise<string[]> {
  const tables = (await client.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map(
    (row) => row.name,
  )
  const edges = (
    await client.query<{ child: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'`,
    )
  ).rows
  const parents = new Map<string, Set<string>>(tables.map((table) => [table, new Set<string>()]))
  for (const { child, parent } of edges) if (child !== parent) parents.get(child.replaceAll('"', ''))?.add(parent.replaceAll('"', ''))
  const ordered: string[] = []
  while (ordered.length < tables.length) {
    const next = tables.find((table) => !ordered.includes(table) && [...(parents.get(table) ?? [])].every((parent) => ordered.includes(parent)))
    if (!next) throw new Error('the foreign keys of the schema form a cycle')
    ordered.push(next)
  }
  return ordered
}

/**
 * A data-only dump of the `public` schema: a `TRUNCATE` and one `INSERT` per row, with every value
 * read as text and written as a quoted literal (PostgreSQL converts it to the column's type).
 */
export async function dumpData(client: PGlite): Promise<DataDump> {
  const tables = await orderedTables(client)
  const lines = ['-- launchkit data dump', `TRUNCATE ${[...tables].reverse().map(ident).join(', ')} CASCADE;`]
  for (const table of tables) {
    const columns = (
      await client.query<{ name: string }>(
        `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows.map((row) => row.name)
    const selected = columns.map((column) => `${ident(column)}::text AS ${ident(column)}`).join(', ')
    const result = await client.query<Record<string, string | null>>(`SELECT ${selected} FROM ${ident(table)}`)
    for (const row of result.rows) {
      const values = columns.map((column) => (row[column] == null ? 'NULL' : quote(row[column])))
      lines.push(`INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${values.join(', ')});`)
    }
  }
  return { sql: `${lines.join('\n')}\n`, schemaRevision: await schemaRevision(client) }
}

/**
 * Restores a dump into a database with no users, all or nothing. Refuses a dump made by a newer
 * schema (`schemaRevision`) and one whose SQL fails; either leaves the database as it was.
 */
export async function restoreData(client: PGlite, dump: DataDump): Promise<void> {
  if (dump.schemaRevision > (await schemaRevision(client))) throw new InvalidDumpError('the export comes from a newer version')
  const users = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "users"')
  if ((users.rows[0]?.n ?? 0) > 0) throw new NotANewInstallationError()
  try {
    await client.transaction(async (tx) => {
      await tx.exec(dump.sql)
    })
  } catch (error) {
    throw new InvalidDumpError(error instanceof Error ? error.message : String(error))
  }
}
