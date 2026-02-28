/**
 * Build a deterministic memory session key for a Claude route.
 *
 * @param {{ sessionId?: string, agentId?: string, channelId?: string }} input
 */
export function buildMemorySessionKey(input = {}) {
  const sessionId = String(input.sessionId || 'default').trim() || 'default'
  const agentId = String(input.agentId || 'claude').trim() || 'claude'
  const channelId = input.channelId ? String(input.channelId).trim() : ''
  if (channelId) {
    return `discord:${sessionId}:${agentId}:ch-${channelId}`
  }
  return `discord:${sessionId}:${agentId}`
}
