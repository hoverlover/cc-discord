#!/usr/bin/env node

/**
 * Poll SQLite until unread Discord messages exist for this agent/session.
 *
 * Usage:
 *   wait-for-discord-messages --agent claude --session default --timeout 300 [--deliver]
 */

// Suppress Node.js ExperimentalWarning (SQLite) to keep output clean
const _origEmit = process.emit
process.emit = function (event, ...args) {
  if (event === 'warning' && args[0]?.name === 'ExperimentalWarning') return false
  return _origEmit.call(this, event, ...args)
}

import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = process.env.ORCHESTRATOR_DIR || join(__dirname, '..')

const args = process.argv.slice(2)
let agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || 'claude'
let sessionId = process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || 'default'
let timeoutSeconds = 300
let deliverMode = false

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) {
    agentId = args[++i]
  } else if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[++i]
  } else if (args[i] === '--timeout' && args[i + 1]) {
    timeoutSeconds = Number(args[++i])
  } else if (args[i] === '--deliver') {
    deliverMode = true
  }
}

const dbPath = join(ROOT_DIR, 'data', 'messages.db')

const baseRole = agentId.replace(/-\d+$/, '')
const targets = [...new Set([agentId, baseRole, 'claude'])]
const placeholders = targets.map(() => '?').join(',')

function checkCount(db) {
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM messages
    WHERE session_id = ?
      AND to_agent IN (${placeholders})
      AND read = 0
  `).get(sessionId, ...targets)
  return row.count
}

function deliverMessages(db) {
  db.exec('BEGIN IMMEDIATE')
  const rows = db.prepare(`
    SELECT id, from_agent, message_type, content
    FROM messages
    WHERE session_id = ?
      AND to_agent IN (${placeholders})
      AND read = 0
    ORDER BY id ASC
  `).all(sessionId, ...targets)

  if (rows.length > 0) {
    const ids = rows.map(r => r.id)
    const idPlaceholders = ids.map(() => '?').join(',')
    db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${idPlaceholders})`).run(...ids)
    db.exec('COMMIT')

    const formatted = rows.map(r => {
      const oneLine = String(r.content).replace(/\r/g, '').replace(/\n/g, ' ')
      return `[MESSAGE from ${r.from_agent}] [${r.message_type}]: ${oneLine}`
    })
    console.log(`NEW DISCORD MESSAGE(S): ${formatted.join(' | ')}`)
    return true
  }

  db.exec('COMMIT')
  return false
}

let db
try {
  db = new DatabaseSync(dbPath)
} catch (err) {
  console.error(`Cannot open database at ${dbPath}: ${err.message}`)
  process.exit(1)
}

try {
  if (checkCount(db) > 0) {
    if (deliverMode) {
      deliverMessages(db)
    } else {
      console.log(`Messages pending for ${agentId}`)
    }
    process.exit(0)
  }

  const pollIntervalMs = 2000
  const timeoutMs = timeoutSeconds * 1000
  const start = Date.now()

  const timer = setInterval(() => {
    try {
      if (checkCount(db) > 0) {
        clearInterval(timer)
        if (deliverMode) {
          deliverMessages(db)
        } else {
          console.log(`Messages pending for ${agentId}`)
        }
        process.exit(0)
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        console.log(`No messages after ${timeoutSeconds}s timeout`)
        process.exit(1)
      }
    } catch {
      // transient DB errors; keep polling
    }
  }, pollIntervalMs)
} finally {
  process.on('exit', () => {
    try { db.close() } catch { /* ignore */ }
  })
}
