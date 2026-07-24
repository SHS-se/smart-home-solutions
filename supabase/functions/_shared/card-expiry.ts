// Pure classification of a saved card's expiry against the next renewal, so
// the portal can warn the customer before a renewal charge fails. Kept
// side-effect-free for unit testing; check-subscription applies it.

export type CardExpiryStatus = "ok" | "expires_before_renewal" | "expired";

/** A card is valid through the last instant of its expiry month (UTC). */
export function cardExpiryStatus(args: {
  expMonth: number; // 1-12
  expYear: number; // four digits
  now: Date;
  renewalAt?: string | null; // ISO timestamp of the next renewal, if known
}): CardExpiryStatus {
  const validUntil = new Date(Date.UTC(args.expYear, args.expMonth, 1)); // first instant after the expiry month
  if (args.now.getTime() >= validUntil.getTime()) return "expired";
  if (args.renewalAt) {
    const renewal = new Date(args.renewalAt);
    if (!Number.isNaN(renewal.getTime()) && renewal.getTime() >= validUntil.getTime()) {
      return "expires_before_renewal";
    }
  }
  return "ok";
}
