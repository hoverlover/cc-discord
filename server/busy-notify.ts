/**
 * Busy queue notification: send a Discord message when Claude is working on another task
 * and a new message arrives.
 */

import {
  BUSY_NOTIFY_COOLDOWN_MS,
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

function truncateText(value: string, maxLen: number = 140): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
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

  const activityKey = `${message.channelId}:${activity.started_at || activity.updated_at || activity.activity_summary || activity.activity_type || "busy"}`;
  const now = Date.now();
  const lastSent = busyQueueNotifyCache.get(activityKey) || 0;
  if (now - lastSent < BUSY_NOTIFY_COOLDOWN_MS) return;
  busyQueueNotifyCache.set(activityKey, now);

  const summary = truncateText(activity.activity_summary || activity.activity_type || "another task");
  const content = `⏳ Currently busy with: \`${summary}\`\nI queued your message and will reply when done.`;

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
