#!/usr/bin/env bun
/**
 * Claude Code hook: deliver unread Discord messages into Claude context.
 *
 * Hook input:  snake_case fields (hook_event_name, tool_name, ...)
 * Hook output: camelCase fields (hookEventName, additionalContext)
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
import { MemoryCoordinator } from "../memory/core/MemoryCoordinator.ts";
import { buildMemorySessionKey } from "../memory/core/session-key.ts";
import { SqliteMemoryStore } from "../memory/providers/sqlite/SqliteMemoryStore.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = process.env.ORCHESTRATOR_DIR || join(__dirname, "..");

const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const sessionId =
  process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || "default";

const dbPath = join(ROOT_DIR, "data", "messages.db");

const noopLogger = {
  log() {},
  warn() {},
  error() {},
};

async function syncRuntimeContext({ hookEvent, hookInput }: { hookEvent: string; hookInput: any }) {
  const memoryDbPath = join(ROOT_DIR, "data", "memory.db");
  const memorySessionKey = buildMemorySessionKey({ sessionId, agentId });
  const runtimeHint = process.env.CLAUDE_RUNTIME_ID || hookInput?.session_id || hookInput?.sessionId || null;

  let store: SqliteMemoryStore | undefined;
  try {
    store = new SqliteMemoryStore({ dbPath: memoryDbPath, logger: noopLogger });
    const coordinator = new MemoryCoordinator({ store, logger: noopLogger });
    await coordinator.init();

    if (hookEvent === "SessionStart") {
      return await coordinator.beginNewRuntimeContext({
        sessionKey: memorySessionKey,
        runtimeContextId: runtimeHint ? `${runtimeHint}_start_${Date.now().toString(36)}` : null,
      });
    }

    return await coordinator.ensureRuntimeContext({
      sessionKey: memorySessionKey,
      runtimeContextId: runtimeHint,
    });
  } catch {
    return null;
  } finally {
    if (store) {
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function buildMemoryContext({ queryText, runtimeState }: { queryText: string; runtimeState: any }) {
  const memoryDbPath = join(ROOT_DIR, "data", "memory.db");
  const memorySessionKey = buildMemorySessionKey({ sessionId, agentId });

  let store: SqliteMemoryStore | undefined;
  try {
    store = new SqliteMemoryStore({ dbPath: memoryDbPath, logger: noopLogger });
    const coordinator = new MemoryCoordinator({ store, logger: noopLogger });
    await coordinator.init();

    const packet = await coordinator.assembleContext({
      sessionKey: memorySessionKey,
      queryText,
      runtimeContextId: runtimeState?.runtimeContextId || null,
      runtimeEpoch: runtimeState?.runtimeEpoch || null,
      includeSnapshot: true,
      avoidCurrentRuntime: true,
      activeWindowSize: 12,
      maxCards: 6,
      maxRecallTurns: 8,
      maxTurnScan: 300,
    });

    return coordinator.formatContextPacket(packet);
  } catch {
    return "";
  } finally {
    if (store) {
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    }
  }
}

let hookInput: any;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  hookInput = raw ? JSON.parse(raw) : { hook_event_name: "PostToolUse" };
} catch {
  process.exit(0);
}

const hookEvent = hookInput.hook_event_name || "PostToolUse";
const runtimeState = await syncRuntimeContext({ hookEvent, hookInput });

// Match direct agent IDs, generic "claude", and optionally base role
const baseRole = agentId.replace(/-\d+$/, "");
const targets = [...new Set([agentId, baseRole, "claude"])];

let db: InstanceType<typeof DatabaseSync>;
try {
  db = new DatabaseSync(dbPath);
} catch {
  process.exit(0);
}

try {
  db.exec("BEGIN IMMEDIATE");

  const placeholders = targets.map(() => "?").join(",");
  const rows = db
    .prepare(`
    SELECT id, from_agent, message_type, content
    FROM messages
    WHERE session_id = ?
      AND to_agent IN (${placeholders})
      AND read = 0
    ORDER BY id ASC
  `)
    .all(sessionId, ...targets) as any[];

  if (rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    const idPlaceholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${idPlaceholders})`).run(...ids);
    db.exec("COMMIT");

    const formatted = rows.map((r: any) => {
      const oneLine = String(r.content).replace(/\r/g, "").replace(/\n/g, " ");
      return `[MESSAGE from ${r.from_agent}] [${r.message_type}]: ${oneLine}`;
    });
    const inboxText = `NEW DISCORD MESSAGE(S): ${formatted.join(" | ")}`;

    const latestQueryText = String(rows[rows.length - 1]?.content || "");
    const memoryText = await buildMemoryContext({
      queryText: latestQueryText,
      runtimeState,
    });
    const contextText = memoryText ? `${inboxText}\n\n${memoryText}` : inboxText;

    if (hookEvent === "Stop") {
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: `New Discord messages received. Process these before stopping.\n\n${contextText}`,
        }),
      );
      process.exit(0);
    }

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEvent,
          additionalContext: contextText,
        },
      }),
    );
    process.exit(0);
  }

  db.exec("COMMIT");
  process.exit(0);
} catch {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* ignore */
  }
  process.exit(0);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
