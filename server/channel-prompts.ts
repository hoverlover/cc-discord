export type ChannelPromptRecord = {
  prompt: string;
  messageId: string;
};

export type PromptSource = "slash-command" | "legacy-pin" | "none";

export type ChannelPromptResponse = {
  success: true;
  prompt: string | null;
  messageId: string | null;
  channelId: string;
  source: PromptSource;
};

export function buildChannelPromptResponse(
  channelId: string,
  record: ChannelPromptRecord | null,
  source: Exclude<PromptSource, "none"> = "slash-command",
): ChannelPromptResponse {
  if (!record) {
    return {
      success: true,
      prompt: null,
      messageId: null,
      channelId,
      source: "none",
    };
  }

  return {
    success: true,
    prompt: record.prompt,
    messageId: record.messageId,
    channelId,
    source,
  };
}

export function findLegacyPinnedPrompt(pinnedItems: readonly unknown[]): ChannelPromptRecord | null {
  for (const item of pinnedItems) {
    const pinnedItem = getObject(item);
    const message = getObject(pinnedItem?.message);
    if (!message) continue;

    const text = typeof message.content === "string" ? message.content.trim() : "";
    const match = text.match(/^!(?:system|prompt)\s+(.*)/is);
    if (!match) continue;

    const prompt = match[1]?.trim() || "";
    const messageId = typeof message.id === "string" ? message.id : "";
    if (prompt && messageId) {
      return { prompt, messageId };
    }
  }

  return null;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
