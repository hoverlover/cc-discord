import { clamp } from './types.js'

export class MemoryCoordinator {
  /**
   * @param {{
   *  store: any,
   *  logger?: Pick<Console, 'log' | 'warn' | 'error'>,
   *  defaults?: {
   *    activeWindowSize?: number,
   *    maxCards?: number,
   *    maxRecallTurns?: number,
   *    maxTurnScan?: number,
   *  }
   * }} options
   */
  constructor(options) {
    if (!options?.store) throw new Error('MemoryCoordinator requires a store')

    this.store = options.store
    this.logger = options.logger || console
    this.defaults = {
      activeWindowSize: 12,
      maxCards: 6,
      maxRecallTurns: 4,
      maxTurnScan: 400,
      ...(options.defaults || {}),
    }
  }

  async init() {
    await this.store.init()
  }

  async appendTurn({ sessionKey, agentId = null, role, content, metadata = null, turnIndex = null }) {
    return this.store.writeBatch({
      batchId: makeBatchId('turn'),
      sessionKey,
      agentId,
      turns: [{ role, content, metadata, turnIndex }],
    })
  }

  async appendTurns({ sessionKey, agentId = null, turns = [] }) {
    return this.store.writeBatch({
      batchId: makeBatchId('turns'),
      sessionKey,
      agentId,
      turns,
    })
  }

  async ensureRuntimeContext({ sessionKey, runtimeContextId = null, runtimeEpoch = null } = {}) {
    if (!sessionKey) throw new Error('ensureRuntimeContext() requires sessionKey')

    const existing = await this.store.readRuntimeState(sessionKey)
    if (existing) return existing

    return this.store.upsertRuntimeState({
      sessionKey,
      runtimeContextId: runtimeContextId || makeRuntimeContextId('init'),
      runtimeEpoch: Number.isInteger(runtimeEpoch) ? runtimeEpoch : 1,
    })
  }

  async beginNewRuntimeContext({ sessionKey, runtimeContextId = null } = {}) {
    if (!sessionKey) throw new Error('beginNewRuntimeContext() requires sessionKey')

    return this.store.bumpRuntimeContext({
      sessionKey,
      runtimeContextId: runtimeContextId || makeRuntimeContextId('sessionstart'),
    })
  }

  /**
   * Build context-aware memory payload for this turn.
   *
   * Strategy:
   * 1) Determine active window (what model likely already has)
   * 2) Filter out overlapping memories
   * 3) Rank out-of-window cards/turns by relevance + novelty
   */
  async assembleContext(input) {
    const {
      sessionKey,
      queryText = '',
      runtimeContextId = null,
      runtimeEpoch = null,
      activeWindowTurnIds = [],
      includeSnapshot = true,
      avoidCurrentRuntime = true,
      activeWindowSize = this.defaults.activeWindowSize,
      maxCards = this.defaults.maxCards,
      maxRecallTurns = this.defaults.maxRecallTurns,
      maxTurnScan = this.defaults.maxTurnScan,
    } = input || {}

    if (!sessionKey) throw new Error('assembleContext() requires sessionKey')

    const safeActiveWindowSize = clamp(Number(activeWindowSize) || this.defaults.activeWindowSize, 1, 100)
    const safeMaxCards = clamp(Number(maxCards) || this.defaults.maxCards, 0, 30)
    const safeMaxRecallTurns = clamp(Number(maxRecallTurns) || this.defaults.maxRecallTurns, 0, 30)
    const safeMaxTurnScan = clamp(Number(maxTurnScan) || this.defaults.maxTurnScan, 50, 2000)

    const resolvedRuntimeState = await resolveRuntimeState({
      store: this.store,
      sessionKey,
      runtimeContextId,
      runtimeEpoch,
    })

    const snapshot = includeSnapshot
      ? await this.store.readSessionSnapshot(sessionKey)
      : null

    const compactionState = await this.store.readCompactionState(sessionKey)
    const compactedCutoff = await resolveCompactedCutoff({
      store: this.store,
      sessionKey,
      compactionState,
    })

    const candidateTurns = await this.store.listRecentTurns({
      sessionKey,
      limit: safeMaxTurnScan,
    })

    const runtimeActiveTurns = avoidCurrentRuntime
      ? candidateTurns.filter((turn) => isTurnInActiveRuntimeWindow(turn, resolvedRuntimeState, compactedCutoff))
      : []

    const activeIds = new Set([
      ...activeWindowTurnIds.map(String),
      ...runtimeActiveTurns.map((t) => String(t.id)),
    ])

    const activeWindowTurns = runtimeActiveTurns.slice(-safeActiveWindowSize)
    const activeText = activeWindowTurns.map((t) => `${t.role}: ${t.content}`).join('\n')
    const activeTokens = tokenize(activeText)
    const queryTokens = tokenize(queryText)

    const allCards = await this.store.queryCards({
      sessionKey,
      includeExpired: false,
      limit: 500,
    })

    const rankedCards = allCards
      .filter((card) => !overlapsActiveWindow(card, activeIds))
      .map((card) => {
        const text = `${card.title || ''}\n${card.body || ''}`
        const tokens = tokenize(text)
        const overlap = tokenOverlapScore(queryTokens, tokens)
        const novelty = 1 - jaccard(tokens, activeTokens)
        const pinnedBoost = card.pinned ? 0.8 : 0
        const confidenceBoost = clamp(Number(card.confidence ?? 0.5), 0, 1) * 0.4
        const score = overlap * 1.2 + novelty * 0.5 + pinnedBoost + confidenceBoost
        return { card, score, overlap, novelty }
      })
      .filter((x) => x.score > 0.35 || x.card.pinned)
      .sort((a, b) => b.score - a.score)
      .slice(0, safeMaxCards)
      .map((x) => x.card)

    const recalledTurns = candidateTurns
      .filter((turn) => !activeIds.has(String(turn.id)))
      .map((turn) => {
        const text = `${turn.role}: ${turn.content}`
        const tokens = tokenize(text)
        const overlap = tokenOverlapScore(queryTokens, tokens)
        const novelty = 1 - jaccard(tokens, activeTokens)
        const recency = turn.turnIndex / Math.max(1, candidateTurns.length)
        const score = overlap * 1.0 + novelty * 0.4 + recency * 0.1
        return { turn, score }
      })
      .filter((x) => x.score > 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, safeMaxRecallTurns)
      .map((x) => x.turn)
      .sort((a, b) => a.turnIndex - b.turnIndex)

    return {
      sessionKey,
      queryText,
      snapshot,
      activeWindowTurns,
      recalledTurns,
      cards: rankedCards,
      debug: {
        runtimeContextId: resolvedRuntimeState?.runtimeContextId || null,
        runtimeEpoch: resolvedRuntimeState?.runtimeEpoch || null,
        compactedCutoffTurnId: compactionState?.lastCompactedTurnId || null,
        compactedCutoffTurnIndex: compactedCutoff?.turnIndex ?? null,
        totalCardsScanned: allCards.length,
        totalTurnsScanned: candidateTurns.length,
        activeTurnCount: runtimeActiveTurns.length,
      },
    }
  }

  formatContextPacket(payload) {
    const parts = []

    if (payload.snapshot?.summaryText) {
      parts.push(`Session summary:\n${truncate(payload.snapshot.summaryText, 800)}`)

      if (Array.isArray(payload.snapshot.openTasks) && payload.snapshot.openTasks.length > 0) {
        parts.push(`Open tasks:\n- ${payload.snapshot.openTasks.join('\n- ')}`)
      }
    }

    if (Array.isArray(payload.cards) && payload.cards.length > 0) {
      const lines = payload.cards.map((card) => {
        const label = card.cardType ? `[${card.cardType}]` : ''
        const title = card.title ? `${truncate(card.title, 120)}: ` : ''
        return `- ${label} ${title}${truncate(card.body, 320)}`.trim()
      })
      parts.push(`Relevant long-term memory (outside current window):\n${lines.join('\n')}`)
    }

    if (Array.isArray(payload.recalledTurns) && payload.recalledTurns.length > 0) {
      const lines = payload.recalledTurns.map((turn) => `- (${turn.role}) ${truncate(turn.content, 280)}`)
      parts.push(`Relevant prior turns (outside current window):\n${lines.join('\n')}`)
    }

    if (parts.length === 0) return ''
    return `MEMORY CONTEXT:\n${parts.join('\n\n')}`
  }
}

function makeBatchId(prefix) {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${ts}_${rand}`
}

function makeRuntimeContextId(prefix = 'runtime') {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${ts}_${rand}`
}

function overlapsActiveWindow(card, activeIds) {
  if (card.sourceTurnFrom && activeIds.has(String(card.sourceTurnFrom))) return true
  if (card.sourceTurnTo && activeIds.has(String(card.sourceTurnTo))) return true
  return false
}

async function resolveRuntimeState({ store, sessionKey, runtimeContextId, runtimeEpoch }) {
  if (runtimeContextId || runtimeEpoch) {
    return {
      runtimeContextId: runtimeContextId || null,
      runtimeEpoch: Number.isInteger(runtimeEpoch) ? runtimeEpoch : null,
    }
  }

  if (!store?.readRuntimeState) return null

  try {
    return await store.readRuntimeState(sessionKey)
  } catch {
    return null
  }
}

async function resolveCompactedCutoff({ store, sessionKey, compactionState }) {
  const turnId = compactionState?.lastCompactedTurnId
  if (!turnId) return null

  if (!store?.getTurnById) return null

  try {
    const turn = await store.getTurnById({ sessionKey, turnId })
    return turn || null
  } catch {
    return null
  }
}

function isTurnInActiveRuntimeWindow(turn, runtimeState, compactedCutoff) {
  if (!runtimeState?.runtimeContextId) return false

  const turnRuntimeContextId = turn?.metadata?.runtimeContextId
  if (!turnRuntimeContextId || turnRuntimeContextId !== runtimeState.runtimeContextId) {
    return false
  }

  if (compactedCutoff?.turnIndex === undefined || compactedCutoff?.turnIndex === null) {
    // No compaction cutoff available: treat all current-runtime turns as active.
    return true
  }

  return turn.turnIndex > compactedCutoff.turnIndex
}

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  )
}

function tokenOverlapScore(aTokens, bTokens) {
  if (!aTokens || !bTokens || aTokens.size === 0 || bTokens.size === 0) return 0
  let overlap = 0
  for (const tok of aTokens) {
    if (bTokens.has(tok)) overlap++
  }
  return overlap / Math.max(1, Math.min(aTokens.size, 10))
}

function jaccard(aTokens, bTokens) {
  if ((!aTokens || aTokens.size === 0) && (!bTokens || bTokens.size === 0)) return 1
  if (!aTokens || !bTokens || aTokens.size === 0 || bTokens.size === 0) return 0

  let intersection = 0
  for (const tok of aTokens) {
    if (bTokens.has(tok)) intersection++
  }

  const union = aTokens.size + bTokens.size - intersection
  return union > 0 ? intersection / union : 0
}

function truncate(text, maxLen) {
  const str = String(text || '')
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 1)}…`
}
