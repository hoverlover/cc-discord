#!/usr/bin/env bun
/**
 * Claude Code hook: inject active channel prompt into context.
 *
 * Intended for hook events where the prompt should be reasserted without
 * paying the cost on every normal delivery/tool cycle, e.g. PostCompact.
 */

// Suppress Node.js ExperimentalWarning (SQLite) to keep hook output clean
const _origEmit = process.emit;
process.emit = function (event: string, ...args: any[]) {
  if (event === "warning" && args[0]?.name === "ExperimentalWarning") return false;
  return _origEmit.call(this, event, ...args) as any;
};

import { Database as DatabaseSync } from "bun:sqlite";
import { join } from "node:path";

const DATA_DIR = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");
const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const dbPath = join(DATA_DIR, "messages.db");

let hookInput: any;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  hookInput = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

const hookEvent = hookInput.hook_event_name || hookInput.hookEventName || "";
if (hookEvent !== "PostCompact") {
  process.exit(0);
}

if (!/^\d{15,22}$/.test(agentId)) {
  process.exit(0);
}

let db: InstanceType<typeof DatabaseSync>;
try {
  db = new DatabaseSync(dbPath);
} catch {
  process.exit(0);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_prompts (
      channel_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const row = db.prepare("SELECT prompt FROM channel_prompts WHERE channel_id = ?").get(agentId) as any;
  const prompt = String(row?.prompt || "").trim();
  if (!prompt) {
    process.exit(0);
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEvent,
        additionalContext: `ACTIVE CHANNEL PROMPT:\n${prompt}`,
      },
    }),
  );
  process.exit(0);
} catch {
  process.exit(0);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
