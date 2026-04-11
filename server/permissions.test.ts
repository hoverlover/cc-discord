import { describe, expect, it } from "bun:test";
import { isAllowedBot, isAllowedUser, shouldProcessMessage } from "./permissions.ts";

describe("permissions", () => {
  describe("isAllowedBot", () => {
    it("should return false when userId is undefined", () => {
      expect(isAllowedBot(undefined, [])).toBe(false);
      expect(isAllowedBot(undefined, ["123", "456"])).toBe(false);
    });

    it("should return false when userId is empty string", () => {
      expect(isAllowedBot("", [])).toBe(false);
      expect(isAllowedBot("", ["123", "456"])).toBe(false);
    });

    it("should return false when allowedBotIds is empty", () => {
      expect(isAllowedBot("123456789", [])).toBe(false);
    });

    it("should return true when bot ID is in the allowed list", () => {
      expect(isAllowedBot("123456789", ["123456789", "987654321"])).toBe(true);
    });

    it("should return false when bot ID is not in the allowed list", () => {
      expect(isAllowedBot("000000000", ["123456789", "987654321"])).toBe(false);
    });

    it("should handle single-item allowlist", () => {
      expect(isAllowedBot("123456789", ["123456789"])).toBe(true);
      expect(isAllowedBot("987654321", ["123456789"])).toBe(false);
    });
  });

  describe("isAllowedUser", () => {
    it("should return false when userId is undefined", () => {
      expect(isAllowedUser(undefined, [])).toBe(false);
      expect(isAllowedUser(undefined, ["123", "456"])).toBe(false);
    });

    it("should return false when userId is empty string", () => {
      expect(isAllowedUser("", [])).toBe(false);
      expect(isAllowedUser("", ["123", "456"])).toBe(false);
    });

    it("should return true when allowedUserIds is empty (allow all users)", () => {
      expect(isAllowedUser("123456789", [])).toBe(true);
      expect(isAllowedUser("any-user-id", [])).toBe(true);
    });

    it("should return true when user ID is in the allowed list", () => {
      expect(isAllowedUser("123456789", ["123456789", "987654321"])).toBe(true);
    });

    it("should return false when user ID is not in the allowed list", () => {
      expect(isAllowedUser("000000000", ["123456789", "987654321"])).toBe(false);
    });

    it("should handle single-item allowlist", () => {
      expect(isAllowedUser("123456789", ["123456789"])).toBe(true);
      expect(isAllowedUser("987654321", ["123456789"])).toBe(false);
    });
  });

  describe("shouldProcessMessage", () => {
    describe("bot messages", () => {
      it("should reject bot when allowlist is empty", () => {
        const result = shouldProcessMessage({
          authorId: "123456789",
          isBot: true,
          allowedUserIds: [],
          allowedBotIds: [],
        });
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe("bot_not_approved");
      });

      it("should accept approved bot", () => {
        const result = shouldProcessMessage({
          authorId: "123456789",
          isBot: true,
          allowedUserIds: [],
          allowedBotIds: ["123456789"],
        });
        expect(result.shouldProcess).toBe(true);
        expect(result.reason).toBe("approved_bot");
      });

      it("should reject unapproved bot when other bots are approved", () => {
        const result = shouldProcessMessage({
          authorId: "000000000",
          isBot: true,
          allowedUserIds: [],
          allowedBotIds: ["123456789", "987654321"],
        });
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe("bot_not_approved");
      });
    });

    describe("user messages", () => {
      it("should accept user when allowlist is empty", () => {
        const result = shouldProcessMessage({
          authorId: "123456789",
          isBot: false,
          allowedUserIds: [],
          allowedBotIds: [],
        });
        expect(result.shouldProcess).toBe(true);
        expect(result.reason).toBe("allowed_user");
      });

      it("should accept approved user", () => {
        const result = shouldProcessMessage({
          authorId: "123456789",
          isBot: false,
          allowedUserIds: ["123456789"],
          allowedBotIds: [],
        });
        expect(result.shouldProcess).toBe(true);
        expect(result.reason).toBe("allowed_user");
      });

      it("should reject unapproved user when allowlist is set", () => {
        const result = shouldProcessMessage({
          authorId: "000000000",
          isBot: false,
          allowedUserIds: ["123456789", "987654321"],
          allowedBotIds: [],
        });
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe("user_not_allowed");
      });
    });

    describe("edge cases", () => {
      it("should reject message with undefined authorId", () => {
        const result = shouldProcessMessage({
          authorId: undefined,
          isBot: false,
          allowedUserIds: [],
          allowedBotIds: [],
        });
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe("missing_author_id");
      });

      it("should reject message with empty authorId", () => {
        const result = shouldProcessMessage({
          authorId: "",
          isBot: false,
          allowedUserIds: [],
          allowedBotIds: [],
        });
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe("missing_author_id");
      });

      it("should reject bot even if its ID is in user allowlist", () => {
        // This tests the bot check happens first - a bot should not be
        // automatically approved just because it's in the user allowlist
        const result = shouldProcessMessage({
          authorId: "123456789",
          isBot: true,
          allowedUserIds: ["123456789"],
          allowedBotIds: ["987654321"], // Different bot is approved
        });
        expect(result.shouldProcess).toBe(false);
        expect(result.reason).toBe("bot_not_approved");
      });
    });

    describe("real-world scenarios", () => {
      it("should handle mixed user and bot allowlists", () => {
        const config = {
          allowedUserIds: ["user-1", "user-2"],
          allowedBotIds: ["bot-1", "bot-2"],
        };

        // Approved user
        expect(shouldProcessMessage({ authorId: "user-1", isBot: false, ...config }).shouldProcess).toBe(true);
        
        // Unapproved user
        expect(shouldProcessMessage({ authorId: "user-3", isBot: false, ...config }).shouldProcess).toBe(false);
        
        // Approved bot
        expect(shouldProcessMessage({ authorId: "bot-1", isBot: true, ...config }).shouldProcess).toBe(true);
        
        // Unapproved bot
        expect(shouldProcessMessage({ authorId: "bot-3", isBot: true, ...config }).shouldProcess).toBe(false);
        
        // User ID that matches bot ID in list (should not be auto-approved as bot)
        expect(shouldProcessMessage({ authorId: "user-1", isBot: true, ...config }).shouldProcess).toBe(false);
      });

      it("should handle production-like IDs", () => {
        const config = {
          allowedUserIds: ["123456789012345678", "876543210987654321"],
          allowedBotIds: ["111111111111111111", "222222222222222222"],
        };

        expect(shouldProcessMessage({ 
          authorId: "111111111111111111", 
          isBot: true, 
          ...config 
        })).toEqual({ shouldProcess: true, reason: "approved_bot" });

        expect(shouldProcessMessage({ 
          authorId: "123456789012345678", 
          isBot: false, 
          ...config 
        })).toEqual({ shouldProcess: true, reason: "allowed_user" });
      });
    });
  });
});
