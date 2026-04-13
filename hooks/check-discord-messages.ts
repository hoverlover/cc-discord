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
const DATA_DIR = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");

const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const sessionId =
  process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || "default";

const dbPath = join(DATA_DIR, "messages.db");

const noopLogger = {
  log() {},
  warn() {},
  error() {},
};

async function syncRuntimeContext({ hookEvent, hookInput }: { hookEvent: string; hookInput: any }) {
  const memoryDbPath = join(DATA_DIR, "memory.db");
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

/**
 * Build memory context using QMD semantic search.
 *
 * Queries the `agent-memory` QMD collection and formats results into the
 * same MEMORY CONTEXT format the downstream prompts expect.
 */
async function buildMemoryContext({ queryText, runtimeState }: { queryText: string; runtimeState: any }) {
  if (!queryText?.trim()) return "";

  try {
    const { execSync } = await import("node:child_process");

    // Use `qmd search` (BM25) for fast keyword recall (~0.3s).
    // `qmd query` would give LLM-reranked results but is too slow for a hook.
    // -n 8 returns up to 8 relevant chunks.
    // --min-score 0.3 filters low-relevance noise.
    const raw = execSync(
      `qmd search ${JSON.stringify(queryText)} -n 8 --min-score 0.3 --json 2>/dev/null`,
      { encoding: "utf-8", timeout: 8_000 },
    );

    const results: Array<{ docid: string; score: number; file: string; title: string; snippet: string }> =
      JSON.parse(raw || "[]");

    if (results.length === 0) return "";

    // Expand the top results into readable turn snippets using `qmd get`.
    // Each snippet in the JSON output has a line reference — we use `qmd get`
    // to retrieve a fuller window of surrounding content.
    const lines: string[] = [];
    for (const result of results.slice(0, 8)) {
      // Extract the path + line from the qmd:// URI
      const qmdPath = result.file.replace(/^qmd:\/\//, "");
      const lineMatch = result.snippet.match(/@@ -(\d+)/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 1;

      try {
        const content = execSync(
          `qmd get "${qmdPath}:${lineNum}" -l 12 2>/dev/null`,
          { encoding: "utf-8", timeout: 5_000 },
        ).trim();

        if (content) {
          // Clean up markdown headers/frontmatter noise, keep the conversation content
          const cleaned = content
            .split("\n")
            .filter((l: string) => !l.startsWith("---") && !l.startsWith("session_key:") && !l.startsWith("agent_id:"))
            .join("\n")
            .trim();

          if (cleaned) {
            const scoreLabel = `${Math.round(result.score * 100)}%`;
            lines.push(`- [${scoreLabel}] ${truncateForMemory(cleaned, 320)}`);
          }
        }
      } catch {
        // Fall back to the snippet from the JSON
        if (result.snippet) {
          const snippetText = result.snippet
            .replace(/@@ -\d+,?\d* @@.*\n?/, "")
            .replace(/\(.*?before.*?after\)\n?/, "")
            .trim();
          if (snippetText) {
            lines.push(`- [${Math.round(result.score * 100)}%] ${truncateForMemory(snippetText, 320)}`);
          }
        }
      }
    }

    if (lines.length === 0) return "";
    return `MEMORY CONTEXT:\nRelevant prior turns (semantic recall via QMD):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

function truncateForMemory(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

function buildChannelPromptContext(db: InstanceType<typeof DatabaseSync>): string {
  const promptChannelId = /^\d{15,22}$/.test(agentId) ? agentId : "";
  if (!promptChannelId) return "";

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

    const row = db.prepare("SELECT prompt FROM channel_prompts WHERE channel_id = ?").get(promptChannelId) as any;
    const prompt = String(row?.prompt || "").trim();
    if (!prompt) return "";
    return `ACTIVE CHANNEL PROMPT:\n${prompt}`;
  } catch {
    return "";
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

  const channelPromptText = buildChannelPromptContext(db);

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
    const contextText = [inboxText, channelPromptText, memoryText].filter(Boolean).join("\n\n");

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

  if (hookEvent === "SessionStart" && channelPromptText) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEvent,
          additionalContext: channelPromptText,
        },
      }),
    );
    process.exit(0);
  }

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
