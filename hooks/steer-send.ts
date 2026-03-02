#!/usr/bin/env bun
/**
 * PreToolUse hook: block send-discord when unread messages exist.
 *
 * When a Discord user sends a follow-up while the agent is composing a reply,
 * this hook intercepts the send-discord Bash call, delivers the new messages
 * as the block reason, and forces the agent to revise its reply.
 *
 * Hook input:  snake_case fields (hook_event_name, tool_name, tool_input)
 * Hook output: { "decision": "block", "reason": "..." } or silent exit 0
 */

import { Database as DatabaseSync } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.env.ORCHESTRATOR_DIR || join(__dirname, "..");

const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const sessionId =
  process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || "default";

const dbPath = join(ROOT_DIR, "data", "messages.db");

let hookInput: any;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  hookInput = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0); // fail-open
}

// Only intercept Bash calls that run send-discord
const toolName = hookInput.tool_name || hookInput.toolName;
if (toolName !== "Bash") process.exit(0);

const toolInput = hookInput.tool_input || hookInput.toolInput || {};
const command = String(toolInput.command || "");
if (!command.includes("send-discord")) process.exit(0);

// Check for unread messages
const baseRole = agentId.replace(/-\d+$/, "");
const targets = [...new Set([agentId, baseRole, "claude"])];

let db: InstanceType<typeof DatabaseSync>;
try {
  db = new DatabaseSync(dbPath);
} catch {
  process.exit(0); // fail-open: can't reach DB, allow send
}

try {
  db.exec("BEGIN IMMEDIATE");

  const placeholders = targets.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, from_agent, message_type, content
       FROM messages
       WHERE session_id = ?
         AND to_agent IN (${placeholders})
         AND read = 0
       ORDER BY id ASC`,
    )
    .all(sessionId, ...targets) as any[];

  if (rows.length === 0) {
    db.exec("COMMIT");
    process.exit(0); // no new messages, allow send
  }

  // Mark consumed so check-discord-messages won't double-deliver
  const ids = rows.map((r: any) => r.id);
  const idPlaceholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${idPlaceholders})`).run(...ids);
  db.exec("COMMIT");

  const formatted = rows.map((r: any) => {
    const oneLine = String(r.content).replace(/\r/g, "").replace(/\n/g, " ");
    return `[MESSAGE from ${r.from_agent}] [${r.message_type}]: ${oneLine}`;
  });

  const reason = [
    "SEND BLOCKED: New messages arrived while you were composing a reply.",
    "Read them carefully, revise your reply to address ALL messages, then re-send.",
    "",
    ...formatted,
  ].join("\n");

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
} catch {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* ignore */
  }
  process.exit(0); // fail-open
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
