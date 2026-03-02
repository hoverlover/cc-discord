#!/usr/bin/env bun
/**
 * parse-claude-stream.ts — Transform Claude CLI stream-json output into
 * human-readable log lines.
 *
 * Reads NDJSON from stdin (as produced by `claude -p --output-format stream-json --verbose`),
 * extracts the interesting events (assistant text, tool use, tool results, errors,
 * thinking/reasoning), and writes concise, timestamped log lines to stdout.
 *
 * Claude CLI stream-json event types (v2.x):
 *   type:"system"    subtype:"init"|"hook_started"|"hook_response"
 *   type:"assistant"  message:{content:[...], usage:{...}}
 *   type:"user"       message:{content:[...]} (tool results)
 *   type:"result"     subtype:"success"|"error"
 *   type:"rate_limit_event"
 *   type:"error"
 *
 * Usage:
 *   claude -p --output-format stream-json --verbose ... | bun scripts/parse-claude-stream.ts
 *
 * Environment:
 *   LOG_LEVEL=debug|info|warn  (default: info)
 *   SHOW_THINKING=1            (show extended-thinking blocks, default: 0)
 */

import { Database as DatabaseSync } from "bun:sqlite";
import { join } from "node:path";

const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const SHOW_THINKING = process.env.SHOW_THINKING === "1";

// ---- Trace thread integration ----
// Write reasoning/thinking blocks to the trace_events DB table so
// the relay server can post them to the channel's live Agent Trace thread.

const TRACE_ENABLED = String(process.env.TRACE_THREAD_ENABLED || "true").toLowerCase() !== "false";
const TRACE_SESSION_ID = process.env.DISCORD_SESSION_ID || process.env.SESSION_ID || "default";
const TRACE_AGENT_ID = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "claude";
const TRACE_CHANNEL_ID = TRACE_AGENT_ID; // In channel routing mode, agent_id IS the channel ID
const ORCHESTRATOR_DIR = process.env.ORCHESTRATOR_DIR || "";
const DATA_DIR = process.env.CC_DISCORD_DATA_DIR || join(process.env.HOME || "", ".cc-discord", "data");

let traceDb: InstanceType<typeof DatabaseSync> | null = null;

function getTraceDb(): InstanceType<typeof DatabaseSync> | null {
  if (!TRACE_ENABLED) return null;
  if (traceDb) return traceDb;
  try {
    const dbPath = join(DATA_DIR, "messages.db");
    traceDb = new DatabaseSync(dbPath);
    traceDb.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        channel_id TEXT,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        summary TEXT,
        posted INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_trace_events_pending
        ON trace_events(posted, created_at);
    `);
    return traceDb;
  } catch {
    return null;
  }
}

function writeTraceEvent(eventType: string, toolName: string | null, summary: string) {
  try {
    const db = getTraceDb();
    if (!db) return;
    db.prepare(`
      INSERT INTO trace_events (session_id, agent_id, channel_id, event_type, tool_name, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(TRACE_SESSION_ID, TRACE_AGENT_ID, TRACE_CHANNEL_ID, eventType, toolName, summary);
  } catch {
    // fail-open — never break the parser for trace
  }
}

// ---- Helpers ----

function ts(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function log(tag: string, msg: string) {
  const line = `[${ts()}] [${tag}] ${msg}`;
  process.stdout.write(`${line}\n`);
}

function debug(tag: string, msg: string) {
  if (LOG_LEVEL === "debug") log(tag, msg);
}

/** Truncate long strings for log display */
function trunc(s: string, max = 200): string {
  s = s.replace(/\n/g, "\\n");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- Event handling ----

/**
 * Handle a top-level NDJSON event from the Claude CLI stream-json output.
 */
function handleEvent(evt: any) {
  if (!evt || typeof evt !== "object") return;

  const type: string = evt.type ?? "";

  // -- system events: init, hooks --
  if (type === "system") {
    const subtype: string = evt.subtype ?? "";

    if (subtype === "init") {
      const model = evt.model ?? "?";
      const sid = evt.session_id ?? "?";
      const mode = evt.permissionMode ?? "?";
      log("init", `model=${model} session=${sid} mode=${mode}`);
      return;
    }

    if (subtype === "hook_started") {
      debug("hook", `started ${evt.hook_name ?? "?"}`);
      return;
    }

    if (subtype === "hook_response") {
      const code = evt.exit_code ?? "?";
      const outcome = evt.outcome ?? "?";
      if (outcome !== "success" || code !== 0) {
        log("hook", `${evt.hook_name ?? "?"} exit=${code} outcome=${outcome}`);
        if (evt.stderr) log("hook:stderr", trunc(String(evt.stderr), 300));
      } else {
        debug("hook", `${evt.hook_name ?? "?"} ok`);
      }
      return;
    }

    // Other system subtypes
    debug("system", `subtype=${subtype} ${trunc(JSON.stringify(evt), 200)}`);
    return;
  }

  // -- assistant turn: contains message with content blocks --
  if (type === "assistant") {
    const msg = evt.message;
    if (!msg) {
      debug("assistant", "empty message");
      return;
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          log("assistant", trunc(block.text, 500));
        } else if (block.type === "tool_use") {
          const name = block.name ?? "?";
          const input = block.input ?? {};
          // Format tool inputs concisely
          if (name === "Bash") {
            const cmd = input.command ?? "";
            const desc = input.description ?? "";
            log("tool_use", `Bash: ${trunc(desc || cmd, 400)}`);
          } else if (name === "Read") {
            log("tool_use", `Read: ${input.file_path ?? "?"}`);
          } else if (name === "Edit" || name === "Write") {
            log("tool_use", `${name}: ${input.file_path ?? "?"}`);
          } else {
            log("tool_use", `${name} ${trunc(JSON.stringify(input), 300)}`);
          }
        } else if (block.type === "thinking" && block.thinking) {
          if (SHOW_THINKING) {
            log("thinking", trunc(block.thinking, 300));
          } else {
            debug("thinking", trunc(block.thinking, 300));
          }
          // Write full reasoning to trace thread (no truncation)
          writeTraceEvent("thinking", null, block.thinking);
        }
      }
    }

    // Log usage summary
    const usage = msg.usage;
    if (usage) {
      const input_tokens = usage.input_tokens ?? 0;
      const cache_read = usage.cache_read_input_tokens ?? 0;
      const output_tokens = usage.output_tokens ?? 0;
      debug("usage", `in=${input_tokens} cache=${cache_read} out=${output_tokens}`);
    }
    return;
  }

  // -- user turn: typically tool results --
  if (type === "user") {
    const msg = evt.message;
    if (!msg) return;

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const output = block.output ?? block.content ?? "";
          const str = typeof output === "string" ? output : JSON.stringify(output);
          debug("tool_result", trunc(str, 300));
        }
      }
    }
    return;
  }

  // -- result: session complete --
  if (type === "result") {
    const subtype = evt.subtype ?? "?";
    const duration = evt.duration_ms ? `${(evt.duration_ms / 1000).toFixed(1)}s` : "?";
    const cost = evt.total_cost_usd ? `$${evt.total_cost_usd.toFixed(4)}` : "";
    const turns = evt.num_turns ?? "?";
    log("result", `${subtype} duration=${duration} turns=${turns} ${cost}`.trim());
    return;
  }

  // -- rate limit --
  if (type === "rate_limit_event") {
    const info = evt.rate_limit_info ?? {};
    if (info.status !== "allowed") {
      log("rate_limit", `status=${info.status} resets=${info.resetsAt ?? "?"}`);
    } else {
      debug("rate_limit", `allowed`);
    }
    return;
  }

  // -- error --
  if (type === "error") {
    const errMsg = typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error ?? evt);
    log("ERROR", trunc(errMsg, 500));
    return;
  }

  // ---- Legacy / raw Anthropic streaming API format (fallback) ----

  if (
    type === "content_block_start" ||
    type === "content_block_delta" ||
    type === "content_block_stop" ||
    type === "message_start" ||
    type === "message_delta" ||
    type === "message_stop"
  ) {
    // Legacy streaming format — log at debug
    debug("legacy_stream", `type=${type}`);
    return;
  }

  // -- init (legacy format) --
  if (type === "init") {
    const sid = evt.session_id ?? "unknown";
    log("init", `session=${sid}`);
    return;
  }

  // -- message (legacy format) --
  if (type === "message") {
    const role = evt.role ?? "?";
    if (Array.isArray(evt.content)) {
      for (const block of evt.content) {
        if (block.type === "text" && block.text) {
          log(role, trunc(block.text, 500));
        } else if (block.type === "tool_use") {
          log("tool_use", `${block.name ?? "?"} ${trunc(JSON.stringify(block.input ?? {}), 300)}`);
        }
      }
    }
    return;
  }

  // Unknown event — log at info so we catch new event types
  log("unknown_event", `type=${type} ${trunc(JSON.stringify(evt), 300)}`);
}

function processLine(line: string) {
  line = line.trim();
  if (!line) return;

  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — pass through as-is (e.g. stderr leaking into stdout)
    log("raw", trunc(line, 300));
    return;
  }

  // stream_event wrapper (some versions wrap events)
  if (parsed.type === "stream_event" && parsed.event) {
    handleEvent(parsed.event);
  } else {
    handleEvent(parsed);
  }
}

// ---- Main: read stdin line by line ----

async function main() {
  log("parser", "Claude stream parser started");

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let leftover = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      // Last element might be incomplete — save for next chunk
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        processLine(line);
      }
    }

    // Process any remaining data
    if (leftover.trim()) {
      processLine(leftover);
    }
  } finally {
    // no-op — buffers removed since CLI sends complete messages
  }

  log("parser", "Stream ended");

  // Clean up trace DB connection
  try { traceDb?.close(); } catch { /* ignore */ }
}

main().catch((err) => {
  log("FATAL", String(err));
  process.exit(1);
});
