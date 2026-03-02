#!/usr/bin/env bun

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { cleanupOldAttachments } from "./attachment.ts";
import { maybeNotifyBusyQueued } from "./busy-notify.ts";
import { catchUpMissedMessages } from "./catchup.ts";
import {
  ALLOWED_CHANNEL_IDS,
  ALLOWED_DISCORD_USER_IDS,
  BUSY_NOTIFY_COOLDOWN_MS,
  BUSY_NOTIFY_ON_QUEUE,
  DEFAULT_CHANNEL_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_SESSION_ID,
  IGNORED_CHANNEL_IDS,
  isAllowedChannel,
  isAllowedUser,
  MESSAGE_ROUTING_MODE,
  RELAY_ALLOW_NO_AUTH,
  RELAY_API_TOKEN,
  RELAY_HOST,
  RELAY_PORT,
  THINKING_FALLBACK_ENABLED,
  TYPING_INTERVAL_MS,
  TYPING_MAX_MS,
  validateConfig,
} from "./config.ts";
import { clearChannelModel, db, getAgentHealthAll, getChannelModel, setChannelModel } from "./db.ts";
import { memoryStore } from "./memory.ts";
import { persistInboundDiscordMessage, persistOutboundDiscordMessage } from "./messages.ts";
import { startTraceFlushLoop, stopTraceFlushLoop } from "./trace-thread.ts";
import { startTypingIndicator, stopAllTypingSessions, stopTypingIndicator } from "./typing.ts";

validateConfig();

// Run attachment cleanup every 10 minutes; also once at startup
setInterval(cleanupOldAttachments, 10 * 60 * 1000);
cleanupOldAttachments();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

function requireAuth(req: Request, res: Response): boolean {
  if (RELAY_ALLOW_NO_AUTH) return true;
  const token = req.header("x-api-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== RELAY_API_TOKEN) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── Discord client events ──────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`[Relay] Discord bot ready as ${client.user?.tag}`);
  console.log(
    `[Relay] Listening on channel(s): ${ALLOWED_CHANNEL_IDS.length > 0 ? ALLOWED_CHANNEL_IDS.join(", ") : DEFAULT_CHANNEL_ID}`,
  );
  console.log(
    `[Relay] User allowlist: ${ALLOWED_DISCORD_USER_IDS.length > 0 ? ALLOWED_DISCORD_USER_IDS.join(", ") : "disabled (all users in allowed channels)"}`,
  );
  console.log(`[Relay] API auth: ${RELAY_ALLOW_NO_AUTH ? "disabled (RELAY_ALLOW_NO_AUTH=true)" : "required"}`);
  console.log(`[Relay] Message routing: ${MESSAGE_ROUTING_MODE} mode`);
  console.log(
    `[Relay] Busy queue notify: ${BUSY_NOTIFY_ON_QUEUE ? `on (cooldown=${BUSY_NOTIFY_COOLDOWN_MS}ms)` : "off"}`,
  );
  console.log(
    `[Relay] Typing: interval=${TYPING_INTERVAL_MS}ms, max=${TYPING_MAX_MS}ms, fallback=${THINKING_FALLBACK_ENABLED ? "on" : "off"}`,
  );

  // Register /model slash command
  try {
    const modelCommand = new SlashCommandBuilder()
      .setName("model")
      .setDescription("Get or set the Claude model for this channel")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription(
            "Model name or alias (e.g. claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, or full model ID)",
          )
          .setRequired(false),
      );

    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN!);
    await rest.put(Routes.applicationCommands(client.user!.id), { body: [modelCommand.toJSON()] });
    console.log("[Relay] Registered /model slash command");
  } catch (err: unknown) {
    console.error("[Relay] Failed to register slash commands:", (err as Error).message);
  }

  // Start live trace thread flush loop
  startTraceFlushLoop(client);

  // Catch up messages missed while offline
  catchUpMissedMessages(client).catch((err) => {
    console.error("[Relay] Catch-up failed:", (err as Error).message);
  });
});

client.on("messageCreate", async (message) => {
  if (!message) return;
  if (message.author?.bot) return;
  if (!isAllowedChannel(message.channelId)) return;
  if (!isAllowedUser(message.author?.id)) {
    console.log(`[Relay] Ignoring message from unauthorized user ${message.author?.id}`);
    return;
  }
  startTypingIndicator(client, message.channelId, persistOutboundDiscordMessage);
  maybeNotifyBusyQueued(message, client, persistOutboundDiscordMessage);
  await persistInboundDiscordMessage(message);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "model") return;

  const modelArg = interaction.options.getString("name");

  if (!modelArg) {
    const current = getChannelModel(interaction.channelId);
    await interaction.reply(
      current ? `Current model for this channel: \`${current}\`` : "No model set for this channel (using default).",
    );
    return;
  }

  if (modelArg === "clear" || modelArg === "reset" || modelArg === "default") {
    clearChannelModel(interaction.channelId);
    await interaction.reply("Model override cleared for this channel. Using default model.");
    console.log(`[Relay] Model cleared for channel ${interaction.channelId} by ${interaction.user?.tag}`);
    return;
  }

  setChannelModel(interaction.channelId, modelArg, interaction.user?.tag || interaction.user?.id || null);
  await interaction.reply(`Model for this channel set to: \`${modelArg}\``);
  console.log(`[Relay] Model set for channel ${interaction.channelId}: ${modelArg} by ${interaction.user?.tag}`);
});

client.on("error", (err) => {
  console.error("[Relay] Discord client error:", err.message);
});

// ── Express HTTP API ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// Handle malformed JSON bodies cleanly
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (
    err?.type === "entity.parse.failed" ||
    (err instanceof SyntaxError && (err as any)?.status === 400 && "body" in err)
  ) {
    res.status(400).json({ success: false, error: "Invalid JSON body" });
    return;
  }
  next(err);
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    discordReady: Boolean(client.user),
    defaultChannelId: DEFAULT_CHANNEL_ID,
    sessionId: DISCORD_SESSION_ID,
  });
});

app.get("/api/channels", async (req: Request, res: Response) => {
  try {
    if (!requireAuth(req, res)) return;
    if (!client.user) {
      res.status(503).json({ success: false, error: "Discord client not ready yet" });
      return;
    }

    const channels: any[] = [];
    for (const [, guild] of client.guilds.cache) {
      const guildChannels = await guild.channels.fetch();
      for (const [, channel] of guildChannels) {
        if (!channel || !channel.isTextBased() || channel.isThread() || channel.isVoiceBased()) continue;
        if (IGNORED_CHANNEL_IDS.has(channel.id)) continue;
        if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(channel.id)) continue;
        channels.push({
          id: channel.id,
          name: channel.name,
          guildId: guild.id,
          guildName: guild.name,
          type: channel.type,
          model: getChannelModel(channel.id),
        });
      }
    }

    res.json({ success: true, channels });
  } catch (err: unknown) {
    console.error("[Relay] /api/channels failed:", err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.get("/api/agent-health", (req: Request, res: Response) => {
  try {
    if (!requireAuth(req, res)) return;
    const staleThreshold = Number(req.query.stale_threshold) || 900; // default 15 min
    const agents = getAgentHealthAll(DISCORD_SESSION_ID, staleThreshold);
    const stuckAgents = agents.filter((a: any) => a.stuck);
    res.json({
      success: true,
      sessionId: DISCORD_SESSION_ID,
      staleThresholdSeconds: staleThreshold,
      agents,
      stuckAgents: stuckAgents.map((a: any) => a.agentId),
      anyStuck: stuckAgents.length > 0,
    });
  } catch (err: unknown) {
    console.error("[Relay] /api/agent-health failed:", err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.post("/api/send", async (req: Request, res: Response) => {
  try {
    if (!requireAuth(req, res)) return;
    if (!client.user) {
      res.status(503).json({ success: false, error: "Discord client not ready yet" });
      return;
    }

    const { content, channelId, replyTo, fromAgent } = req.body || {};
    const text = String(content || "").trim();
    const targetChannelId = channelId || DEFAULT_CHANNEL_ID;

    if (!text) {
      res.status(400).json({ success: false, error: "Missing content" });
      return;
    }

    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased()) {
      res.status(400).json({ success: false, error: `Channel ${targetChannelId} not found or not text-based` });
      return;
    }

    let sent: any;
    if (replyTo && channel.messages?.fetch) {
      const original = await channel.messages.fetch(replyTo);
      sent = await original.reply(text);
    } else {
      if (!("send" in channel) || typeof channel.send !== "function") {
        res.status(400).json({ success: false, error: `Channel ${targetChannelId} does not support sending messages` });
        return;
      }
      sent = await channel.send(text);
    }

    persistOutboundDiscordMessage({ content: text, channelId: targetChannelId, externalId: sent.id, fromAgent });
    stopTypingIndicator(client, targetChannelId, persistOutboundDiscordMessage, "reply-sent");

    res.json({ success: true, messageId: sent.id, channelId: targetChannelId });
  } catch (err: unknown) {
    console.error("[Relay] /api/send failed:", err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Server startup ─────────────────────────────────────────────────────────────

const server = app.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(`[Relay] HTTP API running at http://${RELAY_HOST}:${RELAY_PORT}`);
});

client.login(DISCORD_BOT_TOKEN).catch((err: Error) => {
  console.error("[Relay] Failed to login to Discord:", err.message);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`\n[Relay] Received ${signal}. Shutting down...`);
  stopTraceFlushLoop();
  stopAllTypingSessions(client, persistOutboundDiscordMessage);
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    client.destroy();
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  void memoryStore.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
