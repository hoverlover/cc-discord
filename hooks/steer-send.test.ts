import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_DIR = join(import.meta.dir, "..");
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-discord-steer-send-"));
  tempDirs.push(dir);
  return dir;
}

function createUnreadMessage(dataDir: string, options: { sessionId: string; agentId: string }) {
  const db = new Database(join(dataDir, "messages.db"));
  db.exec(`
    CREATE TABLE messages (
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
    )
  `);
  db.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    options.sessionId,
    "discord:user-1",
    options.agentId,
    "DISCORD_MESSAGE",
    "Chad: follow-up while composing",
    "discord",
    "msg-1",
    options.agentId,
  );
  db.close();
}

function runSteerSendHook(dataDir: string, command: string, agentId: string) {
  return spawnSync("bun", ["hooks/steer-send.ts"], {
    cwd: ROOT_DIR,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
    env: {
      ...process.env,
      AGENT_ID: agentId,
      CC_DISCORD_DATA_DIR: dataDir,
      DISCORD_SESSION_ID: "default",
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("steer-send hook", () => {
  it("denies send-discord with current PreToolUse output when unread messages arrived", () => {
    const dataDir = makeDataDir();
    const channelId = "1483004233027551358";
    createUnreadMessage(dataDir, { sessionId: "default", agentId: channelId });

    const result = runSteerSendHook(dataDir, `send-discord --channel ${channelId} "reply"`, channelId);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.toString());
    expect(body.decision).toBe("block");
    expect(body.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("SEND BLOCKED");

    const db = new Database(join(dataDir, "messages.db"));
    const row = db.prepare("SELECT read FROM messages WHERE external_id = ?").get("msg-1") as { read: number };
    db.close();
    expect(row.read).toBe(1);
  });
});
