/**
 * Integration tests for bot message handling in the messageCreate handler.
 * These tests verify the logic flow without needing actual Discord connections.
 */

import { describe, expect, it } from "bun:test";
import { shouldProcessMessage } from "./permissions.ts";

/**
 * Simulates the messageCreate handler logic from index.ts
 */
function simulateMessageCreateHandler(options: {
  message: {
    id: string;
    authorId: string | undefined;
    username: string;
    isBot: boolean;
    channelId: string;
    isThread: boolean;
    isTraceThread: boolean;
    content: string;
  };
  config: {
    allowedUserIds: string[];
    allowedBotIds: string[];
    ignoredChannelIds: string[];
    allowedChannelIds: string[];
  };
}): {
  processed: boolean;
  logMessages: string[];
  typingStarted: boolean;
} {
  const { message, config } = options;
  const logMessages: string[] = [];
  let typingStarted = false;

  // Helper to simulate console.log
  const log = (msg: string) => logMessages.push(msg);

  // Simulate: if (!message) return;
  if (!message) {
    return { processed: false, logMessages, typingStarted };
  }

  // Simulate: if (message.author?.bot && !isAllowedBot(message.author?.id)) return;
  if (message.isBot) {
    const permission = shouldProcessMessage({
      authorId: message.authorId,
      isBot: message.isBot,
      allowedUserIds: config.allowedUserIds,
      allowedBotIds: config.allowedBotIds,
    });
    
    if (!permission.shouldProcess) {
      log(`[Relay] Ignoring message from unapproved bot ${message.username} (${message.authorId}) - ${permission.reason}`);
      return { processed: false, logMessages, typingStarted };
    }
    
    log(`[Relay] Processing message from approved bot ${message.username} (${message.authorId})`);
  }

  // Simulate: if (!isAllowedChannelForMessage(message)) return;
  if (config.ignoredChannelIds.includes(message.channelId)) {
    log(`[Relay] Ignoring message from ignored channel ${message.channelId}`);
    return { processed: false, logMessages, typingStarted };
  }
  
  if (config.allowedChannelIds.length > 0 && !config.allowedChannelIds.includes(message.channelId)) {
    log(`[Relay] Ignoring message from unauthorized channel ${message.channelId}`);
    return { processed: false, logMessages, typingStarted };
  }

  // Simulate: if (message.channel?.isThread?.() && isTraceThread(message.channelId)) return;
  if (message.isThread && message.isTraceThread) {
    log(`[Relay] Ignoring message from trace thread ${message.channelId}`);
    return { processed: false, logMessages, typingStarted };
  }

  // Simulate: if (!isAllowedUser(message.author?.id)) return;
  if (!message.isBot) {
    const permission = shouldProcessMessage({
      authorId: message.authorId,
      isBot: message.isBot,
      allowedUserIds: config.allowedUserIds,
      allowedBotIds: config.allowedBotIds,
    });
    
    if (!permission.shouldProcess) {
      log(`[Relay] Ignoring message from unauthorized user ${message.authorId}`);
      return { processed: false, logMessages, typingStarted };
    }
  }

  // Simulate message processing
  typingStarted = true;
  log(`[Relay] queued Discord message ${message.id} -> ${message.channelId}`);
  
  return { processed: true, logMessages, typingStarted };
}

describe("messageCreate handler simulation", () => {
  const defaultConfig = {
    allowedUserIds: [] as string[],
    allowedBotIds: [] as string[],
    ignoredChannelIds: [] as string[],
    allowedChannelIds: [] as string[],
  };

  describe("bot message handling", () => {
    it("should block bot messages by default (empty ALLOWED_BOT_IDS)", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "bot-123",
          username: "TestBot",
          isBot: true,
          channelId: "chan-456",
          isThread: false,
          isTraceThread: false,
          content: "Hello from bot",
        },
        config: defaultConfig,
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages).toContain(
        "[Relay] Ignoring message from unapproved bot TestBot (bot-123) - bot_not_approved"
      );
      expect(result.typingStarted).toBe(false);
    });

    it("should process messages from approved bots", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "bot-123",
          username: "ApprovedBot",
          isBot: true,
          channelId: "chan-456",
          isThread: false,
          isTraceThread: false,
          content: "Hello from approved bot",
        },
        config: {
          ...defaultConfig,
          allowedBotIds: ["bot-123"],
        },
      });

      expect(result.processed).toBe(true);
      expect(result.logMessages).toContain(
        "[Relay] Processing message from approved bot ApprovedBot (bot-123)"
      );
      expect(result.logMessages).toContain(
        "[Relay] queued Discord message msg-1 -> chan-456"
      );
      expect(result.typingStarted).toBe(true);
    });

    it("should block unapproved bot even when some bots are approved", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "malicious-bot",
          username: "EvilBot",
          isBot: true,
          channelId: "chan-456",
          isThread: false,
          isTraceThread: false,
          content: "I should be blocked",
        },
        config: {
          ...defaultConfig,
          allowedBotIds: ["approved-bot-1", "approved-bot-2"],
        },
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages).toContain(
        "[Relay] Ignoring message from unapproved bot EvilBot (malicious-bot) - bot_not_approved"
      );
    });

    it("should handle multiple approved bots", () => {
      const approvedBots = ["bot-1", "bot-2", "bot-3"];
      
      for (const botId of approvedBots) {
        const result = simulateMessageCreateHandler({
          message: {
            id: `msg-${botId}`,
            authorId: botId,
            username: `Bot${botId}`,
            isBot: true,
            channelId: "chan-456",
            isThread: false,
            isTraceThread: false,
            content: "Hello",
          },
          config: {
            ...defaultConfig,
            allowedBotIds: approvedBots,
          },
        });

        expect(result.processed).toBe(true);
      }
    });

    it("should skip user allowlist check for approved bots", () => {
      // This tests the bug fix: approved bots were being rejected by the user check
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "approved-bot-123",
          username: "ApprovedBot",
          isBot: true,
          channelId: "chan-456",
          isThread: false,
          isTraceThread: false,
          content: "Hello",
        },
        config: {
          allowedUserIds: ["admin-1", "admin-2"], // User allowlist is restricted
          allowedBotIds: ["approved-bot-123"],
          ignoredChannelIds: [],
          allowedChannelIds: [],
        },
      });

      expect(result.processed).toBe(true);
      expect(result.logMessages).toContain(
        "[Relay] Processing message from approved bot ApprovedBot (approved-bot-123)"
      );
    });
  });

  describe("regular user messages", () => {
    it("should process user messages when user allowlist is empty", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "user-123",
          username: "RegularUser",
          isBot: false,
          channelId: "chan-456",
          isThread: false,
          isTraceThread: false,
          content: "Hello",
        },
        config: defaultConfig,
      });

      expect(result.processed).toBe(true);
      expect(result.typingStarted).toBe(true);
    });

    it("should block unapproved user when allowlist is set", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "unauthorized-user",
          username: "Stranger",
          isBot: false,
          channelId: "chan-456",
          isThread: false,
          isTraceThread: false,
          content: "Hello",
        },
        config: {
          ...defaultConfig,
          allowedUserIds: ["user-1", "user-2"],
        },
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages).toContain(
        "[Relay] Ignoring message from unauthorized user unauthorized-user"
      );
    });
  });

  describe("channel filtering", () => {
    it("should ignore messages from ignored channels", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "user-123",
          username: "User",
          isBot: false,
          channelId: "ignored-chan",
          isThread: false,
          isTraceThread: false,
          content: "Hello",
        },
        config: {
          ...defaultConfig,
          ignoredChannelIds: ["ignored-chan"],
        },
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages).toContain(
        "[Relay] Ignoring message from ignored channel ignored-chan"
      );
    });

    it("should ignore messages from unauthorized channels when allowlist is set", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "user-123",
          username: "User",
          isBot: false,
          channelId: "unauthorized-chan",
          isThread: false,
          isTraceThread: false,
          content: "Hello",
        },
        config: {
          ...defaultConfig,
          allowedChannelIds: ["allowed-chan"],
        },
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages).toContain(
        "[Relay] Ignoring message from unauthorized channel unauthorized-chan"
      );
    });
  });

  describe("trace thread handling", () => {
    it("should ignore messages from trace threads", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "user-123",
          username: "User",
          isBot: false,
          channelId: "trace-thread-123",
          isThread: true,
          isTraceThread: true,
          content: "Hello",
        },
        config: defaultConfig,
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages).toContain(
        "[Relay] Ignoring message from trace thread trace-thread-123"
      );
    });
  });

  describe("complex scenarios", () => {
    it("should handle approved bot in allowed channel with both allowlists set", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "trusted-bot-123",
          username: "TrustedBot",
          isBot: true,
          channelId: "allowed-channel-456",
          isThread: false,
          isTraceThread: false,
          content: "Important update",
        },
        config: {
          allowedUserIds: ["admin-1", "admin-2"],
          allowedBotIds: ["trusted-bot-123", "service-bot-456"],
          ignoredChannelIds: [],
          allowedChannelIds: ["allowed-channel-456", "allowed-channel-789"],
        },
      });

      expect(result.processed).toBe(true);
      expect(result.logMessages).toContain(
        "[Relay] Processing message from approved bot TrustedBot (trusted-bot-123)"
      );
    });

    it("should reject approved bot in unauthorized channel", () => {
      const result = simulateMessageCreateHandler({
        message: {
          id: "msg-1",
          authorId: "trusted-bot-123",
          username: "TrustedBot",
          isBot: true,
          channelId: "unauthorized-channel",
          isThread: false,
          isTraceThread: false,
          content: "Hello",
        },
        config: {
          allowedUserIds: [],
          allowedBotIds: ["trusted-bot-123"],
          ignoredChannelIds: [],
          allowedChannelIds: ["allowed-channel-456"],
        },
      });

      expect(result.processed).toBe(false);
      expect(result.logMessages.some(m => m.includes("unauthorized channel"))).toBe(true);
    });
  });
});
