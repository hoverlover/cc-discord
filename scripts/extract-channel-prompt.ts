#!/usr/bin/env bun

import { parseChannelPromptApiResponse } from "../server/channel-prompts.ts";

const input = await Bun.stdin.text();
const result = parseChannelPromptApiResponse(input);

if (result.status === "gone") {
  process.exit(2);
}

if (result.status === "invalid") {
  console.error(result.reason);
  process.exit(1);
}

process.stdout.write(result.prompt);
