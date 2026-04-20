import { describe, expect, it } from "bun:test";
import { buildPendingReplyBlockReason } from "./reply-obligation.ts";

describe("buildPendingReplyBlockReason", () => {
  it("includes the required send-discord next step for a single pending channel", () => {
    const reason = buildPendingReplyBlockReason([
      {
        channel_id: "1483004233027551358",
        pending_count: 1,
        last_message_content: "ChelaMail: New email for alfred@chela.email",
      },
    ]);

    expect(reason).toContain("WAIT BLOCKED");
    expect(reason).toContain('send-discord --channel 1483004233027551358 "your reply"');
    expect(reason).toContain("Plain assistant text does not send anything to Discord.");
    expect(reason).toContain("ChelaMail: New email for alfred@chela.email");
  });

  it("summarizes multiple outstanding reply obligations", () => {
    const reason = buildPendingReplyBlockReason([
      {
        channel_id: "chan-a",
        pending_count: 2,
        last_message_content: "user-a: first line\nsecond line",
      },
      {
        channel_id: "chan-b",
        pending_count: 1,
        last_message_content: "user-b: hello",
      },
    ]);

    expect(reason).toContain("[channel:chan-a] pending=2 latest: user-a: first line second line");
    expect(reason).toContain("[channel:chan-b] pending=1 latest: user-b: hello");
  });
});
