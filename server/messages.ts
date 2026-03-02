/**
 * Message persistence and formatting for inbound/outbound Discord messages.
 */

import { fetchAttachmentContent } from "./attachment.ts";
import { CLAUDE_AGENT_ID, DEFAULT_CHANNEL_ID, DISCORD_SESSION_ID, MESSAGE_ROUTING_MODE } from "./config.ts";
import { insertStmt } from "./db.ts";
import { appendMemoryTurn } from "./memory.ts";

export async function formatInboundMessage(message: any) {
  const author = message.author?.username || message.author?.globalName || message.author?.id || "unknown";
  const base = message.content?.trim() || "";
  const attachments = [...message.attachments.values()];

  let fullText = base;
  if (attachments.length > 0) {
    const attachmentLines = await Promise.all(attachments.map((a: any) => fetchAttachmentContent(a, message.id)));
    const attachmentText = attachmentLines.join("\n");
    fullText = fullText ? `${fullText}\n${attachmentText}` : attachmentText;
  }

  if (!fullText) {
    fullText = "[No text content]";
  }

  return `${author}: ${fullText}`;
}

export async function persistInboundDiscordMessage(message: any): Promise<boolean> {
  const normalizedContent = await formatInboundMessage(message);
  // In channel mode, route to channelId so per-channel subagents consume independently.
  // In agent mode (legacy), route to CLAUDE_AGENT_ID for single-agent consumption.
  const targetAgent = MESSAGE_ROUTING_MODE === "agent" ? CLAUDE_AGENT_ID : message.channelId;

  try {
    insertStmt.run(
      DISCORD_SESSION_ID,
      `discord:${message.author?.id || "unknown"}`,
      targetAgent,
      "DISCORD_MESSAGE",
      normalizedContent,
      "discord",
      message.id,
      message.channelId,
      0,
    );

    void appendMemoryTurn({
      role: "user",
      content: normalizedContent,
      metadata: {
        source: "discord",
        messageId: message.id,
        channelId: message.channelId,
        authorId: message.author?.id || null,
      },
    });

    console.log(`[Relay] queued Discord message ${message.id} -> ${targetAgent}`);
    return true;
  } catch (err: unknown) {
    const msg = String((err as any)?.message || "");
    if (msg.includes("UNIQUE constraint failed")) {
      // Discord can re-deliver in edge cases; idempotent ignore
      return false;
    }
    console.error("[Relay] failed to persist inbound message:", (err as Error).message);
    return false;
  }
}

export function persistOutboundDiscordMessage({
  content,
  channelId,
  externalId,
  fromAgent,
}: {
  content: string;
  channelId?: string;
  externalId?: string;
  fromAgent?: string;
}) {
  const normalizedContent = String(content);
  const normalizedFromAgent = fromAgent || CLAUDE_AGENT_ID;
  const normalizedChannelId = channelId || DEFAULT_CHANNEL_ID || "";

  try {
    insertStmt.run(
      DISCORD_SESSION_ID,
      normalizedFromAgent,
      "discord",
      "DISCORD_REPLY",
      normalizedContent,
      "relay-outbound",
      externalId || null,
      normalizedChannelId,
      1,
    );

    void appendMemoryTurn({
      role: "assistant",
      content: normalizedContent,
      metadata: {
        source: "discord",
        messageId: externalId || null,
        channelId: normalizedChannelId,
        fromAgent: normalizedFromAgent,
      },
    });
  } catch (err: unknown) {
    console.error("[Relay] failed to persist outbound message:", (err as Error).message);
  }
}
