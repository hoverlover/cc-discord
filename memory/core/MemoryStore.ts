/**
 * Base class for memory stores.
 * Implementations should override all async methods.
 */
export class MemoryStore {
  id: string;
  caps: { atomicBatch: boolean; fullTextSearch: boolean; vectorSearch: boolean; bidirectionalSync: boolean };

  /**
   * @param {string} id
   * @param {{ atomicBatch: boolean, fullTextSearch: boolean, vectorSearch: boolean, bidirectionalSync: boolean }} caps
   */
  constructor(
    id: string,
    caps: { atomicBatch: boolean; fullTextSearch: boolean; vectorSearch: boolean; bidirectionalSync: boolean },
  ) {
    this.id = id;
    this.caps = caps;
  }

  async init(): Promise<void> {
    throw new Error("MemoryStore.init() not implemented");
  }

  async health(): Promise<any> {
    throw new Error("MemoryStore.health() not implemented");
  }

  async writeBatch(_batch: any): Promise<any> {
    throw new Error("MemoryStore.writeBatch() not implemented");
  }

  async readSessionSnapshot(_sessionKey: any): Promise<any> {
    throw new Error("MemoryStore.readSessionSnapshot() not implemented");
  }

  async listTurns(_input: any): Promise<any> {
    throw new Error("MemoryStore.listTurns() not implemented");
  }

  async listRecentTurns(_input: any): Promise<any> {
    throw new Error("MemoryStore.listRecentTurns() not implemented");
  }

  async queryCards(_input: any): Promise<any> {
    throw new Error("MemoryStore.queryCards() not implemented");
  }

  async readCompactionState(_sessionKey: any): Promise<any> {
    throw new Error("MemoryStore.readCompactionState() not implemented");
  }

  async getTurnById(_input: any): Promise<any> {
    throw new Error("MemoryStore.getTurnById() not implemented");
  }

  async readRuntimeState(_sessionKey: any): Promise<any> {
    throw new Error("MemoryStore.readRuntimeState() not implemented");
  }

  async upsertRuntimeState(_input: any): Promise<any> {
    throw new Error("MemoryStore.upsertRuntimeState() not implemented");
  }

  async bumpRuntimeContext(_input: any): Promise<any> {
    throw new Error("MemoryStore.bumpRuntimeContext() not implemented");
  }

  async close(): Promise<void> {
    // Optional for stores that keep sockets or db handles
  }
}
