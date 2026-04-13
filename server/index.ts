#!/usr/bin/env bun

import { Client, GatewayIntentBits, MessageType, REST, Routes, SlashCommandBuilder } from "discord.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { cleanupOldAttachments } from "./attachment.ts";
import { maybeNotifyBusyQueued } from "./busy-notify.ts";
import { catchUpMissedMessages } from "./catchup.ts";
import {
  ALLOWED_CHANNEL_IDS,
  ALLOWED_DISCORD_USER_IDS,
  ALLOWED_BOT_IDS,
  BUSY_NOTIFY_COOLDOWN_MS,
  BUSY_NOTIFY_ON_QUEUE,
  DEFAULT_CHANNEL_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_SESSION_ID,
  IGNORED_CHANNEL_IDS,
  isAllowedChannelForMessage,
  isAllowedPromptUser,
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
import { clearChannelModel, clearChannelPrompt, db, getAgentHealthAll, getChannelModel, getChannelPrompt, getUnservicedTargets, isTraceThread, setChannelModel, setChannelPrompt } from "./db.ts";
import { memoryStore } from "./memory.ts";
import { persistInboundDiscordMessage, persistOutboundDiscordMessage } from "./messages.ts";
import { shouldProcessMessage } from "./permissions.ts";
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
  console.log(
    `[Relay] Approved bots: ${ALLOWED_BOT_IDS.length > 0 ? ALLOWED_BOT_IDS.join(", ") : "none (all bots blocked)"}`,
  );
  console.log(`[Relay] API auth: ${RELAY_ALLOW_NO_AUTH ? "disabled (RELAY_ALLOW_NO_AUTH=true)" : "required"}`);
  console.log(`[Relay] Message routing: ${MESSAGE_ROUTING_MODE} mode`);
  console.log(
    `[Relay] Busy queue notify: ${BUSY_NOTIFY_ON_QUEUE ? `on (cooldown=${BUSY_NOTIFY_COOLDOWN_MS}ms)` : "off"}`,
  );
  console.log(
    `[Relay] Typing: interval=${TYPING_INTERVAL_MS}ms, max=${TYPING_MAX_MS}ms, fallback=${THINKING_FALLBACK_ENABLED ? "on" : "off"}`,
  );

  // Register slash commands
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

    const promptCommand = new SlashCommandBuilder()
      .setName("prompt")
      .setDescription("Manage the channel system prompt")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set or update the channel system prompt")
          .addStringOption((opt) =>
            opt.setName("text").setDescription("The system prompt text").setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName("view").setDescription("View the current channel system prompt"))
      .addSubcommand((sub) => sub.setName("clear").setDescription("Clear the channel system prompt"));

    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN!);
    const commandsBody = [modelCommand.toJSON(), promptCommand.toJSON()];

    // Clear old global commands to prevent duplicates when switching to guild commands
    try {
      await rest.put(Routes.applicationCommands(client.user!.id), { body: [] });
      console.log("[Relay] Cleared global slash commands");
    } catch (err: unknown) {
      console.error("[Relay] Failed to clear global slash commands:", (err as Error).message);
    }

    // Register guild-specific slash commands for instant propagation
    for (const [, guild] of client.guilds.cache) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user!.id, guild.id), { body: commandsBody });
        console.log(`[Relay] Registered slash commands in guild ${guild.name} (${guild.id})`);
      } catch (err: unknown) {
        console.error(`[Relay] Failed to register slash commands in guild ${guild.id}:`, (err as Error).message);
      }
    }
  } catch (err: unknown) {
    console.error("[Relay] Failed to build slash commands:", (err as Error).message);
  }

  // Start live trace thread flush loop
  startTraceFlushLoop(client);

  // Catch up messages missed while offline
  catchUpMissedMessages(client).catch((err) => {
    console.error("[Relay] Catch-up failed:", (err as Error).message);
  });
});

client.on("guildCreate", async (guild) => {
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

    const promptCommand = new SlashCommandBuilder()
      .setName("prompt")
      .setDescription("Manage the channel system prompt")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set or update the channel system prompt")
          .addStringOption((opt) => opt.setName("text").setDescription("The system prompt text").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("view").setDescription("View the current channel system prompt"))
      .addSubcommand((sub) => sub.setName("clear").setDescription("Clear the channel system prompt"));

    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN!);
    await rest.put(Routes.applicationGuildCommands(client.user!.id, guild.id), {
      body: [modelCommand.toJSON(), promptCommand.toJSON()],
    });
    console.log(`[Relay] Registered slash commands in new guild ${guild.name} (${guild.id})`);
  } catch (err: unknown) {
    console.error(`[Relay] Failed to register slash commands in new guild ${guild.id}:`, (err as Error).message);
  }
});

client.on("messageCreate", async (message) => {
  if (!message) return;

  const permission = shouldProcessMessage({
    authorId: message.author?.id,
    isBot: Boolean(message.author?.bot),
    allowedUserIds: ALLOWED_DISCORD_USER_IDS,
    allowedBotIds: ALLOWED_BOT_IDS,
  });

  if (!permission.shouldProcess) {
    if (message.author?.bot) {
      console.log(
        `[Relay] Ignoring message from unapproved bot ${message.author?.username} (${message.author?.id}) - ${permission.reason}`,
      );
    } else {
      console.log(`[Relay] Ignoring message from unauthorized user ${message.author?.id}`);
    }
    return;
  }

  if (message.author?.bot) {
    console.log(`[Relay] Processing message from approved bot ${message.author?.username} (${message.author?.id})`);
  }

  if (message.type === MessageType.ThreadCreated || message.type === MessageType.ThreadStarterMessage) return;
  if (!isAllowedChannelForMessage(message)) return;
  if (message.channel?.isThread?.() && isTraceThread(message.channelId)) return;
  
  startTypingIndicator(client, message.channelId, persistOutboundDiscordMessage);
  maybeNotifyBusyQueued(message, client, persistOutboundDiscordMessage);
  await persistInboundDiscordMessage(message);
});

client.on("messageUpdate", async (_oldMessage, newMessage) => {
  if (!newMessage?.channelId) return;
  const prompt = getChannelPrompt(newMessage.channelId);
  if (!prompt || prompt.messageId !== newMessage.id) return;

  if (!newMessage.pinned) {
    console.log(`[Relay] Pinned prompt was unpinned in ${newMessage.channelId}. Clearing prompt.`);
    clearChannelPrompt(newMessage.channelId);
    await notifyAndRestartAgent(newMessage.channelId, "cleared channel system prompt");
    return;
  }

  const text = newMessage.content?.trim() || "";
  if (text !== prompt.prompt) {
    console.log(`[Relay] Detected pinned prompt edit in ${newMessage.channelId}`);
    setChannelPrompt(newMessage.channelId, text, newMessage.id, null);
    await notifyAndRestartAgent(newMessage.channelId, "updated channel system prompt");
  }
});

client.on("messageDelete", async (message) => {
  if (!message?.channelId) return;
  const prompt = getChannelPrompt(message.channelId);
  if (!prompt || prompt.messageId !== message.id) return;

  console.log(`[Relay] Pinned prompt was deleted in ${message.channelId}. Clearing prompt.`);
  clearChannelPrompt(message.channelId);
  await notifyAndRestartAgent(message.channelId, "cleared channel system prompt");
});

async function notifyAndRestartAgent(channelId: string, reason: string) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      const sent = await (channel as any).send(`Restarting to apply ${reason}...`);
      persistOutboundDiscordMessage({ content: sent.content, channelId, externalId: sent.id });
    }
  } catch (err) {
    console.error(`[Relay] Failed to send restart notification for ${channelId}:`, (err as Error).message);
  }

  try {
    const pidFile = `/tmp/cc-discord/agent-${channelId}.pid`;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
      console.log(`[Relay] Sent SIGTERM to agent for ${channelId} (PID ${pid})`);
    }
  } catch (err) {
    console.error(`[Relay] Failed to kill agent for ${channelId}:`, (err as Error).message);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "model") {
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
    return;
  }

  if (interaction.commandName === "prompt") {
    if (!isAllowedPromptUser(interaction.user?.id)) {
      await interaction.reply({ content: "You are not authorized to manage channel prompts.", ephemeral: true });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "view") {
      const current = getChannelPrompt(interaction.channelId);
      if (!current) {
        await interaction.reply("No custom system prompt is set for this channel.");
        return;
      }
      const text = current.prompt.length > 1800 ? current.prompt.slice(0, 1800) + "..." : current.prompt;
      await interaction.reply(`Current channel system prompt:\n\n${text}`);
      return;
    }

    if (subcommand === "clear") {
      const existing = getChannelPrompt(interaction.channelId);
      if (existing) {
        clearChannelPrompt(interaction.channelId);
        try {
          const channel = await client.channels.fetch(interaction.channelId);
          if (channel?.isTextBased() && "messages" in channel) {
            const msg = await (channel as any).messages.fetch(existing.messageId);
            if (msg) await msg.unpin();
          }
        } catch {
          // ignore unpin failures
        }
      }
      await interaction.reply("Channel system prompt cleared.");
      console.log(`[Relay] Prompt cleared for channel ${interaction.channelId} by ${interaction.user?.tag}`);
      await notifyAndRestartAgent(interaction.channelId, "cleared channel system prompt");
      return;
    }

    if (subcommand === "set") {
      const text = interaction.options.getString("text", true).trim();
      if (!text) {
        await interaction.reply({ content: "Prompt text cannot be empty.", ephemeral: true });
        return;
      }

      const channel = await client.channels.fetch(interaction.channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        await interaction.reply({ content: "Cannot send messages in this channel.", ephemeral: true });
        return;
      }

      const promptMessage = await (channel as any).send(text);
      await promptMessage.pin();

      const existing = getChannelPrompt(interaction.channelId);
      setChannelPrompt(interaction.channelId, text, promptMessage.id, interaction.user?.id || null);

      if (existing) {
        try {
          const oldMsg = await (channel as any).messages.fetch(existing.messageId);
          if (oldMsg) await oldMsg.delete();
        } catch {
          // ignore delete failures
        }
      }

      await interaction.reply("Channel system prompt updated. Restarting agent...");
      console.log(`[Relay] Prompt set for channel ${interaction.channelId} by ${interaction.user?.tag}`);
      await notifyAndRestartAgent(interaction.channelId, "updated channel system prompt");
      return;
    }
  }
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

    // Optionally include active threads in allowed channels
    if (req.query.include_threads === "true") {
      for (const ch of [...channels]) {
        try {
          const parentChannel = await client.channels.fetch(ch.id);
          if (parentChannel && "threads" in parentChannel) {
            const activeThreads = await (parentChannel as any).threads.fetchActive();
            for (const [, thread] of activeThreads.threads) {
              if (isTraceThread(thread.id)) continue;
              channels.push({
                id: thread.id,
                name: thread.name,
                guildId: ch.guildId,
                guildName: ch.guildName,
                type: thread.type,
                isThread: true,
                parentChannelId: ch.id,
                parentChannelName: ch.name,
                model: getChannelModel(thread.id),
              });
            }
          }
        } catch {
          /* skip */
        }
      }
    }

    res.json({ success: true, channels });
  } catch (err: unknown) {
    console.error("[Relay] /api/channels failed:", err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

app.get("/api/channels/:channelId/pinned-prompt", async (req: Request, res: Response) => {
  try {
    if (!requireAuth(req, res)) return;
    if (!client.user) {
      res.status(503).json({ success: false, error: "Discord client not ready yet" });
      return;
    }

    const { channelId } = req.params;

    // Prefer database record (source of truth for slash-command-managed prompts)
    const dbPrompt = getChannelPrompt(channelId);
    if (dbPrompt) {
      res.json({ success: true, prompt: dbPrompt.prompt, messageId: dbPrompt.messageId, channelId });
      return;
    }

    // Legacy fallback: scan pinned messages for !system / !prompt prefix
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      res.status(400).json({ success: false, error: `Channel ${channelId} not found or not text-based` });
      return;
    }

    const pinned = await (channel as any).messages.fetchPinned();
    let prompt: string | null = null;
    let messageId: string | null = null;
    for (const [, msg] of pinned) {
      const text = msg.content?.trim() || "";
      const match = text.match(/^!(?:system|prompt)\s+(.*)/is);
      if (match) {
        prompt = match[1].trim();
        messageId = msg.id;
        break;
      }
    }

    res.json({ success: true, prompt, messageId, channelId });
  } catch (err: unknown) {
    console.error("[Relay] /api/channels/:channelId/pinned-prompt failed:", err);
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

app.get("/api/unserviced", (req: Request, res: Response) => {
  try {
    if (!requireAuth(req, res)) return;
    const targets = getUnservicedTargets(DISCORD_SESSION_ID);
    res.json({ success: true, targets });
  } catch (err: unknown) {
    console.error("[Relay] /api/unserviced failed:", err);
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
