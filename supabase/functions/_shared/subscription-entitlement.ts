// Pure mapping from a Stripe Subscription to our customer entitlement columns.
// Kept side-effect-free so it can be unit-tested; stripe-webhook applies it.

export interface SubscriptionEntitlement {
  subscription_active: boolean;
  subscription_expires_at: string | null;
  subscription_cancel_at_period_end: boolean;
}

interface StripeSubscriptionLike {
  status: string;
  current_period_end?: number | null; // unix seconds
  cancel_at_period_end?: boolean | null;
  cancellation_details?: { reason?: string | null } | null;
}

// Statuses where the customer still has access. past_due keeps access while
// Stripe retries; access is revoked once the subscription becomes canceled/unpaid.
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** True when the subscription ended because Stripe could not collect payment
 *  (dunning retries exhausted, or a dispute). Only these endings warrant the
 *  "ended because we couldn't charge you" email — voluntary cancellations are
 *  confirmed at cancel time and get no second email at period end. */
export function endedDueToPaymentFailure(sub: StripeSubscriptionLike): boolean {
  const reason = sub.cancellation_details?.reason ?? null;
  return reason === "payment_failed" || reason === "payment_disputed";
}

export function entitlementFromSubscription(
  sub: StripeSubscriptionLike,
): SubscriptionEntitlement {
  const active = ACTIVE_STATUSES.has(sub.status);
  const expiresAt =
    active && sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null;
  return {
    subscription_active: active,
    subscription_expires_at: expiresAt,
    subscription_cancel_at_period_end: active ? Boolean(sub.cancel_at_period_end) : false,
  };
}
