#!/usr/bin/env bun

import { clearAgentActivityForSession } from "../server/db.ts";

const sessionId =
  process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || "default";

const cleared = clearAgentActivityForSession(sessionId);
console.log(`[reset-agent-activity] session=${sessionId} cleared=${cleared}`);
