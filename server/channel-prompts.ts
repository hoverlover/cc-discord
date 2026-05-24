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

export type ParsedChannelPromptSnapshot =
  | {
      status: "ok";
      prompt: string;
    }
  | {
      status: "gone";
    }
  | {
      status: "invalid";
      reason: string;
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
  const candidates: Array<ChannelPromptRecord & { pinnedAtMs: number }> = [];

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
      candidates.push({
        prompt,
        messageId,
        pinnedAtMs: parsePinnedAt(pinnedItem?.pinned_at),
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.pinnedAtMs !== b.pinnedAtMs) return b.pinnedAtMs - a.pinnedAtMs;
    return b.messageId.localeCompare(a.messageId);
  });

  return candidates[0] ? { prompt: candidates[0].prompt, messageId: candidates[0].messageId } : null;
}

export function parseChannelPromptApiResponse(input: string): ParsedChannelPromptSnapshot {
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    return { status: "invalid", reason: "response was not valid JSON" };
  }

  const response = getObject(data);
  if (!response) {
    return { status: "invalid", reason: "response was not an object" };
  }

  if (response.code === "UNKNOWN_CHANNEL") {
    return { status: "gone" };
  }

  if (response.success !== true) {
    return { status: "invalid", reason: "response did not report success" };
  }

  if (response.prompt === null) {
    return { status: "ok", prompt: "" };
  }

  if (typeof response.prompt !== "string") {
    return { status: "invalid", reason: "response prompt was not a string or null" };
  }

  return { status: "ok", prompt: response.prompt };
}

function parsePinnedAt(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
