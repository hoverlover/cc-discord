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
const DATA_DIR = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");

const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const sessionId =
  process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || "default";
const traceEnabled = String(process.env.TRACE_THREAD_ENABLED || "true").toLowerCase() !== "false";
// In channel routing mode, agent_id IS the Discord channel ID
const traceChannelId = agentId;

const dbPath = join(DATA_DIR, "messages.db");

const input = await readHookInput();
if (!input) process.exit(0);

const hookEvent = input.hook_event_name || input.hookEventName || "";
const toolName = input.tool_name || input.toolName || null;
const toolInput = input.tool_input || input.toolInput || null;

let db: InstanceType<typeof DatabaseSync>;
try {
  db = new DatabaseSync(dbPath);
  // WAL mode for better concurrency with the relay server's flush loop
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
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

    CREATE TABLE IF NOT EXISTS trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_id TEXT,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      summary TEXT,
      posted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_trace_events_pending
      ON trace_events(posted, created_at);
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

    // Write trace event for the live trace thread
    if (traceEnabled) {
      try {
        db.prepare(`
          INSERT INTO trace_events (session_id, agent_id, channel_id, event_type, tool_name, summary)
          VALUES (?, ?, ?, 'tool_start', ?, ?)
        `).run(sessionId, agentId, traceChannelId, toolName || "tool", summary);
      } catch {
        /* fail-open */
      }
    }

    process.exit(0);
  }

  if (hookEvent === "PostToolUse" || hookEvent === "Stop" || hookEvent === "SessionStart") {
    // Read started_at BEFORE clearing it (needed for elapsed time calculation)
    let elapsedTag = "";
    if (traceEnabled && hookEvent === "PostToolUse") {
      try {
        const row = db
          .prepare(`
          SELECT started_at FROM agent_activity
          WHERE session_id = ? AND agent_id = ?
        `)
          .get(sessionId, agentId) as { started_at?: string } | undefined;
        if (row?.started_at) {
          const elapsedMs = Date.now() - new Date(row.started_at).getTime();
          if (elapsedMs >= 0 && elapsedMs < 600_000) {
            elapsedTag = `elapsed:${elapsedMs}|`;
          }
        }
      } catch {
        /* best-effort */
      }
    }

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

    // Write trace event for the live trace thread (with elapsed time)
    if (traceEnabled && hookEvent === "PostToolUse") {
      try {
        const summary = summarizeTool(toolName, toolInput);
        db.prepare(`
          INSERT INTO trace_events (session_id, agent_id, channel_id, event_type, tool_name, summary)
          VALUES (?, ?, ?, 'tool_end', ?, ?)
        `).run(sessionId, agentId, traceChannelId, toolName || "tool", `${elapsedTag}${summary}`);
      } catch {
        /* fail-open */
      }
    }
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
    return command;
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
    return desc ? `Task: ${desc}` : "Task";
  }

  return name;
}

function truncate(text: string, maxLen: number): string {
  const str = String(text || "");
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}
