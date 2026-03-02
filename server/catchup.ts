/**
 * Catch-up: fetch recent messages from allowed channels on startup
 * to fill in any messages missed while the relay was offline.
 */

import type { Client } from "discord.js";
import { CATCHUP_MESSAGE_LIMIT, IGNORED_CHANNEL_IDS, ALLOWED_CHANNEL_IDS, isAllowedUser } from "./config.ts";
import { persistInboundDiscordMessage, persistOutboundDiscordMessage } from "./messages.ts";
import { startTypingIndicator } from "./typing.ts";

export async function catchUpMissedMessages(client: Client) {
  if (CATCHUP_MESSAGE_LIMIT <= 0) {
    console.log("[Catchup] Disabled (CATCHUP_MESSAGE_LIMIT=0)");
    return;
  }

  let channelsScanned = 0;
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
          .filter((m) => !m.author.bot && isAllowedUser(m.author.id))
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
    }
  }

  console.log(`[Catchup] Done — scanned ${channelsScanned} channel(s), caught up ${messagesCaughtUp} message(s)`);
}
