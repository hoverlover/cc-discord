#!/usr/bin/env bun
/**
 * One-time migration: re-key memory_turns from the legacy shared session key
 * (discord:default:claude-discord) into per-channel session keys
 * (discord:default:{channelId}).
 *
 * Each turn's channelId is read from its metadata_json. Turns without a
 * channelId are left in the old key.
 *
 * Turn indices are renumbered per-channel to be sequential, starting after
 * any existing turns already in that channel key.
 *
 * Usage:
 *   bun scripts/migrate-memory-to-channel-keys.ts [path/to/memory.db]
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");
const dbPath = process.argv[2] || join(defaultDataDir, "memory.db");

console.log(`[migrate] Opening ${dbPath}`);
const db = new Database(dbPath);

const OLD_SESSION_KEY = "discord:default:claude-discord";

// Read all turns under the old key
const turns = db
  .prepare(`
  SELECT id, session_key, turn_index, role, content, metadata_json, created_at
  FROM memory_turns
  WHERE session_key = ?
  ORDER BY turn_index ASC
`)
  .all(OLD_SESSION_KEY) as any[];

console.log(`[migrate] Found ${turns.length} turns under ${OLD_SESSION_KEY}`);

if (turns.length === 0) {
  console.log("[migrate] Nothing to migrate.");
  db.close();
  process.exit(0);
}

// Group by channelId from metadata
const byChannel = new Map<string, typeof turns>();
const noChannel: typeof turns = [];

for (const turn of turns) {
  let channelId: string | null = null;
  try {
    const meta = JSON.parse(String((turn as any).metadata_json || "{}"));
    channelId = meta.channelId || null;
  } catch {}

  if (!channelId) {
    noChannel.push(turn);
    continue;
  }

  if (!byChannel.has(channelId)) byChannel.set(channelId, []);
  byChannel.get(channelId)!.push(turn);
}

console.log(`[migrate] Splitting into ${byChannel.size} channels:`);
for (const [ch, chTurns] of byChannel) {
  console.log(`  discord:default:${ch} -> ${chTurns.length} turns`);
}
if (noChannel.length > 0) {
  console.log(`  (${noChannel.length} turns have no channelId -- left in old key)`);
}

// Find the current max turn_index for each target channel key
function getMaxTurnIndex(sessionKey: string): number {
  const row = db
    .prepare("SELECT MAX(turn_index) as max_idx FROM memory_turns WHERE session_key = ?")
    .get(sessionKey) as any;
  return row?.max_idx ?? 0;
}

// Ensure per-channel session keys exist in memory_sessions
const upsertSession = db.prepare(`
  INSERT OR IGNORE INTO memory_sessions (session_key, created_at)
  VALUES (?, datetime('now'))
`);

// Update each turn's session_key and re-index
const updateTurn = db.prepare(`
  UPDATE memory_turns SET session_key = ?, turn_index = ? WHERE id = ?
`);

// Copy runtime state for new keys
const readRuntimeState = db.prepare(`
  SELECT * FROM memory_runtime_state WHERE session_key = ?
`);
const upsertRuntimeState = db.prepare(`
  INSERT OR IGNORE INTO memory_runtime_state (session_key, runtime_context_id, runtime_epoch, updated_at)
  VALUES (?, ?, ?, datetime('now'))
`);

db.exec("BEGIN TRANSACTION");
try {
  const oldRuntime = readRuntimeState.get(OLD_SESSION_KEY) as any;

  for (const [channelId, chTurns] of byChannel) {
    const newKey = `discord:default:${channelId}`;
    upsertSession.run(newKey);

    // Start numbering after any existing turns in the target key
    const startIndex = getMaxTurnIndex(newKey) + 1;

    for (let i = 0; i < chTurns.length; i++) {
      updateTurn.run(newKey, startIndex + i, chTurns[i].id);
    }

    // Bootstrap runtime state for the new key if it doesn't exist
    if (oldRuntime) {
      upsertRuntimeState.run(newKey, `migrated_from_${OLD_SESSION_KEY}`, 1);
    }

    console.log(
      `[migrate] Updated ${chTurns.length} turns -> ${newKey} (indices ${startIndex}..${startIndex + chTurns.length - 1})`,
    );
  }

  db.exec("COMMIT");
  console.log("[migrate] Migration complete.");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("[migrate] Migration failed, rolled back:", (err as Error).message || err);
  process.exit(1);
}

// Summary
for (const [channelId] of byChannel) {
  const newKey = `discord:default:${channelId}`;
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM memory_turns WHERE session_key = ?").get(newKey) as any).cnt;
  console.log(`  ${newKey}: ${count} turns total`);
}

const remaining = (
  db.prepare("SELECT COUNT(*) as cnt FROM memory_turns WHERE session_key = ?").get(OLD_SESSION_KEY) as any
).cnt;
console.log(`  ${OLD_SESSION_KEY}: ${remaining} turns remaining`);

db.close();
