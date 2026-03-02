#!/usr/bin/env bun

/**
 * Inspect memory_turns for debugging retrieval issues.
 *
 * Usage:
 *   node tools/memory-inspect.js                    # show summary + recent turns
 *   node tools/memory-inspect.js --search mattermost # search for keyword
 *   node tools/memory-inspect.js --all               # dump all turns
 */

import { Database as DatabaseSync } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.env.ORCHESTRATOR_DIR || join(__dirname, "..");
const DATA_DIR = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");
const dbPath = join(DATA_DIR, "memory.db");

const args = process.argv.slice(2);
let searchTerm: string | null = null;
let showAll = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--search" && args[i + 1]) searchTerm = args[++i];
  else if (args[i] === "--all") showAll = true;
  else if (!args[i].startsWith("-")) searchTerm = args[i];
}

const db = new DatabaseSync(dbPath);

const total = (db.prepare("SELECT COUNT(*) c FROM memory_turns").get() as any).c;
console.log(`total turns: ${total}`);

const rs = db.prepare("SELECT * FROM memory_runtime_state").all() as any[];
console.log(`runtime states: ${rs.length}`);
for (const r of rs) {
  console.log(
    `  session=${r.session_key} ctx=${r.runtime_context_id} epoch=${r.runtime_epoch} updated=${r.updated_at}`,
  );
}

const sessions = db.prepare("SELECT session_key, COUNT(*) c FROM memory_turns GROUP BY session_key").all() as any[];
console.log(`sessions:`);
for (const s of sessions) console.log(`  ${s.session_key}: ${s.c} turns`);

if (searchTerm) {
  const pattern = `%${searchTerm.toLowerCase()}%`;
  const hits = db
    .prepare(`
    SELECT turn_index, role, content, created_at, metadata_json
    FROM memory_turns
    WHERE LOWER(content) LIKE ?
    ORDER BY turn_index ASC
  `)
    .all(pattern) as any[];
  console.log(`\nsearch "${searchTerm}": ${hits.length} hits`);
  for (const t of hits) {
    const meta = JSON.parse(t.metadata_json || "{}");
    const rc = meta.runtimeContextId || "null";
    const content = t.content.replace(/\n/g, " ").slice(0, 200);
    console.log(`  [${t.turn_index}] ${t.created_at} rc=${rc} ${t.role}: ${content}`);
  }
} else if (showAll) {
  const all = db
    .prepare(`
    SELECT turn_index, role, content, created_at, metadata_json
    FROM memory_turns ORDER BY turn_index ASC
  `)
    .all() as any[];
  for (const t of all) {
    const meta = JSON.parse(t.metadata_json || "{}");
    const rc = meta.runtimeContextId || "null";
    const content = t.content.replace(/\n/g, " ").slice(0, 200);
    console.log(`[${t.turn_index}] ${t.created_at} rc=${rc} ${t.role}: ${content}`);
  }
} else {
  const recent = db
    .prepare(`
    SELECT turn_index, role, content, created_at, metadata_json
    FROM memory_turns ORDER BY turn_index DESC LIMIT 20
  `)
    .all() as any[];
  console.log(`\nlast 20 turns:`);
  recent.reverse();
  for (const t of recent) {
    const meta = JSON.parse(t.metadata_json || "{}");
    const rc = meta.runtimeContextId || "null";
    const content = t.content.replace(/\n/g, " ").slice(0, 200);
    console.log(`  [${t.turn_index}] ${t.created_at} rc=${rc} ${t.role}: ${content}`);
  }
}

db.close();
