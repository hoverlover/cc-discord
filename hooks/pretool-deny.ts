export function buildPreToolUseDeny(reason: string) {
  return {
    // Kept for older Claude Code releases that accepted top-level PreToolUse blocks.
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
