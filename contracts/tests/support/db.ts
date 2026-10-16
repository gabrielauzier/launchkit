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

export async function setAppSetting(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db().query('DELETE FROM app_settings WHERE key = $1', [key])
    return
  }
  await db().query(
    'INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  )
}

export async function hashOf(email: string): Promise<string> {
  const { rows } = await db().query('SELECT hashed_password FROM users WHERE email = $1', [email])
  return rows[0].hashed_password
}

export interface SeedUser {
  email: string
  password: string
  hash?: string
  superuser?: boolean
  active?: boolean
}

/** Inserts a user row directly, the way a legacy install or another stack would have. */
export async function seedUser(user: SeedUser): Promise<string> {
  const { randomUUID } = await import('node:crypto')
  const bcrypt = (await import('bcryptjs')).default
  const id = randomUUID()
  const hash = user.hash ?? bcrypt.hashSync(user.password, 10)
  await db().query(
    `INSERT INTO users (id, email, hashed_password, is_active, is_superuser, is_verified, is_2fa_enabled, preferences)
     VALUES ($1, $2, $3, $4, $5, true, false, $6)`,
    [id, user.email, hash, user.active ?? true, user.superuser ?? false, JSON.stringify({ language: 'en' })],
  )
  return id
}
