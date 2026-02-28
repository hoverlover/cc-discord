/**
 * Build a deterministic memory session key for a Claude route.
 *
 * @param {{ sessionId?: string, agentId?: string }} input
 */
export function buildMemorySessionKey(input = {}) {
  const sessionId = String(input.sessionId || 'default').trim() || 'default'
  const agentId = String(input.agentId || 'claude').trim() || 'claude'
  return `discord:${sessionId}:${agentId}`
}
