#!/usr/bin/env node

// Suppress Node.js ExperimentalWarning (SQLite) so logs stay clean
const _origEmit = process.emit
process.emit = function (event, ...args) {
  if (event === 'warning' && args[0]?.name === 'ExperimentalWarning') return false
  return _origEmit.call(this, event, ...args)
}

import express from 'express'
import { Client, GatewayIntentBits } from 'discord.js'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const ALLOWED_DISCORD_USER_IDS = (process.env.ALLOWED_DISCORD_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

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

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
  CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(read);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_external
    ON messages(source, external_id);
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

function isAllowedChannel(channelId) {
  if (!channelId) return false
  if (ALLOWED_CHANNEL_IDS.length > 0) {
    return ALLOWED_CHANNEL_IDS.includes(channelId)
  }
  return channelId === DEFAULT_CHANNEL_ID
}

function isAllowedUser(userId) {
  if (!userId) return false
  if (ALLOWED_DISCORD_USER_IDS.length === 0) return true
  return ALLOWED_DISCORD_USER_IDS.includes(userId)
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
  try {
    insertStmt.run(
      DISCORD_SESSION_ID,
      `discord:${message.author?.id || 'unknown'}`,
      CLAUDE_AGENT_ID,
      'DISCORD_MESSAGE',
      formatInboundMessage(message),
      'discord',
      message.id,
      message.channelId,
      0
    )

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
  try {
    insertStmt.run(
      DISCORD_SESSION_ID,
      fromAgent || CLAUDE_AGENT_ID,
      'discord',
      'DISCORD_REPLY',
      String(content),
      'relay-outbound',
      externalId || null,
      channelId || DEFAULT_CHANNEL_ID,
      1
    )
  } catch (err) {
    console.error('[Relay] failed to persist outbound message:', err.message)
  }
}

// Channel typing state: channelId -> { interval, timeout }
const typingSessions = new Map()

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

client.once('ready', () => {
  console.log(`[Relay] Discord bot ready as ${client.user?.tag}`)
  console.log(`[Relay] Listening for inbound messages on channel(s): ${ALLOWED_CHANNEL_IDS.length > 0 ? ALLOWED_CHANNEL_IDS.join(', ') : DEFAULT_CHANNEL_ID}`)
  console.log(`[Relay] User allowlist: ${ALLOWED_DISCORD_USER_IDS.length > 0 ? ALLOWED_DISCORD_USER_IDS.join(', ') : 'disabled (all users in allowed channels)'}`)
  console.log(`[Relay] API auth: ${RELAY_ALLOW_NO_AUTH ? 'disabled (RELAY_ALLOW_NO_AUTH=true)' : 'required'}`)
  console.log(`[Relay] Typing: interval=${TYPING_INTERVAL_MS}ms, max=${TYPING_MAX_MS}ms, fallback=${THINKING_FALLBACK_ENABLED ? 'on' : 'off'}`)
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
})

client.on('error', (err) => {
  console.error('[Relay] Discord client error:', err.message)
})

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    discordReady: Boolean(client.user),
    defaultChannelId: DEFAULT_CHANNEL_ID,
    sessionId: DISCORD_SESSION_ID
  })
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
