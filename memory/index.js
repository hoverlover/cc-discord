export { MemoryStore } from './core/MemoryStore.js'
export { MemoryCoordinator } from './core/MemoryCoordinator.js'
export { buildMemorySessionKey } from './core/session-key.js'
export {
  MemoryScopes,
  MemoryCardTypes,
  safeJsonParse,
  safeJsonStringify,
  nowIso,
  clamp,
} from './core/types.js'

/**
 * Lazy-load sqlite provider to avoid forcing sqlite initialization on all imports.
 */
export async function loadSqliteMemoryStore() {
  const mod = await import('./providers/sqlite/SqliteMemoryStore.js')
  return mod.SqliteMemoryStore
}
