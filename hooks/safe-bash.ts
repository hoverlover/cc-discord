#!/usr/bin/env bun
/**
 * PreToolUse Bash guard.
 *
 * Policies:
 * - Detects risky background execution patterns:
 *   1) Bash tool_input.run_in_background=true
 *   2) standalone '&' operator in command text
 *
 * Behavior is controlled by env vars:
 * - BASH_POLICY_MODE=block|allow   (default: block)
 * - ALLOW_BASH_RUN_IN_BACKGROUND=true|false (default: true)
 * - ALLOW_BASH_BACKGROUND_OPS=true|false (default: false)
 * - BASH_POLICY_NOTIFY_ON_BLOCK=true|false (default: true)
 * - BASH_POLICY_NOTIFY_CHANNEL_ID=<discord-channel-id> (optional)
 *
 * When blocked, script exits 2 (Claude Code hook "block" behavior).
 */

function readJsonStdin(): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

function asBool(value: unknown, defaultValue: boolean = false): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeMode(value: unknown): "allow" | "block" {
  const v = String(value || "block")
    .toLowerCase()
    .trim();
  return v === "allow" ? "allow" : "block";
}

function hasStandaloneBackgroundOperator(command: string): boolean {
  // Remove escaped ampersands and logical-and to reduce false positives.
  const reduced = String(command || "")
    .replace(/\\&/g, "")
    .replace(/&&/g, "");

  // Match standalone job-control '&' (e.g. "cmd &" or "; &").
  return /(^|[\s;|])&($|[\s\n])/m.test(reduced);
}

function truncateCommand(command: string, max: number = 220): string {
  const clean = String(command || "")
    .replace(/[`\r\n\t]+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

async function notifyDiscord({ blocked, reasons, command }: { blocked: boolean; reasons: string[]; command: string }) {
  const notifyEnabled = asBool(process.env.BASH_POLICY_NOTIFY_ON_BLOCK, true);
  if (!notifyEnabled) return;

  const relayHost = process.env.RELAY_HOST || "127.0.0.1";
  const relayPort = process.env.RELAY_PORT || "3199";
  const relayUrl = process.env.RELAY_URL || `http://${relayHost}:${relayPort}`;
  const apiToken = process.env.RELAY_API_TOKEN || "";
  const channelId = process.env.BASH_POLICY_NOTIFY_CHANNEL_ID || null;
  const fromAgent = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "bash-guard";

  const status = blocked ? "blocked" : "warning";
  const reasonText = reasons.join("; ");
  const commandText = truncateCommand(command);

  const content = [
    `⚠️ Bash safety policy ${status} a command.`,
    `Agent: ${fromAgent}`,
    `Reason: ${reasonText}`,
    `Command: ${commandText}`,
  ].join("\n");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiToken) headers["x-api-token"] = apiToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    await fetch(`${relayUrl}/api/send`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content,
        channelId,
        fromAgent: "bash-guard",
      }),
      signal: controller.signal,
    });
  } catch {
    // Best-effort notification only.
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const input: any = await readJsonStdin();
  const toolName = input.tool_name || input.toolName;
  if (toolName !== "Bash") {
    process.exit(0);
  }

  const toolInput = input.tool_input || input.toolInput || {};
  const command = String(toolInput.command || "");

  const mode = normalizeMode(process.env.BASH_POLICY_MODE);
  const allowRunInBackground = asBool(process.env.ALLOW_BASH_RUN_IN_BACKGROUND, true);
  const allowAmpersand = asBool(process.env.ALLOW_BASH_BACKGROUND_OPS, false);

  const reasons: string[] = [];

  if ((toolInput.run_in_background === true || toolInput.runInBackground === true) && !allowRunInBackground) {
    reasons.push("run_in_background=true is disabled");
  }

  if (hasStandaloneBackgroundOperator(command) && !allowAmpersand) {
    reasons.push("standalone & background operator is disabled");
  }

  if (reasons.length === 0) {
    process.exit(0);
  }

  const blocked = mode !== "allow";
  await notifyDiscord({ blocked, reasons, command });

  if (blocked) {
    console.error(`Bash safety policy blocked command: ${reasons.join("; ")}`);
    process.exit(2);
  }

  process.exit(0);
} catch {
  // Fail-open to avoid blocking all Bash calls on hook parse issues.
  process.exit(0);
}

export {};
