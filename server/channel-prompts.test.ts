import { describe, expect, test } from "bun:test";
import {
  buildChannelPromptResponse,
  findLegacyPinnedPrompt,
  parseChannelPromptApiResponse,
} from "./channel-prompts.ts";

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

  test("chooses the newest legacy pinned prompt deterministically", () => {
    expect(
      findLegacyPinnedPrompt([
        {
          pinned_at: "2026-05-20T12:00:00.000Z",
          message: { id: "message-older", content: "!prompt Older behavior" },
        },
        {
          pinned_at: "2026-05-21T12:00:00.000Z",
          message: { id: "message-newer", content: "!prompt Newer behavior" },
        },
      ]),
    ).toEqual({
      prompt: "Newer behavior",
      messageId: "message-newer",
    });
  });

  test("parses successful prompt API snapshots", () => {
    expect(
      parseChannelPromptApiResponse(
        JSON.stringify({
          success: true,
          prompt: "Use concise answers.",
          messageId: "message-1",
          channelId: "channel-1",
          source: "slash-command",
        }),
      ),
    ).toEqual({ status: "ok", prompt: "Use concise answers." });
  });

  test("parses the no-prompt state as a valid empty snapshot", () => {
    expect(
      parseChannelPromptApiResponse(
        JSON.stringify({
          success: true,
          prompt: null,
          messageId: null,
          channelId: "channel-1",
          source: "none",
        }),
      ),
    ).toEqual({ status: "ok", prompt: "" });
  });

  test("does not treat unsuccessful API responses as empty prompts", () => {
    expect(
      parseChannelPromptApiResponse(JSON.stringify({ success: false, error: "Discord client not ready yet" })),
    ).toEqual({
      status: "invalid",
      reason: "response did not report success",
    });
  });

  test("detects gone channel responses separately", () => {
    expect(
      parseChannelPromptApiResponse(
        JSON.stringify({
          success: false,
          error: "Channel not found in Discord",
          code: "UNKNOWN_CHANNEL",
          channelId: "channel-1",
        }),
      ),
    ).toEqual({ status: "gone" });
  });
});
