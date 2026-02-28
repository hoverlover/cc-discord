# Memory module (v1 foundation)

This module introduces a pluggable memory architecture with SQLite as the primary store.

## Structure

- `core/types.js` — canonical memory model helpers
- `core/MemoryStore.js` — base class contract
- `core/MemoryCoordinator.js` — context assembly + relevance selection
- `core/session-key.js` — deterministic session key helper
- `providers/sqlite/SqliteMemoryStore.js` — SQLite implementation (schema + CRUD)

## Current capabilities

- Initialize SQLite memory schema (`memory_*` tables)
- Idempotent batch writes via `batchId`
- Store and list session turns
- Store and read latest session snapshot
- Store/query memory cards
- Persist compaction cursor state
- Persist runtime context state (`memory_runtime_state`) for `/new`-aware filtering
- Prepare sync job queue table for future secondary-store fan-out
- Assemble context-aware memory packets that prioritize **relevant, out-of-window** memories

### Retrieval policy (current)

`MemoryCoordinator.assembleContext()`:
1. resolves current runtime context (`runtime_context_id`)
2. treats turns from the same runtime as already-in-context and excludes them from recall
3. exception for compaction: only post-compaction turns in current runtime are excluded; compacted turns can be recalled via snapshot/older memory
4. filters out overlapping memory cards (based on source turn IDs)
5. ranks remaining cards/older turns by query overlap + novelty + confidence/pinned boosts
6. returns only top matches within configured limits

## Basic usage

```js
import { SqliteMemoryStore } from './providers/sqlite/SqliteMemoryStore.js'

const store = new SqliteMemoryStore({ dbPath: './data/memory.db' })
await store.init()

await store.writeBatch({
  batchId: 'batch-123',
  sessionKey: 'discord:server:channel:thread',
  turns: [{ role: 'user', content: 'hello' }],
})

const turns = await store.listTurns({ sessionKey: 'discord:server:channel:thread', limit: 20 })
```

## Quick smoke test

```bash
node tools/memory-smoke.js
```

If successful, it prints:

`Memory smoke test passed (...)`
