#!/usr/bin/env node
/**
 * Claude Code hook: deliver unread Discord messages into Claude context.
 *
 * Hook input:  snake_case fields (hook_event_name, tool_name, ...)
 * Hook output: camelCase fields (hookEventName, additionalContext)
 */

// Suppress Node.js ExperimentalWarning (SQLite) to keep hook output clean
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

const agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || 'claude'
const sessionId =
  process.env.DISCORD_SESSION_ID ||
  process.env.BROKER_SESSION_ID ||
  process.env.SESSION_ID ||
  'default'

const dbPath = join(ROOT_DIR, 'data', 'messages.db')

let hookInput
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString()
  hookInput = raw ? JSON.parse(raw) : { hook_event_name: 'PostToolUse' }
} catch {
  process.exit(0)
}

const hookEvent = hookInput.hook_event_name || 'PostToolUse'

// Match direct agent IDs, generic "claude", and optionally base role
const baseRole = agentId.replace(/-\d+$/, '')
const targets = [...new Set([agentId, baseRole, 'claude'])]

let db
try {
  db = new DatabaseSync(dbPath)
} catch {
  process.exit(0)
}

try {
  db.exec('BEGIN IMMEDIATE')

  const placeholders = targets.map(() => '?').join(',')
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

    const formatted = rows.map((r) => {
      const oneLine = String(r.content).replace(/\r/g, '').replace(/\n/g, ' ')
      return `[MESSAGE from ${r.from_agent}] [${r.message_type}]: ${oneLine}`
    })
    const contextText = `NEW DISCORD MESSAGE(S): ${formatted.join(' | ')}`

    if (hookEvent === 'Stop') {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `New Discord messages received. Process these before stopping.\n\n${contextText}`
      }))
      process.exit(0)
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEvent,
        additionalContext: contextText
      }
    }))
    process.exit(0)
  }

  db.exec('COMMIT')
  process.exit(0)
} catch {
  try { db.exec('ROLLBACK') } catch { /* ignore */ }
  process.exit(0)
} finally {
  try { db.close() } catch { /* ignore */ }
}
