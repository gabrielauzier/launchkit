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

type Token = { kind: 'word' | 'ident' | 'literal' | 'punct'; text: string }

/**
 * Splits a dump into statements of tokens. Only the pieces `dumpData` writes are known: bare words,
 * "quoted identifiers", 'quoted literals' (with '' escapes), `( ) ,` and `;`; a `-- ...` comment
 * may stand between statements. Anything else is an invalid dump.
 */
function tokenize(sql: string): Token[][] {
  const statements: Token[][] = []
  let current: Token[] = []
  let at = 0
  const fail = (what: string): never => {
    throw new InvalidDumpError(`the dump has ${what} at ${at}`)
  }
  const quoted = (quote: string): string => {
    let end = at + 1
    for (;;) {
      end = sql.indexOf(quote, end)
      if (end < 0) return fail('an unterminated quote')
      if (sql[end + 1] === quote) end += 2
      else break
    }
    const text = sql.slice(at, end + 1)
    at = end + 1
    return text
  }
  while (at < sql.length) {
    const char = sql[at]!
    if (/\s/.test(char)) at++
    else if (char === '-' && sql[at + 1] === '-' && current.length === 0) {
      const newline = sql.indexOf('\n', at)
      at = newline < 0 ? sql.length : newline + 1
    } else if (char === "'") current.push({ kind: 'literal', text: quoted("'") })
    else if (char === '"') current.push({ kind: 'ident', text: quoted('"') })
    else if (char === '(' || char === ')' || char === ',') {
      current.push({ kind: 'punct', text: char })
      at++
    } else if (char === ';') {
      if (current.length > 0) statements.push(current)
      current = []
      at++
    } else if (/[A-Za-z]/.test(char)) {
      const start = at
      while (at < sql.length && /[A-Za-z]/.test(sql[at]!)) at++
      current.push({ kind: 'word', text: sql.slice(start, at).toUpperCase() })
    } else fail(`an unexpected character ${JSON.stringify(char)}`)
  }
  if (current.length > 0) fail('a statement without a terminating semicolon')
  return statements
}

/** `a, b, c` of identifiers between `from` and a closing token; returns the index after the list. */
function identList(tokens: Token[], from: number): number {
  let at = from
  for (;;) {
    if (tokens[at]?.kind !== 'ident') throw new InvalidDumpError('the dump names something that is not a quoted identifier')
    at++
    if (tokens[at]?.text === ',' && tokens[at]?.kind === 'punct') at++
    else return at
  }
}

/** Only `TRUNCATE "t", ... CASCADE` and `INSERT INTO "t" ("c", ...) VALUES ('v' | NULL, ...)` are statements of a dump. */
function checkStatement(tokens: Token[]): void {
  const word = (at: number, text: string) => tokens[at]?.kind === 'word' && tokens[at]?.text === text
  const punct = (at: number, text: string) => tokens[at]?.kind === 'punct' && tokens[at]?.text === text
  const bad = () => new InvalidDumpError('the dump has a statement that is not a TRUNCATE or INSERT of the dump')
  if (word(0, 'TRUNCATE')) {
    const end = identList(tokens, 1)
    if (!word(end, 'CASCADE') || tokens.length !== end + 1) throw bad()
    return
  }
  if (word(0, 'INSERT') && word(1, 'INTO') && tokens[2]?.kind === 'ident' && punct(3, '(')) {
    let at = identList(tokens, 4)
    if (!punct(at, ')') || !word(at + 1, 'VALUES') || !punct(at + 2, '(')) throw bad()
    at += 3
    for (;;) {
      const value = tokens[at]
      if (!(value?.kind === 'literal' || (value?.kind === 'word' && value.text === 'NULL'))) throw bad()
      at++
      if (punct(at, ',')) at++
      else break
    }
    if (!punct(at, ')') || tokens.length !== at + 1) throw bad()
    return
  }
  throw bad()
}

/**
 * Restores a dump into a database with no users, all or nothing. Refuses a dump made by a newer
 * schema (`schemaRevision`) and one whose SQL fails; either leaves the database as it was.
 */
export async function restoreData(client: PGlite, dump: DataDump): Promise<void> {
  if (dump.schemaRevision > (await schemaRevision(client))) throw new InvalidDumpError('the export comes from a newer version')
  const users = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "users"')
  if ((users.rows[0]?.n ?? 0) > 0) throw new NotANewInstallationError()
  // Nothing runs before the whole text is known to be the dump's own grammar: a `COMMIT;` in the
  // file would end the transaction below and keep what came before it.
  const statements = tokenize(dump.sql)
  for (const statement of statements) checkStatement(statement)
  try {
    await client.transaction(async (tx) => {
      await tx.exec(dump.sql)
    })
  } catch (error) {
    throw new InvalidDumpError(error instanceof Error ? error.message : String(error))
  }
}
