#!/usr/bin/env bun

/**
 * Send an iMessage via macOS Messages.app using AppleScript.
 *
 * Usage:
 *   send-imessage --to "+14175551234" "Hello from Alfred!"
 *   send-imessage --to "+14175551234" --sms "This goes as SMS"
 *   send-imessage --to "user@icloud.com" "Hello via Apple ID"
 */

import { $ } from "bun";

const args = process.argv.slice(2);
let to: string | null = null;
let useSms = false;
const textParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--to" && args[i + 1]) {
    to = args[++i];
    continue;
  }
  if (arg === "--sms") {
    useSms = true;
    continue;
  }
  if (arg === "--help" || arg === "-h") {
    console.log(`
Usage: send-imessage --to <phone_or_appleid> [--sms] "message"

Options:
  --to    Phone number (with country code, e.g. +14175551234) or Apple ID email
  --sms   Force SMS instead of iMessage (uses SMS service)

Examples:
  send-imessage --to "+14175551234" "Hello!"
  send-imessage --to "user@icloud.com" "Hey there"
  send-imessage --to "+14175551234" --sms "SMS fallback"
`);
    process.exit(0);
  }
  textParts.push(arg);
}

const message = textParts.join(" ").trim();

if (!to) {
  console.error("Error: --to is required. Use --help for usage.");
  process.exit(1);
}

if (!message) {
  console.error("Error: message text is required. Use --help for usage.");
  process.exit(1);
}

// Normalize phone number: ensure it starts with +1 if it's a 10-digit US number
let normalizedTo = to;
if (/^\d{10}$/.test(to)) {
  normalizedTo = `+1${to}`;
} else if (/^1\d{10}$/.test(to)) {
  normalizedTo = `+${to}`;
}

// Escape single quotes for AppleScript
const escapedMessage = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const escapedTo = normalizedTo.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Build AppleScript
const serviceFilter = useSms
  ? 'service type = SMS'
  : 'service type = iMessage';

const script = `tell application "Messages" to send "${escapedMessage}" to buddy "${escapedTo}" of (1st service whose ${serviceFilter})`;

try {
  const result = await $`osascript -e ${script}`.quiet();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    console.error(`Failed to send iMessage: ${stderr}`);
    process.exit(1);
  }

  console.log(`iMessage sent to ${normalizedTo}: "${message}"`);
  process.exit(0);
} catch (err: unknown) {
  const error = err as Error & { stderr?: Buffer };
  const stderr = error.stderr?.toString().trim() || error.message;
  console.error(`Failed to send iMessage: ${stderr}`);
  process.exit(1);
}

export {};
