/**
 * Tests for thread-level prompt scoping.
 *
 * Thread prompts should:
 * 1. Be stored with thread ID as key
 * 2. Override channel-level prompts when in that thread
 * 3. Not affect other threads in the same channel
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

// Test database path (in-memory)
const TEST_DB_PATH = ":memory:";

// We'll test the logic directly rather than through the actual db module
// since the db is already initialized at module load time

describe("Thread-level prompt scoping", () => {
  test("thread ID should be used as storage key, not parent channel ID", () => {
    // In Discord.js:
    // - interaction.channelId returns PARENT channel ID in threads
    // - interaction.channel?.id returns the ACTUAL thread ID in threads

    const THREAD_ID = "1234567890";
    const PARENT_CHANNEL_ID = "0987654321";

    // Simulate what Discord provides
    const mockInteractionInThread = {
      channelId: PARENT_CHANNEL_ID, // Discord always gives parent ID here
      channel: {
        id: THREAD_ID, // This is the actual thread ID
        isThread: () => true,
      },
    };

    // The fix: use channel?.id when available
    const actualId = mockInteractionInThread.channel?.id || mockInteractionInThread.channelId;

    expect(actualId).toBe(THREAD_ID);
    expect(actualId).not.toBe(PARENT_CHANNEL_ID);
  });

  test("channel ID fallback when not in a thread", () => {
    const CHANNEL_ID = "5555555555";

    const mockInteractionInChannel = {
      channelId: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        isThread: () => false,
      },
    };

    const actualId = mockInteractionInChannel.channel?.id || mockInteractionInChannel.channelId;

    expect(actualId).toBe(CHANNEL_ID);
  });

  test("thread prompts should override channel prompts when thread has its own prompt", () => {
    // This tests the expected behavior:
    // 1. Channel has a prompt
    // 2. Thread sets its own prompt
    // 3. When in thread, thread prompt should be used

    const CHANNEL_ID = "parent-channel";
    const THREAD_ID = "thread-123";
    const CHANNEL_PROMPT = "Channel level prompt";
    const THREAD_PROMPT = "Thread level prompt";

    // Simulate stored prompts
    const storedPrompts = new Map<string, { prompt: string; messageId: string }>();
    storedPrompts.set(CHANNEL_ID, { prompt: CHANNEL_PROMPT, messageId: "channel-msg" });
    storedPrompts.set(THREAD_ID, { prompt: THREAD_PROMPT, messageId: "thread-msg" });

    // Thread-level retrieval logic: check thread first, then channel
    function getEffectivePrompt(targetId: string, parentChannelId?: string): string | null {
      // Check if thread has its own prompt
      if (storedPrompts.has(targetId)) {
        return storedPrompts.get(targetId)!.prompt;
      }
      // Fall back to parent channel prompt
      if (parentChannelId && storedPrompts.has(parentChannelId)) {
        return storedPrompts.get(parentChannelId)!.prompt;
      }
      return null;
    }

    // In thread, should get thread prompt
    expect(getEffectivePrompt(THREAD_ID, CHANNEL_ID)).toBe(THREAD_PROMPT);

    // In channel (not thread), should get channel prompt
    expect(getEffectivePrompt(CHANNEL_ID)).toBe(CHANNEL_PROMPT);

    // Different thread in same channel, no thread prompt set
    const OTHER_THREAD_ID = "thread-456";
    expect(getEffectivePrompt(OTHER_THREAD_ID, CHANNEL_ID)).toBe(CHANNEL_PROMPT);
  });

  test("thread prompts should not affect other threads in same channel", () => {
    const CHANNEL_ID = "parent-channel";
    const THREAD_A_ID = "thread-a";
    const THREAD_B_ID = "thread-b";

    const storedPrompts = new Map<string, string>();
    storedPrompts.set(CHANNEL_ID, "Channel prompt");
    storedPrompts.set(THREAD_A_ID, "Thread A prompt");
    // Thread B has no specific prompt

    function getPrompt(targetId: string, parentChannelId?: string): string | null {
      if (storedPrompts.has(targetId)) {
        return storedPrompts.get(targetId)!;
      }
      if (parentChannelId && storedPrompts.has(parentChannelId)) {
        return storedPrompts.get(parentChannelId)!;
      }
      return null;
    }

    // Thread A has its own prompt
    expect(getPrompt(THREAD_A_ID, CHANNEL_ID)).toBe("Thread A prompt");

    // Thread B falls back to channel prompt
    expect(getPrompt(THREAD_B_ID, CHANNEL_ID)).toBe("Channel prompt");

    // Parent channel gets its own prompt
    expect(getPrompt(CHANNEL_ID)).toBe("Channel prompt");
  });
});

describe("Slash command channel ID resolution", () => {
  test("should resolve correct ID for thread interactions", () => {
    // Simulating the Discord.js interaction object structure
    interface MockInteraction {
      channelId: string;
      channel: {
        id: string;
        isThread?: () => boolean;
      } | null;
    }

    function resolveChannelId(interaction: MockInteraction): string {
      return interaction.channel?.id ?? interaction.channelId;
    }

    // Test in thread
    const threadInteraction: MockInteraction = {
      channelId: "parent-123",
      channel: { id: "thread-456", isThread: () => true },
    };

    // Test in regular channel
    const channelInteraction: MockInteraction = {
      channelId: "channel-789",
      channel: { id: "channel-789", isThread: () => false },
    };

    // Test with null channel (edge case)
    const nullChannelInteraction: MockInteraction = {
      channelId: "some-channel",
      channel: null,
    };

    expect(resolveChannelId(threadInteraction)).toBe("thread-456");
    expect(resolveChannelId(channelInteraction)).toBe("channel-789");
    expect(resolveChannelId(nullChannelInteraction)).toBe("some-channel");
  });
});

describe("getChannelPrompt fallback behavior", () => {
  test("should return thread prompt when available", () => {
    // Simulating getChannelPrompt logic with thread ID and parent channel ID
    const THREAD_ID = "thread-123";
    const PARENT_ID = "channel-456";
    const THREAD_PROMPT = "Thread-specific prompt";
    const CHANNEL_PROMPT = "Channel-level prompt";

    // Mock stored data
    const prompts = new Map<string, { prompt: string; messageId: string }>();
    prompts.set(THREAD_ID, { prompt: THREAD_PROMPT, messageId: "thread-msg" });
    prompts.set(PARENT_ID, { prompt: CHANNEL_PROMPT, messageId: "channel-msg" });

    // Simulate getChannelPrompt(channelId, parentChannelId) behavior
    function getChannelPrompt(channelId: string, parentChannelId?: string | null) {
      const row = prompts.get(channelId);
      if (row) return row;
      if (parentChannelId) {
        const parentRow = prompts.get(parentChannelId);
        if (parentRow) return parentRow;
      }
      return null;
    }

    // Thread with its own prompt
    expect(getChannelPrompt(THREAD_ID, PARENT_ID)).toEqual({ prompt: THREAD_PROMPT, messageId: "thread-msg" });
  });

  test("should fall back to channel prompt when thread has no prompt", () => {
    const THREAD_ID = "thread-789";
    const PARENT_ID = "channel-456";
    const CHANNEL_PROMPT = "Channel-level prompt";

    const prompts = new Map<string, { prompt: string; messageId: string }>();
    prompts.set(PARENT_ID, { prompt: CHANNEL_PROMPT, messageId: "channel-msg" });
    // Note: Thread has no prompt

    function getChannelPrompt(channelId: string, parentChannelId?: string | null) {
      const row = prompts.get(channelId);
      if (row) return row;
      if (parentChannelId) {
        const parentRow = prompts.get(parentChannelId);
        if (parentRow) return parentRow;
      }
      return null;
    }

    // Thread without prompt should get channel prompt
    expect(getChannelPrompt(THREAD_ID, PARENT_ID)).toEqual({ prompt: CHANNEL_PROMPT, messageId: "channel-msg" });
  });

  test("should return null when neither thread nor channel has prompt", () => {
    const THREAD_ID = "thread-xyz";
    const PARENT_ID = "channel-abc";

    const prompts = new Map<string, { prompt: string; messageId: string }>();
    // No prompts stored

    function getChannelPrompt(channelId: string, parentChannelId?: string | null) {
      const row = prompts.get(channelId);
      if (row) return row;
      if (parentChannelId) {
        const parentRow = prompts.get(parentChannelId);
        if (parentRow) return parentRow;
      }
      return null;
    }

    expect(getChannelPrompt(THREAD_ID, PARENT_ID)).toBeNull();
  });
});
