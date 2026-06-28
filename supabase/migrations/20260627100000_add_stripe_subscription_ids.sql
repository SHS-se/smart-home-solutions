-- Stripe subscription wiring. Maps each customer to its Stripe Customer and
-- Subscription so:
--   * create-subscription can reuse one Stripe Customer per customer, and
--   * stripe-webhook can resolve incoming events back to our customer row.
-- subscription_active / subscription_expires_at already exist (read by
-- check-subscription); we add the cancel flag so the portal can show "Avbryts".

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS customers_stripe_customer_id_idx
  ON public.customers (stripe_customer_id);

COMMENT ON COLUMN public.customers.stripe_customer_id IS
  'Stripe Customer id, created on first self-subscribe. stripe-webhook maps events back to our customer via this.';
COMMENT ON COLUMN public.customers.stripe_subscription_id IS
  'Stripe Subscription id of the customer''s current/most-recent subscription.';
COMMENT ON COLUMN public.customers.subscription_cancel_at_period_end IS
  'True when the Stripe subscription is set to cancel at period end (access retained until subscription_expires_at).';
