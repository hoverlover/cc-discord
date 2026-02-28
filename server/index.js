#!/usr/bin/env node

// Suppress Node.js ExperimentalWarning (SQLite) so logs stay clean
const _origEmit = process.emit
process.emit = function (event, ...args) {
  if (event === 'warning' && args[0]?.name === 'ExperimentalWarning') return false
  return _origEmit.call(this, event, ...args)
}

import express from 'express'
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteMemoryStore } from '../memory/providers/sqlite/SqliteMemoryStore.js'
import { MemoryCoordinator } from '../memory/core/MemoryCoordinator.js'
import { buildMemorySessionKey } from '../memory/core/session-key.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = join(__dirname, '..')
const DATA_DIR = join(ROOT_DIR, 'data')

// Preferred split env file for relay process; keep legacy fallback for compatibility.
loadDotEnv(join(ROOT_DIR, '.env.relay'))
loadDotEnv(join(ROOT_DIR, '.env'))

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID
const ALLOWED_CHANNEL_IDS = (process.env.DISCORD_ALLOWED_CHANNEL_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const IGNORED_CHANNEL_IDS = new Set(
  (process.env.DISCORD_IGNORED_CHANNEL_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
)
const ALLOWED_DISCORD_USER_IDS = (process.env.ALLOWED_DISCORD_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// Model alias map: short names -> full Claude API model IDs
const MODEL_ALIASES = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
  'opus-4.6': 'claude-opus-4-6',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'haiku-4.5': 'claude-haiku-4-5-20251001',
  'opus-4.5': 'claude-opus-4-5-20251101',
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'opus-4.1': 'claude-opus-4-1-20250805',
  'sonnet-4': 'claude-sonnet-4-20250514',
  'opus-4': 'claude-opus-4-20250514',
}

function resolveModelAlias(input) {
  const normalized = String(input || '').trim().toLowerCase()
  return MODEL_ALIASES[normalized] || input
}

const DISCORD_SESSION_ID = process.env.DISCORD_SESSION_ID || 'default'
const CLAUDE_AGENT_ID = process.env.CLAUDE_AGENT_ID || 'claude'

const RELAY_HOST = process.env.RELAY_HOST || '127.0.0.1'
const RELAY_PORT = Number(process.env.RELAY_PORT || 3199)
const RELAY_API_TOKEN = process.env.RELAY_API_TOKEN || ''
const RELAY_ALLOW_NO_AUTH = String(process.env.RELAY_ALLOW_NO_AUTH || 'false').toLowerCase() === 'true'

// Discord typing indicator settings (prototype defaults)
const TYPING_INTERVAL_MS = Number(process.env.TYPING_INTERVAL_MS || 8000)
const TYPING_MAX_MS = Number(process.env.TYPING_MAX_MS || 120000)
const THINKING_FALLBACK_ENABLED = String(process.env.THINKING_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false'
const THINKING_FALLBACK_TEXT = process.env.THINKING_FALLBACK_TEXT || 'Still working on that—thanks for your patience.'

// Busy-queue notifications when Claude is blocked on another tool
const BUSY_NOTIFY_ON_QUEUE = String(process.env.BUSY_NOTIFY_ON_QUEUE || 'true').toLowerCase() !== 'false'
const BUSY_NOTIFY_COOLDOWN_MS = Number(process.env.BUSY_NOTIFY_COOLDOWN_MS || 30000)

if (!DISCORD_BOT_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN (set in .env.relay or env var).')
  process.exit(1)
}

if (!DEFAULT_CHANNEL_ID) {
  console.error('Missing DISCORD_CHANNEL_ID (set in .env.relay or env var).')
  process.exit(1)
}

if (!RELAY_API_TOKEN && !RELAY_ALLOW_NO_AUTH) {
  console.error('Missing RELAY_API_TOKEN. Set RELAY_API_TOKEN in .env.relay (recommended), or explicitly set RELAY_ALLOW_NO_AUTH=true for local-only dev.')
  process.exit(1)
}

mkdirSync(DATA_DIR, { recursive: true })
const db = new DatabaseSync(join(DATA_DIR, 'messages.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message_type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'discord',
    external_id TEXT,
    channel_id TEXT,
    read INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_activity (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    activity_type TEXT,
    activity_summary TEXT,
    started_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
  CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(read);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_external
    ON messages(source, external_id);
  CREATE INDEX IF NOT EXISTS idx_agent_activity_status
    ON agent_activity(status);

  CREATE TABLE IF NOT EXISTS channel_models (
    channel_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
  );
`)

const insertStmt = db.prepare(`
  INSERT INTO messages (
    session_id,
    from_agent,
    to_agent,
    message_type,
    content,
    source,
    external_id,
    channel_id,
    read
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

// DB-backed channel model helpers
function getChannelModel(channelId) {
  try {
    const row = db.prepare('SELECT model FROM channel_models WHERE channel_id = ?').get(channelId)
    return row?.model || null
  } catch {
    return null
  }
}

function setChannelModel(channelId, model, updatedBy) {
  db.prepare(`
    INSERT INTO channel_models (channel_id, model, updated_at, updated_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      model = excluded.model,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(channelId, model, updatedBy || null)
}

function clearChannelModel(channelId) {
  db.prepare('DELETE FROM channel_models WHERE channel_id = ?').run(channelId)
}

const memorySessionKey = buildMemorySessionKey({
  sessionId: DISCORD_SESSION_ID,
  agentId: CLAUDE_AGENT_ID,
})

const memoryStore = new SqliteMemoryStore({
  dbPath: join(DATA_DIR, 'memory.db'),
  logger: console,
})

const memory = new MemoryCoordinator({
  store: memoryStore,
  logger: console,
})

await memory.init()

async function appendMemoryTurn({ role, content, metadata = {} }) {
  try {
    const runtimeState = await memoryStore.readRuntimeState(memorySessionKey)

    const result = await memory.appendTurn({
      sessionKey: memorySessionKey,
      agentId: CLAUDE_AGENT_ID,
      role,
      content,
      metadata: {
        ...metadata,
        runtimeContextId: runtimeState?.runtimeContextId || null,
        runtimeEpoch: runtimeState?.runtimeEpoch || null,
      },
    })
    console.log(`[Memory] persisted ${role} turn (batch=${result?.batchId}, turns=${result?.counts?.turns})`)
  } catch (err) {
    console.error('[Memory] failed to persist turn:', err.message)
  }
}

function isAllowedChannel(channelId) {
  if (!channelId) return false
  // Deny takes precedence
  if (IGNORED_CHANNEL_IDS.has(channelId)) return false
  // If an explicit allowlist is set, use it; otherwise allow all
  if (ALLOWED_CHANNEL_IDS.length > 0) {
    return ALLOWED_CHANNEL_IDS.includes(channelId)
  }
  return true
}

function isAllowedUser(userId) {
  if (!userId) return false
  if (ALLOWED_DISCORD_USER_IDS.length === 0) return true
  return ALLOWED_DISCORD_USER_IDS.includes(userId)
}

function getCurrentAgentActivity() {
  try {
    return db.prepare(`
      SELECT status, activity_type, activity_summary, started_at, updated_at
      FROM agent_activity
      WHERE session_id = ? AND agent_id = ?
      LIMIT 1
    `).get(DISCORD_SESSION_ID, CLAUDE_AGENT_ID)
  } catch {
    return null
  }
}

function isWaitActivity(row) {
  const text = `${row?.activity_type || ''} ${row?.activity_summary || ''}`.toLowerCase()
  return text.includes('wait-for-discord-messages')
}

function truncateText(value, maxLen = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function maybeNotifyBusyQueued(message) {
  if (!BUSY_NOTIFY_ON_QUEUE) return

  const activity = getCurrentAgentActivity()
  if (!activity || activity.status !== 'busy') return
  if (isWaitActivity(activity)) return

  const activityKey = `${message.channelId}:${activity.started_at || activity.updated_at || activity.activity_summary || activity.activity_type || 'busy'}`
  const now = Date.now()
  const lastSent = busyQueueNotifyCache.get(activityKey) || 0
  if (now - lastSent < BUSY_NOTIFY_COOLDOWN_MS) return
  busyQueueNotifyCache.set(activityKey, now)

  const summary = truncateText(activity.activity_summary || activity.activity_type || 'another task')
  const content = `⏳ Currently busy with: \`${summary}\`\nI queued your message and will reply when done.`

  void (async () => {
    try {
      const channel = await client.channels.fetch(message.channelId)
      if (!channel || !channel.isTextBased()) return
      const sent = await channel.send(content)
      persistOutboundDiscordMessage({
        content,
        channelId: message.channelId,
        externalId: sent.id,
        fromAgent: 'relay',
      })
    } catch {
      // best effort only
    }
  })()
}

function formatInboundMessage(message) {
  const author = message.author?.username || message.author?.globalName || message.author?.id || 'unknown'
  const base = message.content?.trim() || ''
  const attachments = [...message.attachments.values()].map(a => a.url)

  let fullText = base
  if (attachments.length > 0) {
    const attachmentLines = attachments.map(url => `Attachment: ${url}`).join('\n')
    fullText = fullText ? `${fullText}\n${attachmentLines}` : attachmentLines
  }

  if (!fullText) {
    fullText = '[No text content]'
  }

  return `${author}: ${fullText}`
}

function persistInboundDiscordMessage(message) {
  const normalizedContent = formatInboundMessage(message)

  try {
    insertStmt.run(
      DISCORD_SESSION_ID,
      `discord:${message.author?.id || 'unknown'}`,
      CLAUDE_AGENT_ID,
      'DISCORD_MESSAGE',
      normalizedContent,
      'discord',
      message.id,
      message.channelId,
      0
    )

    void appendMemoryTurn({
      role: 'user',
      content: normalizedContent,
      metadata: {
        source: 'discord',
        messageId: message.id,
        channelId: message.channelId,
        authorId: message.author?.id || null,
      },
    })

    console.log(`[Relay] queued Discord message ${message.id} -> ${CLAUDE_AGENT_ID}`)
  } catch (err) {
    const msg = String(err?.message || '')
    if (msg.includes('UNIQUE constraint failed')) {
      // Discord can re-deliver in edge cases; idempotent ignore
      return
    }
    console.error('[Relay] failed to persist inbound message:', err.message)
  }
}

function persistOutboundDiscordMessage({ content, channelId, externalId, fromAgent }) {
  const normalizedContent = String(content)
  const normalizedFromAgent = fromAgent || CLAUDE_AGENT_ID
  const normalizedChannelId = channelId || DEFAULT_CHANNEL_ID

  try {
    insertStmt.run(
      DISCORD_SESSION_ID,
      normalizedFromAgent,
      'discord',
      'DISCORD_REPLY',
      normalizedContent,
      'relay-outbound',
      externalId || null,
      normalizedChannelId,
      1
    )

    void appendMemoryTurn({
      role: 'assistant',
      content: normalizedContent,
      metadata: {
        source: 'discord',
        messageId: externalId || null,
        channelId: normalizedChannelId,
        fromAgent: normalizedFromAgent,
      },
    })
  } catch (err) {
    console.error('[Relay] failed to persist outbound message:', err.message)
  }
}

// Channel typing state: channelId -> { interval, timeout }
const typingSessions = new Map()
// Deduplicate busy queue notifications per activity window
const busyQueueNotifyCache = new Map()

async function sendTypingOnce(channelId) {
  if (!channelId || !client.user) return
  try {
    const channel = await client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased() || typeof channel.sendTyping !== 'function') return
    await channel.sendTyping()
  } catch (err) {
    console.warn(`[Relay] typing indicator failed for channel ${channelId}: ${err.message}`)
  }
}

async function sendThinkingFallback(channelId) {
  if (!THINKING_FALLBACK_ENABLED) return
  if (!channelId || !client.user) return
  try {
    const channel = await client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased()) return
    const sent = await channel.send(THINKING_FALLBACK_TEXT)
    persistOutboundDiscordMessage({
      content: THINKING_FALLBACK_TEXT,
      channelId,
      externalId: sent.id,
      fromAgent: 'relay'
    })
    console.log(`[Relay] thinking fallback sent in channel ${channelId}`)
  } catch (err) {
    console.warn(`[Relay] thinking fallback failed for channel ${channelId}: ${err.message}`)
  }
}

function startTypingIndicator(channelId) {
  if (!channelId) return
  if (typingSessions.has(channelId)) return

  const startedAt = Date.now()
  const interval = setInterval(() => {
    if (Date.now() - startedAt > TYPING_MAX_MS) {
      stopTypingIndicator(channelId, 'max-duration', { sendFallback: true })
      return
    }
    void sendTypingOnce(channelId)
  }, TYPING_INTERVAL_MS)

  const timeout = setTimeout(() => {
    stopTypingIndicator(channelId, 'timeout', { sendFallback: true })
  }, TYPING_MAX_MS + 1000)

  typingSessions.set(channelId, { interval, timeout })
  void sendTypingOnce(channelId)
  console.log(`[Relay] typing indicator started for channel ${channelId}`)
}

function stopTypingIndicator(channelId, reason = 'completed', { sendFallback = false } = {}) {
  const state = typingSessions.get(channelId)
  if (!state) return
  clearInterval(state.interval)
  clearTimeout(state.timeout)
  typingSessions.delete(channelId)
  console.log(`[Relay] typing indicator stopped for channel ${channelId} (${reason})`)

  if (sendFallback) {
    void sendThinkingFallback(channelId)
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

client.once('ready', async () => {
  console.log(`[Relay] Discord bot ready as ${client.user?.tag}`)
  console.log(`[Relay] Listening for inbound messages on channel(s): ${ALLOWED_CHANNEL_IDS.length > 0 ? ALLOWED_CHANNEL_IDS.join(', ') : DEFAULT_CHANNEL_ID}`)
  console.log(`[Relay] User allowlist: ${ALLOWED_DISCORD_USER_IDS.length > 0 ? ALLOWED_DISCORD_USER_IDS.join(', ') : 'disabled (all users in allowed channels)'}`)
  console.log(`[Relay] API auth: ${RELAY_ALLOW_NO_AUTH ? 'disabled (RELAY_ALLOW_NO_AUTH=true)' : 'required'}`)
  console.log(`[Relay] Busy queue notify: ${BUSY_NOTIFY_ON_QUEUE ? `on (cooldown=${BUSY_NOTIFY_COOLDOWN_MS}ms)` : 'off'}`)
  console.log(`[Relay] Typing: interval=${TYPING_INTERVAL_MS}ms, max=${TYPING_MAX_MS}ms, fallback=${THINKING_FALLBACK_ENABLED ? 'on' : 'off'}`)

  // Register /model slash command
  try {
    const aliasChoices = Object.keys(MODEL_ALIASES).map(alias => ({
      name: `${alias} (${MODEL_ALIASES[alias]})`,
      value: alias,
    }))

    const modelCommand = new SlashCommandBuilder()
      .setName('model')
      .setDescription('Get or set the Claude model for this channel')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Model name or alias (e.g. opus, sonnet, haiku, or full model ID)')
          .setRequired(false)
          .addChoices(...aliasChoices)
      )

    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN)
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: [modelCommand.toJSON()] }
    )
    console.log('[Relay] Registered /model slash command')
  } catch (err) {
    console.error('[Relay] Failed to register slash commands:', err.message)
  }
})

client.on('messageCreate', (message) => {
  if (!message) return
  if (message.author?.bot) return // avoid loops
  if (!isAllowedChannel(message.channelId)) return
  if (!isAllowedUser(message.author?.id)) {
    console.log(`[Relay] Ignoring message from unauthorized user ${message.author?.id}`)
    return
  }
  persistInboundDiscordMessage(message)
  // Start typing immediately so users see Claude is working.
  startTypingIndicator(message.channelId)
  // If Claude is currently blocked on another tool, notify user message is queued.
  maybeNotifyBusyQueued(message)
})

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  if (interaction.commandName !== 'model') return

  const modelArg = interaction.options.getString('name')

  if (!modelArg) {
    // No argument: show current model for this channel
    const current = getChannelModel(interaction.channelId)
    if (current) {
      await interaction.reply(`Current model for this channel: \`${current}\``)
    } else {
      await interaction.reply('No model set for this channel (using default).')
    }
    return
  }

  if (modelArg === 'clear' || modelArg === 'reset' || modelArg === 'default') {
    clearChannelModel(interaction.channelId)
    await interaction.reply('Model override cleared for this channel. Using default model.')
    console.log(`[Relay] Model cleared for channel ${interaction.channelId} by ${interaction.user?.tag}`)
    return
  }

  const resolved = resolveModelAlias(modelArg)
  setChannelModel(interaction.channelId, resolved, interaction.user?.tag || interaction.user?.id || null)
  const aliasNote = resolved !== modelArg ? ` (alias: \`${modelArg}\`)` : ''
  await interaction.reply(`Model for this channel set to: \`${resolved}\`${aliasNote}`)
  console.log(`[Relay] Model set for channel ${interaction.channelId}: ${resolved} by ${interaction.user?.tag}`)
})

client.on('error', (err) => {
  console.error('[Relay] Discord client error:', err.message)
})

const app = express()
app.use(express.json({ limit: '1mb' }))

// Handle malformed JSON bodies cleanly (instead of noisy stack traces)
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err?.status === 400 && 'body' in err)) {
    res.status(400).json({ success: false, error: 'Invalid JSON body' })
    return
  }
  next(err)
})

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    discordReady: Boolean(client.user),
    defaultChannelId: DEFAULT_CHANNEL_ID,
    sessionId: DISCORD_SESSION_ID
  })
})

app.get('/api/channels', async (req, res) => {
  try {
    if (!RELAY_ALLOW_NO_AUTH) {
      const token = req.header('x-api-token') || req.header('authorization')?.replace(/^Bearer\s+/i, '')
      if (!token || token !== RELAY_API_TOKEN) {
        res.status(401).json({ success: false, error: 'Unauthorized' })
        return
      }
    }

    if (!client.user) {
      res.status(503).json({ success: false, error: 'Discord client not ready yet' })
      return
    }

    const channels = []
    for (const [, guild] of client.guilds.cache) {
      const guildChannels = await guild.channels.fetch()
      for (const [, channel] of guildChannels) {
        if (!channel || !channel.isTextBased() || channel.isThread()) continue
        if (IGNORED_CHANNEL_IDS.has(channel.id)) continue
        if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(channel.id)) continue
        channels.push({
          id: channel.id,
          name: channel.name,
          guildId: guild.id,
          guildName: guild.name,
          type: channel.type,
          model: getChannelModel(channel.id),
        })
      }
    }

    res.json({ success: true, channels })
  } catch (err) {
    console.error('[Relay] /api/channels failed:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/send', async (req, res) => {
  try {
    if (!RELAY_ALLOW_NO_AUTH) {
      const token = req.header('x-api-token') || req.header('authorization')?.replace(/^Bearer\s+/i, '')
      if (!token || token !== RELAY_API_TOKEN) {
        res.status(401).json({ success: false, error: 'Unauthorized' })
        return
      }
    }

    if (!client.user) {
      res.status(503).json({ success: false, error: 'Discord client not ready yet' })
      return
    }

    const { content, channelId, replyTo, fromAgent } = req.body || {}
    const text = String(content || '').trim()
    const targetChannelId = channelId || DEFAULT_CHANNEL_ID

    if (!text) {
      res.status(400).json({ success: false, error: 'Missing content' })
      return
    }

    const channel = await client.channels.fetch(targetChannelId)
    if (!channel || !channel.isTextBased()) {
      res.status(400).json({ success: false, error: `Channel ${targetChannelId} not found or not text-based` })
      return
    }

    let sent
    if (replyTo && channel.messages?.fetch) {
      const original = await channel.messages.fetch(replyTo)
      sent = await original.reply(text)
    } else {
      sent = await channel.send(text)
    }

    persistOutboundDiscordMessage({
      content: text,
      channelId: targetChannelId,
      externalId: sent.id,
      fromAgent
    })

    // Reply sent — stop typing heartbeat for this channel.
    stopTypingIndicator(targetChannelId, 'reply-sent')

    res.json({
      success: true,
      messageId: sent.id,
      channelId: targetChannelId
    })
  } catch (err) {
    console.error('[Relay] /api/send failed:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

const server = app.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(`[Relay] HTTP API running at http://${RELAY_HOST}:${RELAY_PORT}`)
})

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  console.error('[Relay] Failed to login to Discord:', err.message)
  process.exit(1)
})

function shutdown(signal) {
  console.log(`\n[Relay] Received ${signal}. Shutting down...`)
  for (const [channelId] of typingSessions) {
    stopTypingIndicator(channelId, 'shutdown')
  }
  try { server.close() } catch { /* ignore */ }
  try { client.destroy() } catch { /* ignore */ }
  try { db.close() } catch { /* ignore */ }
  void memoryStore.close().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

function loadDotEnv(path) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}
