import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryStore } from "../../core/MemoryStore.ts";
import { clamp, MemoryCardTypes, MemoryScopes, nowIso, safeJsonParse, safeJsonStringify } from "../../core/types.ts";

const DEFAULT_DB_PATH = join(process.cwd(), "data", "memory.db");

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory_sessions (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    agent_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memory_turns (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_key) REFERENCES memory_sessions(session_key),
    UNIQUE(session_key, turn_index)
  );

  CREATE TABLE IF NOT EXISTS memory_snapshots (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    open_tasks_json TEXT NOT NULL DEFAULT '[]',
    decisions_json TEXT NOT NULL DEFAULT '[]',
    compacted_to_turn_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_key) REFERENCES memory_sessions(session_key)
  );

  CREATE TABLE IF NOT EXISTS memory_cards (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'session',
    card_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    pinned INTEGER DEFAULT 0,
    source_turn_from TEXT,
    source_turn_to TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_key) REFERENCES memory_sessions(session_key)
  );

  CREATE TABLE IF NOT EXISTS memory_compaction_state (
    session_key TEXT PRIMARY KEY,
    last_compacted_turn_id TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_key) REFERENCES memory_sessions(session_key)
  );

  CREATE TABLE IF NOT EXISTS memory_sync_jobs (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS memory_runtime_state (
    session_key TEXT PRIMARY KEY,
    runtime_context_id TEXT NOT NULL,
    runtime_epoch INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_key) REFERENCES memory_sessions(session_key)
  );

  CREATE TABLE IF NOT EXISTS memory_batch_log (
    batch_id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_memory_turns_session_turn_index
    ON memory_turns(session_key, turn_index);
  CREATE INDEX IF NOT EXISTS idx_memory_cards_session_scope_type
    ON memory_cards(session_key, scope, card_type);
  CREATE INDEX IF NOT EXISTS idx_memory_sync_jobs_status_next_attempt
    ON memory_sync_jobs(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_memory_runtime_state_context
    ON memory_runtime_state(runtime_context_id);
`;

export class SqliteMemoryStore extends MemoryStore {
  dbPath: string;
  logger: Pick<Console, "log" | "warn" | "error">;
  db: InstanceType<typeof Database> | null;

  constructor(options: { dbPath?: string; logger?: Pick<Console, "log" | "warn" | "error"> } = {}) {
    super("sqlite", {
      atomicBatch: true,
      fullTextSearch: false,
      vectorSearch: false,
      bidirectionalSync: false,
    });

    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.logger = options.logger || console;
    this.db = null;
  }

  async init() {
    if (this.db) return;

    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  async health() {
    try {
      await this.init();
      const db = this.#requireDb();
      const row = db.prepare("SELECT 1 as ok").get() as any;
      return { ok: row?.ok === 1, details: this.dbPath };
    } catch (err: any) {
      return { ok: false, details: err?.message || String(err) };
    }
  }

  async writeBatch(inputBatch: any) {
    await this.init();

    const batch = normalizeBatch(inputBatch);
    const db = this.#requireDb();

    const result = {
      ok: true,
      idempotent: false,
      batchId: batch.batchId,
      sessionKey: batch.sessionKey,
      counts: {
        turns: 0,
        snapshots: 0,
        cardsUpserted: 0,
        cardsDeleted: 0,
      },
    };

    let attempts = 0;
    while (true) {
      attempts++;
      try {
        db.exec("BEGIN IMMEDIATE");

        const existingBatch = db
          .prepare(`
          SELECT batch_id
          FROM memory_batch_log
          WHERE batch_id = ?
        `)
          .get(batch.batchId);

        if (existingBatch) {
          db.exec("COMMIT");
          result.idempotent = true;
          return result;
        }

        const now = nowIso();
        ensureSessionRow(db, batch.sessionKey, batch.agentId, now);

        db.prepare(`
          INSERT INTO memory_batch_log (batch_id, session_key, created_at)
          VALUES (?, ?, ?)
        `).run(batch.batchId, batch.sessionKey, now);

        if (batch.turns.length > 0) {
          let nextTurnIndex = (
            db
              .prepare(`
            SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_index
            FROM memory_turns
            WHERE session_key = ?
          `)
              .get(batch.sessionKey) as any
          ).next_index;

          for (const turn of batch.turns) {
            const turnIndex = Number.isInteger(turn.turnIndex) ? turn.turnIndex : nextTurnIndex;
            if (turnIndex >= nextTurnIndex) {
              nextTurnIndex = turnIndex + 1;
            }

            db.prepare(`
              INSERT INTO memory_turns (
                id,
                session_key,
                turn_index,
                role,
                content,
                metadata_json,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              turn.id,
              batch.sessionKey,
              turnIndex,
              turn.role,
              turn.content,
              safeJsonStringify(turn.metadata, "null"),
              turn.createdAt,
            );

            result.counts.turns++;
          }
        }

        if (batch.snapshot) {
          db.prepare(`
            INSERT INTO memory_snapshots (
              id,
              session_key,
              summary_text,
              open_tasks_json,
              decisions_json,
              compacted_to_turn_id,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            batch.snapshot.id,
            batch.sessionKey,
            batch.snapshot.summaryText,
            safeJsonStringify(batch.snapshot.openTasks, "[]"),
            safeJsonStringify(batch.snapshot.decisions, "[]"),
            batch.snapshot.compactedToTurnId,
            batch.snapshot.createdAt,
          );

          result.counts.snapshots++;
        }

        if (batch.cardsUpsert.length > 0) {
          for (const card of batch.cardsUpsert) {
            db.prepare(`
              INSERT INTO memory_cards (
                id,
                session_key,
                scope,
                card_type,
                title,
                body,
                confidence,
                pinned,
                source_turn_from,
                source_turn_to,
                expires_at,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                session_key = excluded.session_key,
                scope = excluded.scope,
                card_type = excluded.card_type,
                title = excluded.title,
                body = excluded.body,
                confidence = excluded.confidence,
                pinned = excluded.pinned,
                source_turn_from = excluded.source_turn_from,
                source_turn_to = excluded.source_turn_to,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
            `).run(
              card.id,
              batch.sessionKey,
              card.scope,
              card.cardType,
              card.title,
              card.body,
              card.confidence,
              card.pinned ? 1 : 0,
              card.sourceTurnFrom,
              card.sourceTurnTo,
              card.expiresAt,
              card.createdAt,
              card.updatedAt,
            );
            result.counts.cardsUpserted++;
          }
        }

        if (batch.cardsDelete.length > 0) {
          const placeholders = batch.cardsDelete.map(() => "?").join(",");
          const deleteResult = db
            .prepare(`
            DELETE FROM memory_cards
            WHERE id IN (${placeholders})
          `)
            .run(...batch.cardsDelete);
          result.counts.cardsDeleted += (deleteResult as any).changes || 0;
        }

        const compactedToTurnId =
          batch.compactedToTurnId !== undefined ? batch.compactedToTurnId : batch.snapshot?.compactedToTurnId;

        if (compactedToTurnId !== undefined) {
          db.prepare(`
            INSERT INTO memory_compaction_state (session_key, last_compacted_turn_id, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
              last_compacted_turn_id = excluded.last_compacted_turn_id,
              updated_at = excluded.updated_at
          `).run(batch.sessionKey, compactedToTurnId, nowIso());
        }

        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }

        if (isSqliteBusy(err) && attempts < 4) {
          this.logger.warn?.(`[Memory] SQLite busy, retrying writeBatch (attempt ${attempts}/4)`);
          continue;
        }

        throw err;
      }
    }
  }

  async readSessionSnapshot(sessionKey: string) {
    await this.init();
    const key = normalizeSessionKey(sessionKey);

    const db = this.#requireDb();
    const row = db
      .prepare(`
      SELECT id, session_key, summary_text, open_tasks_json, decisions_json, compacted_to_turn_id, created_at
      FROM memory_snapshots
      WHERE session_key = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `)
      .get(key) as any;

    if (!row) return null;
    return mapSnapshotRow(row);
  }

  async listTurns(input: any) {
    await this.init();

    const { sessionKey, afterTurnId = null, limit = 50 } = input || {};
    const key = normalizeSessionKey(sessionKey);
    const safeLimit = clamp(Number(limit) || 50, 1, 500);

    const db = this.#requireDb();

    let afterIndex = -1;
    if (afterTurnId) {
      const row = db
        .prepare(`
        SELECT turn_index
        FROM memory_turns
        WHERE session_key = ? AND id = ?
        LIMIT 1
      `)
        .get(key, String(afterTurnId)) as any;

      if (row) afterIndex = row.turn_index;
    }

    const rows = db
      .prepare(`
      SELECT id, session_key, turn_index, role, content, metadata_json, created_at
      FROM memory_turns
      WHERE session_key = ?
        AND turn_index > ?
      ORDER BY turn_index ASC
      LIMIT ?
    `)
      .all(key, afterIndex, safeLimit) as any[];

    return rows.map(mapTurnRow);
  }

  async listRecentTurns(input: { sessionKey: string; limit?: number } = { sessionKey: "" }) {
    await this.init();

    const { sessionKey, limit = 20 } = input;
    const key = normalizeSessionKey(sessionKey);
    const safeLimit = clamp(Number(limit) || 20, 1, 2000);

    const db = this.#requireDb();
    const rows = db
      .prepare(`
      SELECT id, session_key, turn_index, role, content, metadata_json, created_at
      FROM memory_turns
      WHERE session_key = ?
      ORDER BY turn_index DESC
      LIMIT ?
    `)
      .all(key, safeLimit) as any[];

    // Return ascending for chronological readability
    rows.reverse();
    return rows.map(mapTurnRow);
  }

  async queryCards(
    input: { sessionKey?: string; scope?: string; cardType?: string; includeExpired?: boolean; limit?: number } = {},
  ) {
    await this.init();

    const { sessionKey, scope, cardType, includeExpired = false, limit = 50 } = input;

    const safeLimit = clamp(Number(limit) || 50, 1, 500);
    const db = this.#requireDb();

    const conditions: string[] = [];
    const params: any[] = [];

    if (sessionKey) {
      conditions.push("session_key = ?");
      params.push(normalizeSessionKey(sessionKey));
    }

    if (scope) {
      conditions.push("scope = ?");
      params.push(String(scope));
    }

    if (cardType) {
      conditions.push("card_type = ?");
      params.push(String(cardType));
    }

    if (!includeExpired) {
      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(nowIso());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = db
      .prepare(`
      SELECT
        id,
        session_key,
        scope,
        card_type,
        title,
        body,
        confidence,
        pinned,
        source_turn_from,
        source_turn_to,
        expires_at,
        created_at,
        updated_at
      FROM memory_cards
      ${whereClause}
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ?
    `)
      .all(...params, safeLimit) as any[];

    return rows.map(mapCardRow);
  }

  async readCompactionState(sessionKey: string) {
    await this.init();
    const key = normalizeSessionKey(sessionKey);

    const db = this.#requireDb();
    const row = db
      .prepare(`
      SELECT session_key, last_compacted_turn_id, updated_at
      FROM memory_compaction_state
      WHERE session_key = ?
      LIMIT 1
    `)
      .get(key) as any;

    if (!row) return null;
    return {
      sessionKey: row.session_key,
      lastCompactedTurnId: row.last_compacted_turn_id,
      updatedAt: row.updated_at,
    };
  }

  async getTurnById(input: { sessionKey?: string; turnId?: string } = {}) {
    await this.init();

    const { sessionKey, turnId } = input;
    const key = normalizeSessionKey(sessionKey);
    const id = nullableString(turnId);
    if (!id) return null;

    const db = this.#requireDb();
    const row = db
      .prepare(`
      SELECT id, session_key, turn_index, role, content, metadata_json, created_at
      FROM memory_turns
      WHERE session_key = ?
        AND id = ?
      LIMIT 1
    `)
      .get(key, id) as any;

    if (!row) return null;
    return mapTurnRow(row);
  }

  async readRuntimeState(sessionKey: string) {
    await this.init();
    const key = normalizeSessionKey(sessionKey);

    const db = this.#requireDb();
    const row = db
      .prepare(`
      SELECT session_key, runtime_context_id, runtime_epoch, updated_at
      FROM memory_runtime_state
      WHERE session_key = ?
      LIMIT 1
    `)
      .get(key) as any;

    if (!row) return null;
    return {
      sessionKey: row.session_key,
      runtimeContextId: row.runtime_context_id,
      runtimeEpoch: row.runtime_epoch,
      updatedAt: row.updated_at,
    };
  }

  async upsertRuntimeState(input: { sessionKey?: string; runtimeContextId?: string; runtimeEpoch?: number } = {}) {
    await this.init();

    const sessionKey = normalizeSessionKey(input.sessionKey);
    const runtimeContextId = nullableString(input.runtimeContextId) || makeRuntimeContextId("upsert");
    const runtimeEpoch =
      Number.isInteger(input.runtimeEpoch) && (input.runtimeEpoch as number) > 0 ? (input.runtimeEpoch as number) : 1;

    const db = this.#requireDb();
    const now = nowIso();

    ensureSessionRow(db, sessionKey, null, now);

    db.prepare(`
      INSERT INTO memory_runtime_state (session_key, runtime_context_id, runtime_epoch, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        runtime_context_id = excluded.runtime_context_id,
        runtime_epoch = excluded.runtime_epoch,
        updated_at = excluded.updated_at
    `).run(sessionKey, runtimeContextId, runtimeEpoch, now);

    return {
      sessionKey,
      runtimeContextId,
      runtimeEpoch,
      updatedAt: now,
    };
  }

  async bumpRuntimeContext(input: { sessionKey?: string; runtimeContextId?: string } = {}) {
    await this.init();

    const sessionKey = normalizeSessionKey(input.sessionKey);
    const requestedRuntimeContextId = nullableString(input.runtimeContextId);
    const db = this.#requireDb();

    let attempts = 0;
    while (true) {
      attempts++;
      try {
        db.exec("BEGIN IMMEDIATE");

        const current = db
          .prepare(`
          SELECT runtime_context_id, runtime_epoch
          FROM memory_runtime_state
          WHERE session_key = ?
          LIMIT 1
        `)
          .get(sessionKey) as any;

        const nextEpoch = current ? Number(current.runtime_epoch || 0) + 1 : 1;
        const nextContextId = requestedRuntimeContextId || makeRuntimeContextId(`epoch${nextEpoch}`);
        const now = nowIso();

        ensureSessionRow(db, sessionKey, null, now);

        db.prepare(`
          INSERT INTO memory_runtime_state (session_key, runtime_context_id, runtime_epoch, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_key) DO UPDATE SET
            runtime_context_id = excluded.runtime_context_id,
            runtime_epoch = excluded.runtime_epoch,
            updated_at = excluded.updated_at
        `).run(sessionKey, nextContextId, nextEpoch, now);

        db.exec("COMMIT");

        return {
          sessionKey,
          runtimeContextId: nextContextId,
          runtimeEpoch: nextEpoch,
          updatedAt: now,
        };
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }

        if (isSqliteBusy(err) && attempts < 4) {
          this.logger.warn?.(`[Memory] SQLite busy, retrying bumpRuntimeContext (attempt ${attempts}/4)`);
          continue;
        }

        throw err;
      }
    }
  }

  async close() {
    if (!this.db) return;
    try {
      this.db.close();
    } finally {
      this.db = null;
    }
  }

  #requireDb(): InstanceType<typeof Database> {
    if (!this.db) {
      throw new Error("SqliteMemoryStore is not initialized. Call init() first.");
    }
    return this.db;
  }
}

function normalizeBatch(batch: any) {
  if (!batch || typeof batch !== "object") {
    throw new Error("writeBatch() requires a batch object");
  }

  const sessionKey = normalizeSessionKey(batch.sessionKey);
  const batchId = String(batch.batchId || batch.id || "").trim();
  if (!batchId) {
    throw new Error("writeBatch() requires batch.batchId (or batch.id)");
  }

  const compactedToTurnId = Object.hasOwn(batch, "compactedToTurnId")
    ? nullableString(batch.compactedToTurnId)
    : undefined;

  return {
    batchId,
    sessionKey,
    agentId: nullableString(batch.agentId),
    turns: normalizeTurns(batch.turns),
    snapshot: batch.snapshot ? normalizeSnapshot(batch.snapshot) : null,
    cardsUpsert: normalizeCards(batch.cardsUpsert),
    cardsDelete: normalizeCardDeletes(batch.cardsDelete),
    compactedToTurnId,
  };
}

function normalizeSessionKey(sessionKey: any): string {
  const key = String(sessionKey || "").trim();
  if (!key) throw new Error("sessionKey is required");
  return key;
}

function normalizeTurns(turns: any) {
  if (!Array.isArray(turns)) return [];

  return turns.map((turn: any) => {
    const role = String(turn?.role || "user").trim() || "user";
    const content = String(turn?.content || "");

    return {
      id: nullableString(turn?.id) || `turn_${randomUUID()}`,
      role,
      content,
      turnIndex: Number.isInteger(turn?.turnIndex) ? turn.turnIndex : null,
      metadata: turn?.metadata ?? null,
      createdAt: nullableString(turn?.createdAt) || nowIso(),
    };
  });
}

function normalizeSnapshot(snapshot: any) {
  return {
    id: nullableString(snapshot?.id) || `snapshot_${randomUUID()}`,
    summaryText: String(snapshot?.summaryText || snapshot?.summary || ""),
    openTasks: Array.isArray(snapshot?.openTasks) ? snapshot.openTasks : [],
    decisions: Array.isArray(snapshot?.decisions) ? snapshot.decisions : [],
    compactedToTurnId: nullableString(snapshot?.compactedToTurnId),
    createdAt: nullableString(snapshot?.createdAt) || nowIso(),
  };
}

function normalizeCards(cards: any) {
  if (!Array.isArray(cards)) return [];

  return cards.map((card: any) => {
    const scope = normalizeScope(card?.scope);
    const cardType = normalizeCardType(card?.cardType || card?.type);

    return {
      id: nullableString(card?.id) || `card_${randomUUID()}`,
      scope,
      cardType,
      title: String(card?.title || ""),
      body: String(card?.body || card?.content || ""),
      confidence: clamp(Number(card?.confidence ?? 0.5) || 0.5, 0, 1),
      pinned: Boolean(card?.pinned),
      sourceTurnFrom: nullableString(card?.sourceTurnFrom),
      sourceTurnTo: nullableString(card?.sourceTurnTo),
      expiresAt: nullableString(card?.expiresAt),
      createdAt: nullableString(card?.createdAt) || nowIso(),
      updatedAt: nullableString(card?.updatedAt) || nowIso(),
    };
  });
}

function normalizeCardDeletes(cardIds: any) {
  if (!Array.isArray(cardIds)) return [];
  return cardIds.map(nullableString).filter(Boolean) as string[];
}

function normalizeScope(scope: any): string {
  const value = String(scope || MemoryScopes.SESSION).toLowerCase();
  if ((Object.values(MemoryScopes) as string[]).includes(value)) return value;
  return MemoryScopes.SESSION;
}

function ensureSessionRow(
  db: InstanceType<typeof Database>,
  sessionKey: string,
  agentId: string | null,
  updatedAt: string = nowIso(),
) {
  db.prepare(`
    INSERT INTO memory_sessions (id, session_key, agent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      agent_id = COALESCE(excluded.agent_id, memory_sessions.agent_id),
      updated_at = excluded.updated_at
  `).run(`session_${randomUUID()}`, sessionKey, agentId, updatedAt, updatedAt);
}

function normalizeCardType(cardType: any): string {
  const value = String(cardType || MemoryCardTypes.CONTEXT).toLowerCase();
  if ((Object.values(MemoryCardTypes) as string[]).includes(value)) return value;
  return MemoryCardTypes.CONTEXT;
}

function nullableString(value: any): string | null {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  return out.length > 0 ? out : null;
}

function mapTurnRow(row: any) {
  return {
    id: row.id,
    sessionKey: row.session_key,
    turnIndex: row.turn_index,
    role: row.role,
    content: row.content,
    metadata: safeJsonParse(row.metadata_json, null),
    createdAt: row.created_at,
  };
}

function mapSnapshotRow(row: any) {
  return {
    id: row.id,
    sessionKey: row.session_key,
    summaryText: row.summary_text,
    openTasks: safeJsonParse(row.open_tasks_json, []),
    decisions: safeJsonParse(row.decisions_json, []),
    compactedToTurnId: row.compacted_to_turn_id,
    createdAt: row.created_at,
  };
}

function mapCardRow(row: any) {
  return {
    id: row.id,
    sessionKey: row.session_key,
    scope: row.scope,
    cardType: row.card_type,
    title: row.title,
    body: row.body,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    sourceTurnFrom: row.source_turn_from,
    sourceTurnTo: row.source_turn_to,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makeRuntimeContextId(prefix: string = "runtime") {
  const ts = Date.now().toString(36);
  const rand = randomUUID().slice(0, 8);
  return `${prefix}_${ts}_${rand}`;
}

function isSqliteBusy(err: unknown): boolean {
  const msg = String((err as any)?.message || "");
  return msg.includes("SQLITE_BUSY") || (err as any)?.code === "SQLITE_BUSY";
}
