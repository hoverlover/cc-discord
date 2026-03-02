/**
 * Discord typing indicator management.
 * Tracks per-channel typing state; starts, stops, and times out indicators.
 */

import { THINKING_FALLBACK_ENABLED, THINKING_FALLBACK_TEXT, TYPING_INTERVAL_MS, TYPING_MAX_MS } from "./config.ts";

// Channel typing state: channelId -> { interval, timeout }
const typingSessions = new Map<
  string,
  { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }
>();

async function sendTypingOnce(client: any, channelId: string) {
  if (!channelId || !client.user) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || typeof channel.sendTyping !== "function") return;
    await channel.sendTyping();
  } catch (err: unknown) {
    const code = (err as any)?.code;
    if (code === 50001 || code === 50013) {
      // Missing Access or Missing Permissions — stop retrying this channel
      console.warn(`[Relay] typing indicator stopped for channel ${channelId}: ${(err as Error).message}`);
      const state = typingSessions.get(channelId);
      if (state) {
        clearInterval(state.interval);
        clearTimeout(state.timeout);
        typingSessions.delete(channelId);
      }
      return;
    }
    console.warn(`[Relay] typing indicator failed for channel ${channelId}: ${(err as Error).message}`);
  }
}

async function sendThinkingFallback(client: any, channelId: string, persistOutbound: (...args: any[]) => any) {
  if (!THINKING_FALLBACK_ENABLED) return;
  if (!channelId || !client.user) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    const sent = await channel.send(THINKING_FALLBACK_TEXT);
    persistOutbound({
      content: THINKING_FALLBACK_TEXT,
      channelId,
      externalId: sent.id,
      fromAgent: "relay",
    });
    console.log(`[Relay] thinking fallback sent in channel ${channelId}`);
  } catch (err: unknown) {
    console.warn(`[Relay] thinking fallback failed for channel ${channelId}: ${(err as Error).message}`);
  }
}

export function startTypingIndicator(client: any, channelId: string, persistOutbound: (...args: any[]) => any) {
  if (!channelId) return;
  if (typingSessions.has(channelId)) return;

  const startedAt = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - startedAt > TYPING_MAX_MS) {
      stopTypingIndicator(client, channelId, persistOutbound, "max-duration", { sendFallback: true });
      return;
    }
    void sendTypingOnce(client, channelId);
  }, TYPING_INTERVAL_MS);

  const timeout = setTimeout(() => {
    stopTypingIndicator(client, channelId, persistOutbound, "timeout", { sendFallback: true });
  }, TYPING_MAX_MS + 1000);

  typingSessions.set(channelId, { interval, timeout });
  void sendTypingOnce(client, channelId);
  console.log(`[Relay] typing indicator started for channel ${channelId}`);
}

export function stopTypingIndicator(
  client: any,
  channelId: string,
  persistOutbound: (...args: any[]) => any,
  reason: string = "completed",
  { sendFallback = false } = {},
) {
  const state = typingSessions.get(channelId);
  if (!state) return;
  clearInterval(state.interval);
  clearTimeout(state.timeout);
  typingSessions.delete(channelId);
  console.log(`[Relay] typing indicator stopped for channel ${channelId} (${reason})`);

  if (sendFallback) {
    void sendThinkingFallback(client, channelId, persistOutbound);
  }
}

export function stopAllTypingSessions(client: any, persistOutbound: (...args: any[]) => any) {
  for (const [channelId] of typingSessions) {
    stopTypingIndicator(client, channelId, persistOutbound, "shutdown");
  }
}
