import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_DIR = join(import.meta.dir, "..");
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-discord-require-reply-"));
  tempDirs.push(dir);
  return dir;
}

function createPendingReply(dataDir: string, options: { sessionId: string; agentId: string; channelId: string }) {
  const db = new Database(join(dataDir, "messages.db"));
  db.exec(`
    CREATE TABLE pending_replies (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      pending_count INTEGER NOT NULL DEFAULT 1,
      last_message_content TEXT NOT NULL,
      last_external_id TEXT,
      pending_since TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, agent_id, channel_id)
    )
  `);
  db.prepare(`
    INSERT INTO pending_replies (
      session_id,
      agent_id,
      channel_id,
      pending_count,
      last_message_content,
      last_external_id
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(options.sessionId, options.agentId, options.channelId, "Chad: FYI only, no action needed", "msg-1");
  db.close();
}

function runRequireReplyHook(dataDir: string, command: string) {
  return spawnSync("bun", ["hooks/require-reply.ts"], {
    cwd: ROOT_DIR,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
    env: {
      ...process.env,
      CC_DISCORD_DATA_DIR: dataDir,
      CLAUDE_AGENT_ID: "wrong-agent",
      DISCORD_SESSION_ID: "default",
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("require-reply hook", () => {
  it("denies a wait command when the command-scoped agent still owes a reply", () => {
    const dataDir = makeDataDir();
    const channelId = "1483004233027551358";
    createPendingReply(dataDir, { sessionId: "default", agentId: channelId, channelId });

    const result = runRequireReplyHook(
      dataDir,
      `AGENT_ID=${channelId} wait-for-discord-messages --deliver --timeout 600`,
    );

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout.toString());
    expect(body.decision).toBe("block");
    expect(body.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("WAIT BLOCKED");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain(`send-discord --channel ${channelId}`);
  });

  it("allows unrelated Bash commands", () => {
    const dataDir = makeDataDir();
    const result = runRequireReplyHook(dataDir, "echo ok");

    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
});
