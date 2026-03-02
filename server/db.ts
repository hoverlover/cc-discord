/**
 * Database initialization and query helpers for the relay server.
 */

import { Database as DatabaseSync } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "messages.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    session_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    message_type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'discord',
    external_id TEXT,
    channel_id TEXT,
    read INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_activity (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    activity_type TEXT,
    activity_summary TEXT,
    started_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
  CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(read);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_external
    ON messages(source, external_id);
  CREATE INDEX IF NOT EXISTS idx_agent_activity_status
    ON agent_activity(status);

  CREATE TABLE IF NOT EXISTS channel_models (
    channel_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
  );
`);

export const insertStmt = db.prepare(`
  INSERT INTO messages (
    session_id,
    from_agent,
    to_agent,
    message_type,
    content,
    source,
    external_id,
    channel_id,
    read
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function getChannelModel(channelId: string) {
  try {
    const row = db.prepare("SELECT model FROM channel_models WHERE channel_id = ?").get(channelId) as any;
    return row?.model || null;
  } catch {
    return null;
  }
}

export function setChannelModel(channelId: string, model: string, updatedBy: string | null) {
  db.prepare(`
    INSERT INTO channel_models (channel_id, model, updated_at, updated_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      model = excluded.model,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(channelId, model, updatedBy || null);
}

export function clearChannelModel(channelId: string) {
  db.prepare("DELETE FROM channel_models WHERE channel_id = ?").run(channelId);
}

export function getCurrentAgentActivity(sessionId: string, defaultAgentId: string, agentIdOverride?: string | null) {
  const targetAgent = agentIdOverride || defaultAgentId;
  try {
    return db
      .prepare(`
      SELECT status, activity_type, activity_summary, started_at, updated_at
      FROM agent_activity
      WHERE session_id = ? AND agent_id = ?
      LIMIT 1
    `)
      .get(sessionId, targetAgent);
  } catch {
    return null;
  }
}

/**
 * Get health status for all agents in a session.
 * Returns each agent's last heartbeat time, status, and whether it
 * has unread messages waiting (a sign it might be stuck).
 */
export function getAgentHealthAll(sessionId: string, staleThresholdSeconds: number = 900) {
  try {
    const agents = db
      .prepare(`
      SELECT
        a.agent_id,
        a.status,
        a.activity_type,
        a.activity_summary,
        a.updated_at,
        CAST((julianday('now') - julianday(a.updated_at)) * 86400 AS INTEGER) as seconds_since_heartbeat,
        COALESCE(m.unread_count, 0) as unread_count,
        m.oldest_unread_at
      FROM agent_activity a
      LEFT JOIN (
        SELECT
          to_agent,
          COUNT(*) as unread_count,
          MIN(created_at) as oldest_unread_at
        FROM messages
        WHERE session_id = ? AND read = 0
        GROUP BY to_agent
      ) m ON m.to_agent = a.agent_id
      WHERE a.session_id = ?
      ORDER BY a.agent_id
    `)
      .all(sessionId, sessionId);

    return agents.map((a: any) => ({
      agentId: a.agent_id,
      status: a.status,
      activityType: a.activity_type,
      activitySummary: a.activity_summary,
      lastHeartbeat: a.updated_at,
      secondsSinceHeartbeat: a.seconds_since_heartbeat,
      unreadCount: a.unread_count,
      oldestUnreadAt: a.oldest_unread_at,
      healthy: a.seconds_since_heartbeat < staleThresholdSeconds,
      stuck: a.seconds_since_heartbeat >= staleThresholdSeconds && a.unread_count > 0,
    }));
  } catch {
    return [];
  }
}
