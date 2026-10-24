import { drizzle } from 'drizzle-orm/node-postgres'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import pg from 'pg'
import * as schema from './schema.ts'

/** Every call site types the database as this, never as the type of one driver. */
export type Database = PgDatabase<any, any, any>

export interface DatabaseHandle {
  db: Database
  close(): Promise<void>
}

export function connectPostgres(connectionString: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max: 10 })
  // An idle client dropping (database restart) must not take the process down.
  pool.on('error', () => undefined)
  return {
    db: drizzle(pool, { schema }) as unknown as Database,
    close: () => pool.end(),
  }
}

export { schema }
