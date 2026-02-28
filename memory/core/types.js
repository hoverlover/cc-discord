/**
 * Canonical memory model helpers (store-agnostic).
 *
 * This file intentionally uses plain JS + JSDoc so the project can stay
 * lightweight without a TypeScript build step.
 */

export const MemoryScopes = Object.freeze({
  SESSION: 'session',
  USER: 'user',
  GLOBAL: 'global'
})

export const MemoryCardTypes = Object.freeze({
  DECISION: 'decision',
  CONSTRAINT: 'constraint',
  PREFERENCE: 'preference',
  TODO: 'todo',
  CONTEXT: 'context'
})

/**
 * @param {unknown} value
 * @param {any} fallback
 */
export function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
export function safeJsonStringify(value, fallback = 'null') {
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

export function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
