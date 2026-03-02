/**
 * Live Trace Thread: creates a pinned thread per channel and posts batched
 * trace events (tool calls, status changes) so users can watch the agent work.
 *
 * Architecture:
 *   hooks write → trace_events table → flush loop reads → batches → posts to thread
 */

import {
  ChannelType,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import {
  TRACE_FLUSH_INTERVAL_MS,
  TRACE_THREAD_ENABLED,
  TRACE_THREAD_NAME,
} from "./config.ts";
import {
  getPendingTraceEvents,
  getTraceThreadId,
  markTraceEventsPosted,
  setTraceThreadId,
  type TraceEvent,
} from "./db.ts";

// In-memory cache of channel → thread to avoid DB lookups every flush
const threadCache = new Map<string, string>();

// Channels that failed with access errors — skip for a cooldown period
const failedChannels = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

let flushTimer: ReturnType<typeof setInterval> | null = null;

// ── Thread lifecycle ────────────────────────────────────────────────

/** Lock a thread if not already locked (idempotent). */
async function ensureLocked(thread: ThreadChannel): Promise<void> {
  try {
    if (!thread.locked) await thread.setLocked(true);
  } catch {
    // best-effort — bot may lack MANAGE_THREADS
  }
}

/**
 * Find or create the trace thread for a channel. Locks the thread so
 * only the bot (with MANAGE_THREADS) can post.
 */
async function ensureTraceThread(client: Client, channelId: string): Promise<ThreadChannel | null> {
  // Skip channels that recently failed with access errors
  const failedAt = failedChannels.get(channelId);
  if (failedAt && Date.now() - failedAt < FAILURE_COOLDOWN_MS) return null;

  // Check in-memory cache first
  const cachedThreadId = threadCache.get(channelId);
  if (cachedThreadId) {
    try {
      const thread = await client.channels.fetch(cachedThreadId);
      if (thread && thread.isThread()) {
        // Ensure thread is locked (idempotent — handles pre-existing unlocked threads)
        await ensureLocked(thread as ThreadChannel);
        return thread as ThreadChannel;
      }
    } catch {
      // Thread was deleted or inaccessible; fall through to re-create
      threadCache.delete(channelId);
    }
  }

  // Check DB
  const dbThreadId = getTraceThreadId(channelId);
  if (dbThreadId) {
    try {
      const thread = await client.channels.fetch(dbThreadId);
      if (thread && thread.isThread()) {
        // Ensure thread is locked
        await ensureLocked(thread as ThreadChannel);
        threadCache.set(channelId, dbThreadId);
        return thread as ThreadChannel;
      }
    } catch {
      // Thread was deleted; fall through to create
    }
  }

  // Create new thread
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.type !== ChannelType.GuildText) return null;

    const textChannel = channel as TextChannel;
    const thread = await textChannel.threads.create({
      name: TRACE_THREAD_NAME,
      autoArchiveDuration: 10080, // 7 days (max for non-boosted servers)
      reason: "Live trace thread for agent activity",
    });

    // Lock the thread so only moderators (i.e. the bot) can send messages.
    // Note: threads don't support permissionOverwrites — use setLocked() instead.
    try {
      await thread.setLocked(true);
    } catch {
      // May fail if bot lacks MANAGE_THREADS; continue anyway
    }

    // Pin an intro message
    try {
      const intro = await thread.send(
        `📡 **${TRACE_THREAD_NAME}**\n` +
          "This thread shows live agent activity — tool calls, status changes, and more.\n" +
          "It updates automatically. You can watch here while chatting in the main channel.",
      );
      await intro.pin();
    } catch {
      // best effort
    }

    // Persist
    setTraceThreadId(channelId, thread.id);
    threadCache.set(channelId, thread.id);
    return thread;
  } catch (err) {
    console.error(`[Trace] Failed to create trace thread for channel ${channelId}:`, err);
    return null;
  }
}

// ── Event formatting ────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  tool_start: "🔧",
  tool_end: "✅",
  status_busy: "⏳",
  status_idle: "💤",
  error: "❌",
};

function formatTraceEvent(event: TraceEvent): string {
  const icon = EVENT_ICONS[event.event_type] || "📌";
  const ts = formatTimestamp(event.created_at);
  const tool = event.tool_name ? ` \`${event.tool_name}\`` : "";
  const summary = event.summary ? ` — ${truncate(event.summary, 200)}` : "";
  return `${icon} \`${ts}\`${tool}${summary}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function truncate(text: string, maxLen: number): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

// ── Flush loop ──────────────────────────────────────────────────────

/**
 * Read pending trace events from DB, group by channel, and post batched
 * messages to each channel's trace thread.
 */
async function flushTraceEvents(client: Client) {
  if (!TRACE_THREAD_ENABLED) return;

  const events = getPendingTraceEvents(100);
  if (!events.length) return;

  // Group by channel
  const byChannel = new Map<string, TraceEvent[]>();
  for (const evt of events) {
    const ch = evt.channel_id || "unknown";
    const arr = byChannel.get(ch) || [];
    arr.push(evt);
    byChannel.set(ch, arr);
  }

  const postedIds: number[] = [];

  for (const [channelId, channelEvents] of byChannel) {
    if (channelId === "unknown") {
      // Skip events without a channel; mark as posted to avoid infinite retry
      postedIds.push(...channelEvents.map((e) => e.id));
      continue;
    }

    // Filter out noisy events (wait-for-discord-messages, sleep)
    const meaningful = channelEvents.filter((e) => {
      const text = `${e.tool_name || ""} ${e.summary || ""}`.toLowerCase();
      if (text.includes("wait-for-discord-messages")) return false;
      if (/\bsleep\b/.test(text)) return false;
      return true;
    });

    // Even if filtered out, mark all as posted
    postedIds.push(...channelEvents.map((e) => e.id));

    if (!meaningful.length) continue;

    try {
      const thread = await ensureTraceThread(client, channelId);
      if (!thread) continue;

      // Batch into a single message (Discord max 2000 chars)
      const lines = meaningful.map(formatTraceEvent);
      const batches = batchLines(lines, 1900);

      for (const batch of batches) {
        await thread.send(batch);
      }
    } catch (err) {
      const code = (err as any)?.code;
      if (code === 50001 || code === 50013) {
        // Missing Access or Missing Permissions — clear cache and back off
        console.warn(`[Trace] No access to trace thread for channel ${channelId} (${code}) — backing off 5m`);
        threadCache.delete(channelId);
        failedChannels.set(channelId, Date.now());
      } else {
        console.error(`[Trace] Failed to post trace events for channel ${channelId}:`, err);
      }
    }
  }

  markTraceEventsPosted(postedIds);
}

/** Split lines into batches that fit within maxLen characters */
function batchLines(lines: string[], maxLen: number): string[] {
  const batches: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen) {
      if (current) batches.push(current);
      current = line.length > maxLen ? line.slice(0, maxLen) : line;
    } else {
      current = next;
    }
  }

  if (current) batches.push(current);
  return batches;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start the periodic trace event flush loop.
 * Call once after the Discord client is ready.
 */
export function startTraceFlushLoop(client: Client) {
  if (!TRACE_THREAD_ENABLED) {
    console.log("[Trace] Trace thread feature is disabled.");
    return;
  }

  if (flushTimer) {
    clearInterval(flushTimer);
  }

  console.log(`[Trace] Starting flush loop (interval: ${TRACE_FLUSH_INTERVAL_MS}ms)`);

  flushTimer = setInterval(() => {
    flushTraceEvents(client).catch((err) => {
      console.error("[Trace] Flush error:", err);
    });
  }, TRACE_FLUSH_INTERVAL_MS);
}

/**
 * Stop the flush loop (for graceful shutdown).
 */
export function stopTraceFlushLoop() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
