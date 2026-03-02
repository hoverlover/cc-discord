/**
 * Busy queue notification: send a Discord message when Claude is working on another task
 * and a new message arrives.
 */

import {
  BUSY_NOTIFY_COOLDOWN_MS,
  BUSY_NOTIFY_MIN_DURATION_MS,
  BUSY_NOTIFY_ON_QUEUE,
  CLAUDE_AGENT_ID,
  DISCORD_SESSION_ID,
  MESSAGE_ROUTING_MODE,
} from "./config.ts";
import { getCurrentAgentActivity } from "./db.ts";

// Deduplicate busy queue notifications per activity window
const busyQueueNotifyCache = new Map<string, number>();

function isWaitActivity(row: any): boolean {
  const text = `${row?.activity_type || ""} ${row?.activity_summary || ""}`.toLowerCase();
  return text.includes("wait-for-discord-messages");
}

function isSleepActivity(row: any): boolean {
  const text = `${row?.activity_type || ""} ${row?.activity_summary || ""}`.toLowerCase();
  return /\bsleep\b/.test(text);
}

export function maybeNotifyBusyQueued(message: any, client: any, persistOutbound: (...args: any[]) => any) {
  if (!BUSY_NOTIFY_ON_QUEUE) return;

  // In channel routing mode, check the channel's subagent activity, not the orchestrator
  const channelAgentId = MESSAGE_ROUTING_MODE === "channel" ? message.channelId : null;
  const activity = channelAgentId
    ? getCurrentAgentActivity(DISCORD_SESSION_ID, CLAUDE_AGENT_ID, channelAgentId)
    : (getCurrentAgentActivity(DISCORD_SESSION_ID, CLAUDE_AGENT_ID) as any);
  if (!activity || activity.status !== "busy") return;
  if (isWaitActivity(activity)) return;
  if (isSleepActivity(activity)) return;

  // Only notify if the current activity has been running long enough to warrant it.
  // Short operations finish quickly and the agent will naturally address the message via steering prompts.
  const activityStart = activity.started_at ? new Date(activity.started_at).getTime() : 0;
  const now = Date.now();
  if (activityStart && now - activityStart < BUSY_NOTIFY_MIN_DURATION_MS) return;

  const activityKey = `${message.channelId}:${activity.started_at || activity.updated_at || activity.activity_summary || activity.activity_type || "busy"}`;
  const lastSent = busyQueueNotifyCache.get(activityKey) || 0;
  if (now - lastSent < BUSY_NOTIFY_COOLDOWN_MS) return;
  busyQueueNotifyCache.set(activityKey, now);

  const content = "👋 Got your message — I'll address it when my current task finishes.";

  void (async () => {
    try {
      const channel = await client.channels.fetch(message.channelId);
      if (!channel || !channel.isTextBased()) return;
      const sent = await channel.send(content);
      persistOutbound({
        content,
        channelId: message.channelId,
        externalId: sent.id,
        fromAgent: "relay",
      });
    } catch {
      // best effort only
    }
  })();
}
