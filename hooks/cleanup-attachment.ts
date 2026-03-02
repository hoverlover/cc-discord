#!/usr/bin/env bun
/**
 * Claude Code hook: clean up downloaded Discord attachment files after they are read.
 *
 * Runs on PostToolUse for the Read tool. If the file path is inside
 * /tmp/cc-discord/attachments/, delete it to keep the filesystem clean.
 */

import { existsSync, unlinkSync } from "node:fs";

const ATTACHMENT_DIR = "/tmp/cc-discord/attachments/";

let hookInput: any;
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  hookInput = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

const toolName = hookInput.tool_name || hookInput.toolName || "";
const toolInput = hookInput.tool_input || hookInput.toolInput || {};

// Only act on Read tool calls
if (toolName !== "Read") {
  process.exit(0);
}

const filePath = toolInput.file_path || toolInput.path || "";

// Only clean up files in our attachment directory
if (!filePath.startsWith(ATTACHMENT_DIR)) {
  process.exit(0);
}

try {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    // No console output to keep hook silent
  }
} catch {
  // fail-open: if we can't delete, the TTL cleanup in the relay will handle it
}

process.exit(0);
