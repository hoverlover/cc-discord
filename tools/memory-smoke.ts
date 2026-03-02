#!/usr/bin/env bun

// Keep smoke output clean on Node builds where sqlite is marked experimental.
const _origEmit = process.emit;
process.emit = function (event: string, ...args: any[]) {
  if (event === "warning" && args[0]?.name === "ExperimentalWarning") return false;
  return _origEmit.call(this, event, ...args) as any;
};

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCoordinator } from "../memory/core/MemoryCoordinator.ts";
import { SqliteMemoryStore } from "../memory/providers/sqlite/SqliteMemoryStore.ts";

const dbPath = join(tmpdir(), `cc-discord-memory-smoke-${process.pid}-${Date.now()}.db`);
const store = new SqliteMemoryStore({ dbPath });
const coordinator = new MemoryCoordinator({ store, logger: console });

try {
  await coordinator.init();

  const health = await store.health();
  assert.equal(health.ok, true);

  const sessionKey = `smoke-${randomUUID()}`;
  const batchId = `batch-${randomUUID()}`;

  const write1 = await store.writeBatch({
    batchId,
    sessionKey,
    agentId: "claude-test",
    turns: [
      { role: "user", content: "Hello memory store" },
      { role: "assistant", content: "Hi, I remember that." },
    ],
    snapshot: {
      summaryText: "User greeted the assistant",
      openTasks: ["Keep tracking context"],
      decisions: ["Use sqlite primary memory store"],
    },
    cardsUpsert: [
      {
        cardType: "decision",
        title: "Storage choice",
        body: "Use sqlite as primary memory store",
        pinned: true,
      },
    ],
  });

  assert.equal(write1.idempotent, false);
  assert.equal(write1.counts.turns, 2);
  assert.equal(write1.counts.snapshots, 1);
  assert.equal(write1.counts.cardsUpserted, 1);

  const write2 = await store.writeBatch({
    batchId,
    sessionKey,
    turns: [{ role: "user", content: "This should not be written twice" }],
  });

  assert.equal(write2.idempotent, true);

  const snapshot = await store.readSessionSnapshot(sessionKey);
  assert.ok(snapshot);
  assert.equal(snapshot.summaryText, "User greeted the assistant");

  const turns = await store.listTurns({ sessionKey, limit: 10 });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turnIndex, 0);
  assert.equal(turns[1].turnIndex, 1);

  const recentTurns = await store.listRecentTurns({ sessionKey, limit: 1 });
  assert.equal(recentTurns.length, 1);
  assert.equal(recentTurns[0].turnIndex, 1);

  const cards = await store.queryCards({ sessionKey, limit: 10 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cardType, "decision");

  const runtimeState = await coordinator.ensureRuntimeContext({
    sessionKey,
    runtimeContextId: "runtime-current",
    runtimeEpoch: 1,
  });

  await coordinator.appendTurn({
    sessionKey,
    role: "user",
    content: "Legacy runtime detail: we chose sqlite for memory",
    metadata: { runtimeContextId: "runtime-legacy", runtimeEpoch: 0 },
  });

  await coordinator.appendTurn({
    sessionKey,
    role: "user",
    content: "Current runtime only detail: temporary debug flag is on",
    metadata: {
      runtimeContextId: runtimeState.runtimeContextId,
      runtimeEpoch: runtimeState.runtimeEpoch,
    },
  });

  const currentRuntimeTurn = (await store.listRecentTurns({ sessionKey, limit: 5 })).find((t: any) =>
    /Current runtime only detail/.test(t.content),
  );
  assert.ok(currentRuntimeTurn);

  const legacyContext = await coordinator.assembleContext({
    sessionKey,
    queryText: "what did we choose for memory backend?",
    runtimeContextId: runtimeState.runtimeContextId,
    runtimeEpoch: runtimeState.runtimeEpoch,
    maxCards: 3,
    maxRecallTurns: 4,
  });
  assert.ok(legacyContext);
  assert.ok(Array.isArray(legacyContext.cards));
  assert.equal(
    legacyContext.recalledTurns.some((t: any) => /Legacy runtime detail/.test(t.content)),
    true,
  );

  const filteredContext = await coordinator.assembleContext({
    sessionKey,
    queryText: "is temporary debug flag on?",
    runtimeContextId: runtimeState.runtimeContextId,
    runtimeEpoch: runtimeState.runtimeEpoch,
    maxCards: 2,
    maxRecallTurns: 6,
  });

  assert.equal(
    filteredContext.recalledTurns.some((t: any) => /Current runtime only detail/.test(t.content)),
    false,
  );

  // Compaction caveat: once current-runtime turn is compacted, it becomes eligible again.
  await store.writeBatch({
    batchId: `compact-${randomUUID()}`,
    sessionKey,
    compactedToTurnId: currentRuntimeTurn.id,
  });

  const postCompactionContext = await coordinator.assembleContext({
    sessionKey,
    queryText: "is temporary debug flag on?",
    runtimeContextId: runtimeState.runtimeContextId,
    runtimeEpoch: runtimeState.runtimeEpoch,
    maxCards: 2,
    maxRecallTurns: 6,
  });

  assert.equal(
    postCompactionContext.recalledTurns.some((t: any) => /Current runtime only detail/.test(t.content)),
    true,
  );

  const contextText = coordinator.formatContextPacket(postCompactionContext);
  assert.equal(typeof contextText, "string");

  console.log(`Memory smoke test passed (db=${dbPath})`);
} finally {
  await store.close().catch(() => {});
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* ignore */
  }
}
