import { describe, expect, test } from "bun:test";
import { buildChannelPromptResponse, findLegacyPinnedPrompt } from "./channel-prompts.ts";

describe("channel prompt responses", () => {
  test("returns no prompt when there is no slash-command-managed record", () => {
    expect(buildChannelPromptResponse("channel-1", null)).toEqual({
      success: true,
      prompt: null,
      messageId: null,
      channelId: "channel-1",
      source: "none",
    });
  });

  test("returns slash-command-managed prompt records unchanged", () => {
    expect(
      buildChannelPromptResponse("channel-1", {
        prompt: "Use concise answers.",
        messageId: "message-1",
      }),
    ).toEqual({
      success: true,
      prompt: "Use concise answers.",
      messageId: "message-1",
      channelId: "channel-1",
      source: "slash-command",
    });
  });

  test("can parse legacy pinned prompt records only when the caller explicitly opts in", () => {
    expect(
      findLegacyPinnedPrompt([
        { message: { id: "message-1", content: "ordinary pinned note" } },
        { message: { id: "message-2", content: "!prompt Legacy behavior" } },
      ]),
    ).toEqual({
      prompt: "Legacy behavior",
      messageId: "message-2",
    });
  });
});
