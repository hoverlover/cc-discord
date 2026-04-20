export interface PendingReplySummary {
  channel_id: string;
  pending_count: number;
  last_message_content: string;
}

function oneLine(text: string, maxLength: number = 320): string {
  const normalized = String(text || "").replace(/\r/g, "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function buildPendingReplyBlockReason(rows: PendingReplySummary[]): string {
  const items = rows.filter(Boolean);
  if (items.length === 0) {
    return "WAIT BLOCKED: A Discord reply is still required before waiting for more messages.";
  }

  const latest = items[0];
  const commandHint = latest.channel_id
    ? `send-discord --channel ${latest.channel_id} "your reply"`
    : `send-discord "your reply"`;

  const summaries = items.map((row) => {
    const countLabel = row.pending_count > 1 ? `pending=${row.pending_count}` : "pending=1";
    return `- [channel:${row.channel_id}] ${countLabel} latest: ${oneLine(row.last_message_content)}`;
  });

  return [
    "WAIT BLOCKED: A delivered Discord message still requires a reply.",
    "Plain assistant text does not send anything to Discord.",
    "Call send-discord with the actual reply before waiting for more messages again.",
    `Required next step: ${commandHint}`,
    "",
    "Outstanding reply obligations:",
    ...summaries,
  ].join("\n");
}
