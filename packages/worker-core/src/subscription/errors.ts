/** Reasons a subscription operation is refused. Typed so a caller can branch. */
export type SubscriptionErrorCode =
  | "INVALID_WEBHOOK_TARGET"
  | "NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "INVALID_TRANSITION"
  | "TIER_NOT_REGISTRABLE"
  | "INVALID_FIELD";

/**
 * Thrown when a subscription operation is refused - an unknown or disabled
 * tier, a webhook target the SSRF guard rejects, or an illegal lifecycle
 * action. Carries a {@link SubscriptionErrorCode} in `code` so callers
 * branch on the cause rather than parsing the message.
 */
export class SubscriptionError extends Error {
  constructor(
    public readonly code: SubscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionError";
  }
}
