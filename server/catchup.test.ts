import { describe, expect, it } from "bun:test";
import { shouldCatchUpMessage } from "./catchup.ts";

describe("shouldCatchUpMessage", () => {
  it("allows regular users when the user allowlist is empty", () => {
    expect(
      shouldCatchUpMessage(
        { author: { id: "user-123", bot: false } },
        { allowedUserIds: [], allowedBotIds: [] },
      ),
    ).toBe(true);
  });

  it("allows approved bot messages during catch-up", () => {
    expect(
      shouldCatchUpMessage(
        { author: { id: "bot-123", bot: true } },
        { allowedUserIds: ["user-1"], allowedBotIds: ["bot-123"] },
      ),
    ).toBe(true);
  });

  it("blocks unapproved bot messages during catch-up", () => {
    expect(
      shouldCatchUpMessage(
        { author: { id: "bot-999", bot: true } },
        { allowedUserIds: ["user-1"], allowedBotIds: ["bot-123"] },
      ),
    ).toBe(false);
  });

  it("blocks unapproved users when a user allowlist is set", () => {
    expect(
      shouldCatchUpMessage(
        { author: { id: "user-999", bot: false } },
        { allowedUserIds: ["user-123"], allowedBotIds: [] },
      ),
    ).toBe(false);
  });
});
