/**
 * Memory integration for the relay server.
 * Persists inbound/outbound turns and assembles memory context for context injection.
 *
 * Session key strategy:
 * When a channelId is provided, turns are written to a per-channel key
 * (discord:{sessionId}:{channelId}) so that per-channel subagents can
 * retrieve them. This matches the key that wait-for-discord-messages
 * uses on the read side (agentId = channelId).
 *
 * When no channelId is available, falls back to the legacy shared key
 * (discord:{sessionId}:{CLAUDE_AGENT_ID}).
 */

import { join } from "node:path";
import { MemoryCoordinator } from "../memory/core/MemoryCoordinator.ts";
import { buildMemorySessionKey } from "../memory/core/session-key.ts";
import { SqliteMemoryStore } from "../memory/providers/sqlite/SqliteMemoryStore.ts";
import { CLAUDE_AGENT_ID, DATA_DIR, DISCORD_SESSION_ID } from "./config.ts";

/** Legacy fallback key for turns without a channel association. */
const fallbackSessionKey = buildMemorySessionKey({
  sessionId: DISCORD_SESSION_ID,
  agentId: CLAUDE_AGENT_ID,
});

export const memoryStore = new SqliteMemoryStore({
  dbPath: join(DATA_DIR, "memory.db"),
  logger: console,
});

export const memory = new MemoryCoordinator({
  store: memoryStore,
  logger: console,
});

await memory.init();

/**
 * Resolve the memory session key for a turn.
 * If channelId is available, produces a per-channel key matching what
 * the subagent's wait-for-discord-messages will query.
 */
function resolveSessionKey(channelId?: string): string {
  if (channelId) {
    // Subagents set AGENT_ID=channelId and build their key as:
    //   buildMemorySessionKey({ sessionId, agentId: channelId })
    // => discord:{sessionId}:{channelId}
    return buildMemorySessionKey({
      sessionId: DISCORD_SESSION_ID,
      agentId: channelId,
    });
  }
  return fallbackSessionKey;
}

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

    const result = await memory.appendTurn({
      sessionKey,
      agentId: channelId || CLAUDE_AGENT_ID,
      role,
      content,
      metadata: {
        ...metadata,
        runtimeContextId: runtimeState?.runtimeContextId || null,
        runtimeEpoch: runtimeState?.runtimeEpoch || null,
      },
    });
    console.log(
      `[Memory] persisted ${role} turn to ${sessionKey} (batch=${result?.batchId}, turns=${result?.counts?.turns})`,
    );
  } catch (err: unknown) {
    console.error("[Memory] failed to persist turn:", (err as Error).message);
  }
}
