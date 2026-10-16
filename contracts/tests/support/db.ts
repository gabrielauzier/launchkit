import pg from 'pg'
import { databaseUrl } from './config'

let pool: pg.Pool | undefined

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: databaseUrl(), max: 4 })
  return pool
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
}

export async function dropAndRecreateSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
}

/** Empties every application table, keeping the migration bookkeeping. */
export async function resetData(): Promise<void> {
  await db().query(
    'TRUNCATE TABLE files, workspace_members, workspaces, user_passkeys, users, app_settings RESTART IDENTITY CASCADE',
  )
}
