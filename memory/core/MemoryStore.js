/**
 * Base class for memory stores.
 * Implementations should override all async methods.
 */
export class MemoryStore {
  /**
   * @param {string} id
   * @param {{ atomicBatch: boolean, fullTextSearch: boolean, vectorSearch: boolean, bidirectionalSync: boolean }} caps
   */
  constructor(id, caps) {
    this.id = id
    this.caps = caps
  }

  async init() {
    throw new Error('MemoryStore.init() not implemented')
  }

  async health() {
    throw new Error('MemoryStore.health() not implemented')
  }

  async writeBatch(_batch) {
    throw new Error('MemoryStore.writeBatch() not implemented')
  }

  async readSessionSnapshot(_sessionKey) {
    throw new Error('MemoryStore.readSessionSnapshot() not implemented')
  }

  async listTurns(_input) {
    throw new Error('MemoryStore.listTurns() not implemented')
  }

  async listRecentTurns(_input) {
    throw new Error('MemoryStore.listRecentTurns() not implemented')
  }

  async queryCards(_input) {
    throw new Error('MemoryStore.queryCards() not implemented')
  }

  async readCompactionState(_sessionKey) {
    throw new Error('MemoryStore.readCompactionState() not implemented')
  }

  async getTurnById(_input) {
    throw new Error('MemoryStore.getTurnById() not implemented')
  }

  async readRuntimeState(_sessionKey) {
    throw new Error('MemoryStore.readRuntimeState() not implemented')
  }

  async upsertRuntimeState(_input) {
    throw new Error('MemoryStore.upsertRuntimeState() not implemented')
  }

  async bumpRuntimeContext(_input) {
    throw new Error('MemoryStore.bumpRuntimeContext() not implemented')
  }

  async close() {
    // Optional for stores that keep sockets or db handles
  }
}
