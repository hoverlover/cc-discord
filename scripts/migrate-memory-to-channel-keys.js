#!/usr/bin/env node
/**
 * One-time migration: split memory_turns from the legacy shared session key
 * (discord:default:claude-discord) into per-channel session keys
 * (discord:default:{channelId}).
 *
 * Also re-indexes turn_index per channel to be sequential.
 */
import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.argv[2] || join(__dirname, '..', 'data', 'memory.db')

console.log(`[migrate] Opening ${dbPath}`)
const db = new DatabaseSync(dbPath)

const OLD_SESSION_KEY = 'discord:default:claude-discord'

// Read all turns under the old key
const turns = db.prepare(`
  SELECT id, session_key, turn_index, role, content, metadata_json, created_at
  FROM memory_turns
  WHERE session_key = ?
  ORDER BY turn_index ASC
`).all(OLD_SESSION_KEY)

console.log(`[migrate] Found ${turns.length} turns under ${OLD_SESSION_KEY}`)

if (turns.length === 0) {
  console.log('[migrate] Nothing to migrate.')
  db.close()
  process.exit(0)
}

// Group by channelId from metadata
const byChannel = new Map()
for (const turn of turns) {
  let channelId = null
  try {
    const meta = JSON.parse(turn.metadata_json || '{}')
    channelId = meta.channelId || null
  } catch {}

  if (!channelId) {
    console.warn(`[migrate] Turn ${turn.id} has no channelId, skipping`)
    continue
  }

  if (!byChannel.has(channelId)) byChannel.set(channelId, [])
  byChannel.get(channelId).push(turn)
}

console.log(`[migrate] Splitting into ${byChannel.size} channels:`)
for (const [ch, chTurns] of byChannel) {
  console.log(`  discord:default:${ch} -> ${chTurns.length} turns`)
}

// Ensure per-channel session keys exist in memory_sessions
const upsertSession = db.prepare(`
  INSERT OR IGNORE INTO memory_sessions (session_key, created_at)
  VALUES (?, datetime('now'))
`)

// Update each turn's session_key and re-index
const updateTurn = db.prepare(`
  UPDATE memory_turns SET session_key = ?, turn_index = ? WHERE id = ?
`)

db.exec('BEGIN TRANSACTION')
try {
  for (const [channelId, chTurns] of byChannel) {
    const newKey = `discord:default:${channelId}`
    upsertSession.run(newKey)

    for (let i = 0; i < chTurns.length; i++) {
      updateTurn.run(newKey, i + 1, chTurns[i].id)
    }
    console.log(`[migrate] Updated ${chTurns.length} turns -> ${newKey} (indices 1..${chTurns.length})`)
  }

  // Copy runtime state for each new channel key from the old key
  const oldRuntime = db.prepare(`
    SELECT * FROM memory_runtime_state WHERE session_key = ?
  `).get(OLD_SESSION_KEY)

  if (oldRuntime) {
    const upsertRuntime = db.prepare(`
      INSERT OR IGNORE INTO memory_runtime_state (session_key, runtime_context_id, runtime_epoch, updated_at)
      VALUES (?, ?, 1, datetime('now'))
    `)
    for (const [channelId] of byChannel) {
      const newKey = `discord:default:${channelId}`
      upsertRuntime.run(newKey, `migrated_from_${OLD_SESSION_KEY}`)
      console.log(`[migrate] Created runtime state for ${newKey}`)
    }
  }

  db.exec('COMMIT')
  console.log('[migrate] Done!')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('[migrate] FAILED, rolled back:', err.message)
  process.exit(1)
} finally {
  db.close()
}
