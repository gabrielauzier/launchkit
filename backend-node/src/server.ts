import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { connectPostgres } from './db/client.ts'
import { applyMigrations } from './db/migrate.ts'
import { MemoryStore } from './ports/memory-store.ts'
import { RedisStore } from './ports/redis-store.ts'
import type { KeyValueStore } from './ports/key-value-store.ts'

async function main(): Promise<void> {
  const config = loadConfig()

  const database = connectPostgres(config.pgConnectionString)
  await applyMigrations(database.db)

  const keyValueStore: KeyValueStore = config.redisUrl ? new RedisStore(config.redisUrl) : new MemoryStore()

  const app = await buildApp(
    { config, db: database.db, keyValueStore },
    { logger: { level: config.debug ? 'debug' : 'info' } },
  )

  const shutdown = async () => {
    await app.close()
    await keyValueStore.close()
    await database.close()
    process.exit(0)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  await app.listen({ host: config.host, port: config.port })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
