import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CC_DISCORD_DATA_DIR;
});

describe("unserviced target recovery after restart", () => {
  test("clearing stale agent activity restores unread targets to /api/unserviced", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cc-discord-db-"));
    tempDirs.push(dataDir);
    process.env.CC_DISCORD_DATA_DIR = dataDir;

    const dbModule = await import(new URL(`./db.ts?test=${Date.now()}`, import.meta.url).href);
    const { db, insertStmt, getUnservicedTargets, clearAgentActivityForSession } = dbModule;

    const unique = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const sessionId = `restart-session-${unique}`;
    const channelId = `1477${unique}`;
    const externalId = `msg-${unique}`;

    insertStmt.run(
      sessionId,
      "discord:user-1",
      channelId,
      "DISCORD_MESSAGE",
      "user: ping",
      "discord",
      externalId,
      channelId,
      0,
    );

    db.prepare(`
      INSERT INTO agent_activity (
        session_id,
        agent_id,
        status,
        activity_type,
        activity_summary,
        started_at,
        updated_at
      ) VALUES (?, ?, 'idle', NULL, NULL, NULL, ?)
    `).run(sessionId, channelId, "2026-01-01T00:00:00.000Z");

    expect(getUnservicedTargets(sessionId)).toEqual([]);
    expect(clearAgentActivityForSession(sessionId)).toBe(1);

    const targets = getUnservicedTargets(sessionId);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.toAgent).toBe(channelId);
    expect(Number(targets[0]?.unreadCount)).toBe(1);
    expect(typeof targets[0]?.oldestAt).toBe("string");

    db.close();
  });
});
