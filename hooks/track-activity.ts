#!/usr/bin/env bun
/**
 * Hook to track current agent activity for UX/status signaling.
 *
 * Writes to data/messages.db -> agent_activity table:
 * - PreToolUse: status=busy with tool summary
 * - PostToolUse/Stop/SessionStart: status=idle
 *
 * Produces no stdout output (state-only hook).
 */

// Suppress Node.js ExperimentalWarning (SQLite) to keep hook output clean
const _origEmit = process.emit;
process.emit = function (event: string, ...args: any[]) {
  if (event === "warning" && args[0]?.name === "ExperimentalWarning") return false;
  return _origEmit.call(this, event, ...args) as any;
};

import { Database as DatabaseSync } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.env.ORCHESTRATOR_DIR || join(__dirname, "..");

const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const sessionId =
  process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || "default";

const dbPath = join(ROOT_DIR, "data", "messages.db");

const input = await readHookInput();
if (!input) process.exit(0);

const hookEvent = input.hook_event_name || input.hookEventName || "";
const toolName = input.tool_name || input.toolName || null;
const toolInput = input.tool_input || input.toolInput || null;

let db: InstanceType<typeof DatabaseSync>;
try {
  db = new DatabaseSync(dbPath);
} catch {
  process.exit(0);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      activity_type TEXT,
      activity_summary TEXT,
      started_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_activity_status
      ON agent_activity(status);
  `);

  const now = new Date().toISOString();

  if (hookEvent === "PreToolUse") {
    const summary = summarizeTool(toolName, toolInput);

    db.prepare(`
      INSERT INTO agent_activity (
        session_id,
        agent_id,
        status,
        activity_type,
        activity_summary,
        started_at,
        updated_at
      ) VALUES (?, ?, 'busy', ?, ?, ?, ?)
      ON CONFLICT(session_id, agent_id) DO UPDATE SET
        status = 'busy',
        activity_type = excluded.activity_type,
        activity_summary = excluded.activity_summary,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run(sessionId, agentId, toolName || "tool", summary, now, now);

    process.exit(0);
  }

  if (hookEvent === "PostToolUse" || hookEvent === "Stop" || hookEvent === "SessionStart") {
    db.prepare(`
      INSERT INTO agent_activity (
        session_id,
        agent_id,
        status,
        activity_type,
        activity_summary,
        started_at,
        updated_at
      ) VALUES (?, ?, 'idle', NULL, NULL, NULL, ?)
      ON CONFLICT(session_id, agent_id) DO UPDATE SET
        status = 'idle',
        activity_type = NULL,
        activity_summary = NULL,
        started_at = NULL,
        updated_at = excluded.updated_at
    `).run(sessionId, agentId, now);
  }
} catch {
  // fail-open
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

process.exit(0);

async function readHookInput(): Promise<any> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function summarizeTool(toolName: string | null, toolInput: any): string {
  const name = String(toolName || "Tool");

  if (!toolInput || typeof toolInput !== "object") return name;

  if (name === "Bash") {
    const command = String(toolInput.command || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!command) return "Bash";
    return truncate(command, 180);
  }

  if (name === "Read") {
    const target = toolInput.file_path || toolInput.path || "";
    return target ? `Read ${target}` : "Read";
  }

  if (name === "Edit" || name === "Write") {
    const target = toolInput.file_path || toolInput.path || "";
    return target ? `${name} ${target}` : name;
  }

  if (name === "Task") {
    const desc = String(toolInput.description || toolInput.prompt || "").trim();
    return desc ? `Task: ${truncate(desc, 160)}` : "Task";
  }

  return name;
}

function truncate(text: string, maxLen: number): string {
  const str = String(text || "");
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}
