/**
 * Memory integration for the relay server.
 *
 * Writes new turns as markdown to the Obsidian vault's agent-memory folder
 * and triggers QMD re-indexing. Reads are handled by the hook via `qmd query`.
 *
 * SQLite is retained solely for runtime-state tracking (context epochs).
 *
 * Session key strategy:
 * When a channelId is provided, turns are appended to a per-channel
 * conversation file. When no channelId is available, falls back to the
 * legacy shared key.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMemorySessionKey } from "../memory/core/session-key.ts";
import { SqliteMemoryStore } from "../memory/providers/sqlite/SqliteMemoryStore.ts";
import { CLAUDE_AGENT_ID, DATA_DIR, DISCORD_SESSION_ID } from "./config.ts";

// ── Paths ──────────────────────────────────────────────────────────
const OBSIDIAN_VAULT = join(
  process.env.HOME || "",
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "iCloud",
);
const AGENT_MEMORY_DIR = join(OBSIDIAN_VAULT, "agent-memory");
const CONVERSATIONS_DIR = join(AGENT_MEMORY_DIR, "conversations");

/** Legacy fallback key for turns without a channel association. */
const fallbackSessionKey = buildMemorySessionKey({
  sessionId: DISCORD_SESSION_ID,
  agentId: CLAUDE_AGENT_ID,
});

/**
 * SQLite store is retained only for runtime-state tracking.
 * It is NOT used for reading/writing memory turns.
 */
export const memoryStore = new SqliteMemoryStore({
  dbPath: join(DATA_DIR, "memory.db"),
  logger: console,
});
await memoryStore.init();

// ── Helpers ────────────────────────────────────────────────────────

function resolveSessionKey(channelId?: string): string {
  if (channelId) {
    return buildMemorySessionKey({
      sessionId: DISCORD_SESSION_ID,
      agentId: channelId,
    });
  }
  return fallbackSessionKey;
}

/**
 * Build the filename for a conversation file.
 * Format: <date>-<channelId>.md (matches export script naming).
 */
function resolveConversationFile(sessionKey: string): string {
  const parts = sessionKey.split(":");
  const channelId = parts[parts.length - 1] || "unknown";

  // Look for an existing file matching this channel
  const { readdirSync } = require("node:fs");
  mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  const files: string[] = readdirSync(CONVERSATIONS_DIR);
  const existing = files.find((f: string) => f.endsWith(`-${channelId}.md`));
  if (existing) return join(CONVERSATIONS_DIR, existing);

  // No existing file — create a new one with today's date
  const today = new Date().toISOString().slice(0, 10);
  return join(CONVERSATIONS_DIR, `${today}-${channelId}.md`);
}

/**
 * Format a turn as markdown, matching the export format.
 */
function formatTurnMarkdown(role: string, content: string, metadata: any): string {
  const roleLabel = role === "user" ? "🧑 User" : "🤖 Assistant";
  const ts = new Date().toISOString();

  let meta = "";
  if (metadata?.runtimeContextId) {
    meta = `\n> Runtime context: \`${metadata.runtimeContextId}\` epoch ${metadata.runtimeEpoch ?? "?"}`;
  }

  // We use "Turn ?" because exact index doesn't matter for QMD search
  return `\n---\n\n### Turn — ${roleLabel}  _(${ts})_${meta}\n\n${content}\n`;
}

/**
 * Create a new conversation file with frontmatter.
 */
function createConversationFile(filePath: string, sessionKey: string, agentId: string): void {
  const now = new Date().toISOString();
  const frontmatter = [
    "---",
    `session_key: "${sessionKey}"`,
    `agent_id: "${agentId}"`,
    `source: cc-discord`,
    `type: conversation`,
    `created: "${now}"`,
    `updated: "${now}"`,
    `tags:`,
    `  - agent-memory`,
    `  - conversation`,
    `  - cc-discord`,
    "---",
    "",
    `# Session: ${sessionKey}`,
    "",
  ].join("\n");

  writeFileSync(filePath, frontmatter, "utf-8");
}

/**
 * Trigger a background QMD re-index so new turns become searchable.
 * Non-blocking — we don't wait for it to finish.
 */
function triggerQmdReindex(): void {
  try {
    const { exec } = require("node:child_process");
    exec("qmd update 2>/dev/null", { timeout: 30_000 });
  } catch {
    // Best-effort; QMD will catch up on next explicit update or query
  }
}

// ── Main API ───────────────────────────────────────────────────────

export async function appendMemoryTurn({
  role,
  content,
  metadata = {} as any,
}: {
  role: string;
  content: string;
  metadata?: any;
}) {
  try {
    const channelId = metadata?.channelId || null;
    const sessionKey = resolveSessionKey(channelId);
    const runtimeState = await memoryStore.readRuntimeState(sessionKey);

    const enrichedMetadata = {
      ...metadata,
      runtimeContextId: runtimeState?.runtimeContextId || null,
      runtimeEpoch: runtimeState?.runtimeEpoch || null,
    };

    // Resolve (or create) the conversation markdown file
    const filePath = resolveConversationFile(sessionKey);

    if (!existsSync(filePath)) {
      createConversationFile(filePath, sessionKey, channelId || CLAUDE_AGENT_ID);
    }

    // Append the new turn
    const turnMd = formatTurnMarkdown(role, content, enrichedMetadata);
    appendFileSync(filePath, turnMd, "utf-8");

    // Update the frontmatter "updated" timestamp
    try {
      const raw = readFileSync(filePath, "utf-8");
      const updated = raw.replace(
        /^updated: ".*"$/m,
        `updated: "${new Date().toISOString()}"`,
      );
      if (updated !== raw) writeFileSync(filePath, updated, "utf-8");
    } catch {
      /* best-effort */
    }

    // Trigger non-blocking QMD re-index
    triggerQmdReindex();

    console.log(`[Memory/QMD] persisted ${role} turn to ${filePath}`);
  } catch (err: unknown) {
    console.error("[Memory/QMD] failed to persist turn:", (err as Error).message);
  }
}
