/**
 * Catch-up: fetch recent messages from allowed channels on startup
 * to fill in any messages missed while the relay was offline.
 */

import type { Client } from "discord.js";
import {
  ALLOWED_BOT_IDS,
  ALLOWED_CHANNEL_IDS,
  ALLOWED_DISCORD_USER_IDS,
  CATCHUP_MESSAGE_LIMIT,
  IGNORED_CHANNEL_IDS,
  TRACE_THREAD_NAME,
} from "./config.ts";
import { isTraceThread } from "./db.ts";
import { persistInboundDiscordMessage, persistOutboundDiscordMessage } from "./messages.ts";
import { shouldProcessMessage } from "./permissions.ts";
import { startTypingIndicator } from "./typing.ts";

export function shouldCatchUpMessage(
  message: { author?: { id?: string; bot?: boolean } },
  config: {
    allowedUserIds?: string[];
    allowedBotIds?: string[];
  } = {},
): boolean {
  const permission = shouldProcessMessage({
    authorId: message.author?.id,
    isBot: Boolean(message.author?.bot),
    allowedUserIds: config.allowedUserIds ?? ALLOWED_DISCORD_USER_IDS,
    allowedBotIds: config.allowedBotIds ?? ALLOWED_BOT_IDS,
  });

  return permission.shouldProcess;
}

export async function catchUpMissedMessages(client: Client) {
  if (CATCHUP_MESSAGE_LIMIT <= 0) {
    console.log("[Catchup] Disabled (CATCHUP_MESSAGE_LIMIT=0)");
    return;
  }

  let channelsScanned = 0;
  let threadsCaughtUp = 0;
  let messagesCaughtUp = 0;

  for (const [, guild] of client.guilds.cache) {
    const guildChannels = await guild.channels.fetch();
    for (const [, channel] of guildChannels) {
      if (!channel || !channel.isTextBased() || channel.isThread() || channel.isVoiceBased()) continue;
      if (IGNORED_CHANNEL_IDS.has(channel.id)) continue;
      if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(channel.id)) continue;

      try {
        const messages = await channel.messages.fetch({ limit: CATCHUP_MESSAGE_LIMIT });
        channelsScanned++;

        // Sort oldest-first so they're persisted in chronological order
        const sorted = [...messages.values()]
          .filter((m) => shouldCatchUpMessage(m))
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        let channelHasNew = false;
        for (const msg of sorted) {
          const isNew = await persistInboundDiscordMessage(msg);
          if (isNew) {
            messagesCaughtUp++;
            channelHasNew = true;
          }
        }
        if (channelHasNew) {
          startTypingIndicator(client, channel.id, persistOutboundDiscordMessage);
        }
      } catch (err: unknown) {
        console.error(`[Catchup] Failed to fetch messages for #${channel.name} (${channel.id}):`, (err as Error).message);
      }

      // Catch up active threads in this channel
      if ("threads" in channel && channel.threads) {
        try {
          const activeThreads = await (channel as any).threads.fetchActive();
          for (const [, thread] of activeThreads.threads) {
            if (thread.name === TRACE_THREAD_NAME || isTraceThread(thread.id)) continue;
            try {
              const threadMessages = await thread.messages.fetch({ limit: CATCHUP_MESSAGE_LIMIT });
              threadsCaughtUp++;
              const sorted = [...threadMessages.values()]
                .filter((m: any) => shouldCatchUpMessage(m))
                .sort((a: any, b: any) => a.createdTimestamp - b.createdTimestamp);
              let threadHasNew = false;
              for (const msg of sorted) {
                const isNew = await persistInboundDiscordMessage(msg);
                if (isNew) {
                  messagesCaughtUp++;
                  threadHasNew = true;
                }
              }
              if (threadHasNew) {
                startTypingIndicator(client, thread.id, persistOutboundDiscordMessage);
              }
            } catch (err: unknown) {
              console.error(`[Catchup] Failed for thread "${thread.name}" (${thread.id}):`, (err as Error).message);
            }
          }
        } catch (err: unknown) {
          console.error(`[Catchup] Failed to fetch threads for #${(channel as any).name}:`, (err as Error).message);
        }
      }
    }
  }

  console.log(`[Catchup] Done — scanned ${channelsScanned} channel(s), ${threadsCaughtUp} thread(s), caught up ${messagesCaughtUp} message(s)`);
}
