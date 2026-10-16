import { eq } from 'drizzle-orm'
import type { Config } from '../config.ts'
import type { Database } from '../db/client.ts'
import { appSettings } from '../db/schema.ts'

export async function getAppSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1)
  return row?.value ?? null
}

export async function isRegistrationEnabled(db: Database, config: Config): Promise<boolean> {
  const saved = await getAppSetting(db, 'registration_enabled')
  if (saved !== null) return saved.toLowerCase() === 'true'
  return config.registrationEnabled
}
