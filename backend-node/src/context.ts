import type { Config } from './config.ts'
import type { Database } from './db/client.ts'
import type { KeyValueStore } from './ports/key-value-store.ts'

/**
 * Everything a request handler may need from the outside world. `server.ts` and the test
 * harness both build one and hand it to `buildApp`, so both assemble the app the same way.
 * Later slices add `jobQueue` and `storage` here.
 */
export interface AppContext {
  config: Config
  db: Database
  keyValueStore: KeyValueStore
}
