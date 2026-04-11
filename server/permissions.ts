/**
 * Test utilities for bot/user permission logic.
 * These are pure functions extracted for easy testing.
 */

/**
 * Check if a bot user ID is in the approved list.
 * Returns false if the allowlist is empty (secure by default).
 */
export function isAllowedBot(userId: string | undefined, allowedBotIds: string[]): boolean {
  if (!userId) return false;
  if (allowedBotIds.length === 0) return false;
  return allowedBotIds.includes(userId);
}

/**
 * Check if a user ID is allowed.
 * Returns true if the allowlist is empty (allow all by default for users).
 */
export function isAllowedUser(userId: string | undefined, allowedUserIds: string[]): boolean {
  if (!userId) return false;
  if (allowedUserIds.length === 0) return true;
  return allowedUserIds.includes(userId);
}

/**
 * Determine if a message should be processed based on author and configuration.
 */
export function shouldProcessMessage(options: {
  authorId: string | undefined;
  isBot: boolean;
  allowedUserIds: string[];
  allowedBotIds: string[];
}): { shouldProcess: boolean; reason?: string } {
  const { authorId, isBot, allowedUserIds, allowedBotIds } = options;

  if (!authorId) {
    return { shouldProcess: false, reason: "missing_author_id" };
  }

  if (isBot) {
    if (isAllowedBot(authorId, allowedBotIds)) {
      return { shouldProcess: true, reason: "approved_bot" };
    }
    return { shouldProcess: false, reason: "bot_not_approved" };
  }

  // Regular user
  if (isAllowedUser(authorId, allowedUserIds)) {
    return { shouldProcess: true, reason: "allowed_user" };
  }

  return { shouldProcess: false, reason: "user_not_allowed" };
}
