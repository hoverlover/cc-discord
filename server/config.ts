/**
 * Configuration: load env vars and export typed settings for the relay server.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(__dirname, "..");
export const DATA_DIR = join(ROOT_DIR, "data");

// Preferred split env file for relay process; legacy fallback for compatibility.
loadDotEnv(join(ROOT_DIR, ".env.relay"));
loadDotEnv(join(ROOT_DIR, ".env"));

export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

export const ALLOWED_CHANNEL_IDS = (process.env.DISCORD_ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const IGNORED_CHANNEL_IDS = new Set(
  (process.env.DISCORD_IGNORED_CHANNEL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const ALLOWED_DISCORD_USER_IDS = (process.env.ALLOWED_DISCORD_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const DISCORD_SESSION_ID = process.env.DISCORD_SESSION_ID || "default";
export const CLAUDE_AGENT_ID = process.env.CLAUDE_AGENT_ID || "claude";

/**
 * Message routing mode:
 * - 'channel' (default): route inbound messages to to_agent=channelId (orchestrator/subagent mode)
 * - 'agent': route to to_agent=CLAUDE_AGENT_ID (legacy single-agent mode)
 */
export const MESSAGE_ROUTING_MODE = String(process.env.MESSAGE_ROUTING_MODE || "channel")
  .toLowerCase()
  .trim();

export const RELAY_HOST = process.env.RELAY_HOST || "127.0.0.1";
export const RELAY_PORT = Number(process.env.RELAY_PORT || 3199);
export const RELAY_API_TOKEN = process.env.RELAY_API_TOKEN || "";
export const RELAY_ALLOW_NO_AUTH = String(process.env.RELAY_ALLOW_NO_AUTH || "false").toLowerCase() === "true";

export const TYPING_INTERVAL_MS = Number(process.env.TYPING_INTERVAL_MS || 8000);
export const TYPING_MAX_MS = Number(process.env.TYPING_MAX_MS || 120000);
export const THINKING_FALLBACK_ENABLED =
  String(process.env.THINKING_FALLBACK_ENABLED || "true").toLowerCase() !== "false";
export const THINKING_FALLBACK_TEXT =
  process.env.THINKING_FALLBACK_TEXT || "Still working on that—thanks for your patience.";

export const BUSY_NOTIFY_ON_QUEUE = String(process.env.BUSY_NOTIFY_ON_QUEUE || "true").toLowerCase() !== "false";
export const BUSY_NOTIFY_COOLDOWN_MS = Number(process.env.BUSY_NOTIFY_COOLDOWN_MS || 30000);
/** Only send a busy notification if the current activity has been running for at least this long (ms). */
export const BUSY_NOTIFY_MIN_DURATION_MS = Number(process.env.BUSY_NOTIFY_MIN_DURATION_MS || 30000);

export const MAX_ATTACHMENT_INLINE_BYTES = Number(process.env.MAX_ATTACHMENT_INLINE_BYTES || 100_000);
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = Number(process.env.MAX_ATTACHMENT_DOWNLOAD_BYTES || 10_000_000);
export const ATTACHMENT_TTL_MS = Number(process.env.ATTACHMENT_TTL_MS || 3_600_000);

export const ATTACHMENT_DIR = join("/tmp", "cc-discord", "attachments");

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function validateConfig() {
  if (!DISCORD_BOT_TOKEN) {
    console.error("Missing DISCORD_BOT_TOKEN (set in .env.relay or env var).");
    process.exit(1);
  }

  if (!DEFAULT_CHANNEL_ID) {
    console.error("Missing DISCORD_CHANNEL_ID (set in .env.relay or env var).");
    process.exit(1);
  }

  if (!RELAY_API_TOKEN && !RELAY_ALLOW_NO_AUTH) {
    console.error(
      "Missing RELAY_API_TOKEN. Set RELAY_API_TOKEN in .env.relay (recommended), or explicitly set RELAY_ALLOW_NO_AUTH=true for local-only dev.",
    );
    process.exit(1);
  }
}
