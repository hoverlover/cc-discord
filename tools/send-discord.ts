#!/usr/bin/env bun

/**
 * Send a message to Discord via local relay.
 *
 * Usage:
 *   send-discord "hello world"
 *   send-discord --channel 1234567890 "hello"
 *   send-discord --reply 1234567890 "reply text"
 */

const args = process.argv.slice(2);
let channelId: string | null = null;
let replyTo: string | null = null;
const textParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(`
Usage: send-discord [--channel <id>] [--reply <messageId>] "message"

Options:
  --channel  Target channel ID (defaults to AGENT_ID env var)
  --reply    Message ID to reply to

Examples:
  send-discord "Build started"
  send-discord --channel 123456789012345678 "Hello from Claude"
  send-discord --reply 123456789012345678 "Thanks, on it"
`);
    process.exit(0);
  }
  if (arg === "--channel" && args[i + 1]) {
    channelId = args[++i];
    continue;
  }
  if (arg === "--reply" && args[i + 1]) {
    replyTo = args[++i];
    continue;
  }
  // Reject unrecognized flags — don't let them become message content
  if (arg.startsWith("--")) {
    console.error(`Unknown flag: ${arg}\nUse --help for usage.`);
    process.exit(1);
  }
  textParts.push(arg);
}

const content = textParts.join(" ").trim();
if (!content) {
  console.error(`
Usage: send-discord [--channel <id>] [--reply <messageId>] "message"

Examples:
  send-discord "Build started"
  send-discord --channel 123456789012345678 "Hello from Claude"
  send-discord --reply 123456789012345678 "Thanks, on it"
`);
  process.exit(1);
}

const relayHost = process.env.RELAY_HOST || "127.0.0.1";
const relayPort = process.env.RELAY_PORT || "3199";
const relayUrl = process.env.RELAY_URL || `http://${relayHost}:${relayPort}`;
const apiToken = process.env.RELAY_API_TOKEN || "";
const fromAgent = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (apiToken) {
  headers["x-api-token"] = apiToken;
}

try {
  const response = await fetch(`${relayUrl}/api/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content,
      channelId,
      replyTo,
      fromAgent,
    }),
  });

  const body: any = await response.json().catch(() => ({}));

  if (!response.ok || !body.success) {
    console.error(`Failed to send Discord message: ${body.error || response.statusText}`);
    process.exit(1);
  }

  console.log(`Discord message sent (channel=${body.channelId}, messageId=${body.messageId})`);
  process.exit(0);
} catch (err: unknown) {
  console.error(`Failed to call relay at ${relayUrl}: ${(err as Error).message}`);
  process.exit(1);
}

export {};
