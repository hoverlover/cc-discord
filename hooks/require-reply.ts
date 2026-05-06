#!/usr/bin/env bun
/**
 * PreToolUse hook: block wait-for-discord-messages when a reply is still owed.
 *
 * This prevents the agent from treating plain assistant text as a sent Discord
 * reply. Once a Discord message has been delivered to the agent, it must use
 * send-discord successfully before returning to the wait loop.
 */

import { Database as DatabaseSync } from "bun:sqlite";
import { join } from "node:path";
import { buildPendingReplyBlockReason } from "../server/reply-obligation.ts";
import { buildPreToolUseDeny } from "./pretool-deny.ts";

const DATA_DIR = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");
const dbPath = join(DATA_DIR, "messages.db");

interface PendingReplyRow {
  channel_id: string;
  pending_count: number;
  last_message_content: string;
}

function logHookError(stage: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[require-reply] ${stage}: ${message}`);
}

function parseCommandEnv(command: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const envPattern = new RegExp(`(?:^|\\s)${escapedName}=(?:"([^"]*)"|'([^']*)'|([^\\s]+))`);
  const match = String(command).match(envPattern);
  return match ? match[1] || match[2] || match[3] || null : null;
}

function parseCommandOption(command: string, option: string): string | null {
  const escapedOption = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(command).match(
    new RegExp(`(?:^|\\s)${escapedOption}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`),
  );
  return match ? match[1] || match[2] || match[3] || null : null;
}

let hookInput: any;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  hookInput = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

const toolName = hookInput.tool_name || hookInput.toolName;
if (toolName !== "Bash") process.exit(0);

const toolInput = hookInput.tool_input || hookInput.toolInput || {};
const command = String(toolInput.command || "");
if (!command.includes("wait-for-discord-messages")) process.exit(0);

const agentId =
  parseCommandOption(command, "--agent") ||
  parseCommandEnv(command, "AGENT_ID") ||
  process.env.AGENT_ID ||
  process.env.CLAUDE_AGENT_ID ||
  "claude";
const sessionId =
  parseCommandOption(command, "--session") ||
  parseCommandEnv(command, "DISCORD_SESSION_ID") ||
  parseCommandEnv(command, "BROKER_SESSION_ID") ||
  parseCommandEnv(command, "SESSION_ID") ||
  process.env.DISCORD_SESSION_ID ||
  process.env.BROKER_SESSION_ID ||
  process.env.SESSION_ID ||
  "default";

let db: InstanceType<typeof DatabaseSync>;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  logHookError(`failed to open database at ${dbPath}`, err);
  process.exit(0);
}

try {
  const rows = db
    .prepare(
      `SELECT channel_id, pending_count, last_message_content
       FROM pending_replies
       WHERE session_id = ?
         AND agent_id = ?
       ORDER BY updated_at DESC
       LIMIT 3`,
    )
    .all(sessionId, agentId) as PendingReplyRow[];

  if (rows.length === 0) {
    process.exit(0);
  }

  const reason = buildPendingReplyBlockReason(rows);
  process.stdout.write(JSON.stringify(buildPreToolUseDeny(reason)));
  process.exit(0);
} catch (err) {
  logHookError("failed to check pending reply obligations", err);
  process.exit(0);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
