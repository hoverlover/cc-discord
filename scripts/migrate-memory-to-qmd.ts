#!/usr/bin/env bun
/**
 * Phase 1: Export memory.db turns to markdown files for QMD indexing.
 *
 * Reads all sessions and turns from the SQLite memory store and writes them
 * as markdown files grouped by session into the Obsidian vault's
 * agent-memory/conversations/ folder.
 *
 * Output directory: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/iCloud/agent-memory/
 *
 * File layout:
 *   agent-memory/
 *     conversations/
 *       <date>-<channel-id>.md   (one file per session, named by date)
 *
 * Each file contains YAML-style frontmatter and all turns in order.
 */

import Database from "bun:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Paths ──────────────────────────────────────────────────────────
const DATA_DIR = join(homedir(), ".cc-discord", "data");
const DB_PATH = join(DATA_DIR, "memory.db");
const OBSIDIAN_VAULT = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "iCloud"
);
const AGENT_MEMORY_DIR = join(OBSIDIAN_VAULT, "agent-memory");
const CONVERSATIONS_DIR = join(AGENT_MEMORY_DIR, "conversations");

// ── Types ──────────────────────────────────────────────────────────
interface SessionRow {
  session_key: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  session_key: string;
  turn_index: number;
  role: string;
  content: string;
  metadata_json: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build a human-friendly filename from session metadata.
 * Format: YYYY-MM-DD-<channel-id>.md
 */
function buildFilename(session: SessionRow): string {
  // Extract date from created_at (ISO string → YYYY-MM-DD)
  const date = session.created_at.slice(0, 10);
  // Extract channel ID from session key (last segment after last colon)
  const parts = session.session_key.split(":");
  const channelId = parts[parts.length - 1] || "unknown";
  return `${date}-${channelId}.md`;
}

/** Format a single turn as a markdown section. */
function formatTurn(turn: TurnRow): string {
  const roleLabel = turn.role === "user" ? "🧑 User" : "🤖 Assistant";
  const ts = turn.created_at ? `  _(${turn.created_at})_` : "";

  let meta = "";
  if (turn.metadata_json) {
    try {
      const parsed = JSON.parse(turn.metadata_json);
      if (parsed.runtimeContextId) {
        meta = `\n> Runtime context: \`${parsed.runtimeContextId}\` epoch ${parsed.runtimeEpoch ?? "?"}`;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return `### Turn ${turn.turn_index} — ${roleLabel}${ts}${meta}\n\n${turn.content}\n`;
}

// ── Main ───────────────────────────────────────────────────────────
function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`❌  memory.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });

  // Fetch sessions
  const sessions = db
    .query<SessionRow, []>(
      `SELECT session_key, agent_id, created_at, updated_at
       FROM memory_sessions ORDER BY created_at`
    )
    .all();

  console.log(`📦  Found ${sessions.length} session(s) in memory.db`);

  // Verify Obsidian vault exists
  if (!existsSync(OBSIDIAN_VAULT)) {
    console.error(`❌  Obsidian vault not found at ${OBSIDIAN_VAULT}`);
    process.exit(1);
  }

  // Prepare output directories
  mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  console.log(`📂  Output directory: ${CONVERSATIONS_DIR}`);

  let totalTurns = 0;
  let filesWritten = 0;

  for (const session of sessions) {
    const turns = db
      .query<TurnRow, [string]>(
        `SELECT id, session_key, turn_index, role, content, metadata_json, created_at
         FROM memory_turns
         WHERE session_key = ?
         ORDER BY turn_index`
      )
      .all(session.session_key);

    if (turns.length === 0) {
      console.log(`  ⏭  Skipping empty session: ${session.session_key}`);
      continue;
    }

    totalTurns += turns.length;

    // Build markdown with Obsidian-friendly filename
    const filename = buildFilename(session);
    const filePath = join(CONVERSATIONS_DIR, filename);

    const frontmatter = [
      "---",
      `session_key: "${session.session_key}"`,
      `agent_id: "${session.agent_id ?? ""}"`,
      `source: cc-discord`,
      `type: conversation`,
      `created: "${session.created_at}"`,
      `updated: "${session.updated_at}"`,
      `turn_count: ${turns.length}`,
      `first_turn: "${turns[0].created_at}"`,
      `last_turn: "${turns[turns.length - 1].created_at}"`,
      `tags:`,
      `  - agent-memory`,
      `  - conversation`,
      `  - cc-discord`,
      "---",
    ].join("\n");

    const header = `# Session: ${session.session_key}\n\n`;
    const summary = `> **${turns.length} turns** · Agent \`${session.agent_id ?? "unknown"}\` · ${session.created_at} → ${session.updated_at}\n\n`;
    const body = turns.map(formatTurn).join("\n---\n\n");

    const markdown = `${frontmatter}\n\n${header}${summary}${body}`;

    writeFileSync(filePath, markdown, "utf-8");
    filesWritten++;
    console.log(
      `  ✅  ${filename} — ${turns.length} turn(s)`
    );
  }

  db.close();

  console.log(`\n🎉  Export complete!`);
  console.log(`    Sessions exported : ${filesWritten}`);
  console.log(`    Total turns       : ${totalTurns}`);
  console.log(`    Output directory  : ${CONVERSATIONS_DIR}`);
  console.log(`\nNext steps:`);
  console.log(`  1. qmd collection remove cc-discord-memory  (remove old collection)`);
  console.log(`  2. qmd collection add "${AGENT_MEMORY_DIR}" --name agent-memory`);
  console.log(`  3. qmd embed`);
  console.log(`  4. qmd query "test query"  — verify semantic search`);
}

main();
