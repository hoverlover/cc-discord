export { MemoryCoordinator } from "./core/MemoryCoordinator.ts";
export { MemoryStore } from "./core/MemoryStore.ts";
export { buildMemorySessionKey } from "./core/session-key.ts";
export {
  clamp,
  MemoryCardTypes,
  MemoryScopes,
  nowIso,
  safeJsonParse,
  safeJsonStringify,
} from "./core/types.ts";

/**
 * Lazy-load sqlite provider to avoid forcing sqlite initialization on all imports.
 */
export async function loadSqliteMemoryStore() {
  const mod = await import("./providers/sqlite/SqliteMemoryStore.ts");
  return mod.SqliteMemoryStore;
}
