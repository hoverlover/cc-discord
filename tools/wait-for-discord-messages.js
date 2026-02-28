#!/usr/bin/env node

/**
 * Wait for unread Discord messages for this agent/session.
 *
 * Notes:
 * - Uses a PID lock so only one active poller exists per agent+session.
 * - Default timeout exits 0 quietly (to avoid noisy background failures in Claude UI).
 * - Use --strict-timeout to return exit code 1 on timeout.
 *
 * Usage:
 *   wait-for-discord-messages --agent claude --session default --timeout 600 [--deliver] [--strict-timeout]
 */

// Suppress Node.js ExperimentalWarning (SQLite) to keep output clean
const _origEmit = process.emit
process.emit = function (event, ...args) {
  if (event === 'warning' && args[0]?.name === 'ExperimentalWarning') return false
  return _origEmit.call(this, event, ...args)
}

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteMemoryStore } from '../memory/providers/sqlite/SqliteMemoryStore.js'
import { MemoryCoordinator } from '../memory/core/MemoryCoordinator.js'
import { buildMemorySessionKey } from '../memory/core/session-key.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = process.env.ORCHESTRATOR_DIR || join(__dirname, '..')

const args = process.argv.slice(2)
let agentId = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || 'claude'
let sessionId = process.env.DISCORD_SESSION_ID || process.env.BROKER_SESSION_ID || process.env.SESSION_ID || 'default'
let timeoutSeconds = 300
let deliverMode = false
let strictTimeout = false
let quietTimeout = String(process.env.WAIT_QUIET_TIMEOUT || 'true').toLowerCase() !== 'false'

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) {
    agentId = args[++i]
  } else if (args[i] === '--session' && args[i + 1]) {
    sessionId = args[++i]
  } else if (args[i] === '--timeout' && args[i + 1]) {
    timeoutSeconds = Number(args[++i])
  } else if (args[i] === '--deliver') {
    deliverMode = true
  } else if (args[i] === '--strict-timeout') {
    strictTimeout = true
  } else if (args[i] === '--no-quiet-timeout') {
    quietTimeout = false
  }
}

const dbPath = join(ROOT_DIR, 'data', 'messages.db')
const baseRole = agentId.replace(/-\d+$/, '')
const targets = [...new Set([agentId, baseRole, 'claude'])]
const placeholders = targets.map(() => '?').join(',')

const noopLogger = {
  log() {},
  warn() {},
  error() {},
}

const TEMP_DIR = '/tmp/cc-discord'
mkdirSync(TEMP_DIR, { recursive: true })

const safeAgent = sanitizeForFilename(agentId)
const safeSession = sanitizeForFilename(sessionId)
const lockFile = join(TEMP_DIR, `poller-${safeAgent}-${safeSession}.lock`)

function sanitizeForFilename(input) {
  return String(input || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function currentLockOwnerPid() {
  try {
    const raw = readFileSync(lockFile, 'utf8').trim()
    const pid = Number(raw)
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

function acquireLock() {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') return false

    const existingPid = currentLockOwnerPid()
    if (existingPid && existingPid !== process.pid && pidAlive(existingPid)) {
      // Another poller for this agent/session is already active.
      return false
    }

    // Stale lock: reclaim.
    try { unlinkSync(lockFile) } catch { /* ignore */ }

    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }
}

function cleanupLock() {
  try {
    const ownerPid = currentLockOwnerPid()
    if (ownerPid === process.pid) {
      unlinkSync(lockFile)
    }
  } catch {
    // ignore
  }
}

if (!acquireLock()) {
  // Another poller won the race; exit quietly.
  process.exit(0)
}

process.on('SIGTERM', () => {
  cleanupLock()
  process.exit(0)
})

process.on('SIGINT', () => {
  cleanupLock()
  process.exit(0)
})

process.on('exit', () => {
  cleanupLock()
})

async function buildMemoryContext(queryText) {
  const memoryDbPath = join(ROOT_DIR, 'data', 'memory.db')
  const memorySessionKey = buildMemorySessionKey({ sessionId, agentId })
  const runtimeHint = process.env.CLAUDE_RUNTIME_ID || null

  let store
  try {
    store = new SqliteMemoryStore({ dbPath: memoryDbPath, logger: noopLogger })
    const coordinator = new MemoryCoordinator({ store, logger: noopLogger })
    await coordinator.init()

    const runtimeState = await coordinator.ensureRuntimeContext({
      sessionKey: memorySessionKey,
      runtimeContextId: runtimeHint,
    })

    const packet = await coordinator.assembleContext({
      sessionKey: memorySessionKey,
      queryText,
      runtimeContextId: runtimeState?.runtimeContextId,
      runtimeEpoch: runtimeState?.runtimeEpoch,
      includeSnapshot: true,
      avoidCurrentRuntime: true,
      activeWindowSize: 12,
      maxCards: 6,
      maxRecallTurns: 4,
      maxTurnScan: 300,
    })

    return coordinator.formatContextPacket(packet)
  } catch {
    return ''
  } finally {
    if (store) {
      try { await store.close() } catch { /* ignore */ }
    }
  }
}

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

async function deliverMessages(db) {
  db.exec('BEGIN IMMEDIATE')
  const rows = db.prepare(`
    SELECT id, from_agent, message_type, content
    FROM messages
    WHERE session_id = ?
      AND to_agent IN (${placeholders})
      AND read = 0
    ORDER BY id ASC
  `).all(sessionId, ...targets)

  if (rows.length === 0) {
    db.exec('COMMIT')
    return false
  }

  const ids = rows.map(r => r.id)
  const idPlaceholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE messages SET read = 1 WHERE id IN (${idPlaceholders})`).run(...ids)
  db.exec('COMMIT')

  const formatted = rows.map(r => {
    const oneLine = String(r.content).replace(/\r/g, '').replace(/\n/g, ' ')
    return `[MESSAGE from ${r.from_agent}] [${r.message_type}]: ${oneLine}`
  })

  const latestQueryText = String(rows[rows.length - 1]?.content || '')
  const memoryText = await buildMemoryContext(latestQueryText)
  const inboxText = `NEW DISCORD MESSAGE(S): ${formatted.join(' | ')}`
  const outputText = memoryText ? `${inboxText}\n\n${memoryText}` : inboxText

  console.log(outputText)
  return true
}

async function main() {
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (err) {
    console.error(`Cannot open database at ${dbPath}: ${err.message}`)
    process.exit(1)
  }

  process.on('exit', () => {
    try { db.close() } catch { /* ignore */ }
  })

  try {
    if (checkCount(db) > 0) {
      if (deliverMode) {
        await deliverMessages(db)
      } else {
        console.log(`Messages pending for ${agentId}`)
      }
      process.exit(0)
    }

    const pollIntervalMs = 2000
    const timeoutMs = timeoutSeconds * 1000
    const start = Date.now()

    let polling = false

    const tick = async () => {
      if (polling) return
      polling = true
      try {
        if (checkCount(db) > 0) {
          if (deliverMode) {
            await deliverMessages(db)
          } else {
            console.log(`Messages pending for ${agentId}`)
          }
          process.exit(0)
        }

        if (Date.now() - start > timeoutMs) {
          if (!quietTimeout) {
            console.log(`No messages after ${timeoutSeconds}s timeout`)
          }
          process.exit(strictTimeout ? 1 : 0)
        }
      } catch {
        // transient DB errors; keep polling
      } finally {
        polling = false
      }
    }

    const timer = setInterval(() => {
      void tick()
    }, pollIntervalMs)

    // Also run once right away (in case race inserted message before first interval)
    void tick()

    process.on('exit', () => {
      clearInterval(timer)
    })
  } catch {
    process.exit(1)
  }
}

await main()
