-- Add indexes on foreign-key columns that are joined or filtered by the app
-- but have no index yet. All additive and idempotent; safe on any DB state.
-- (Postgres does not auto-index FK referencing columns.)

-- Accounting journal: lines are always fetched per verification, and
-- verifications are listed per period.
CREATE INDEX IF NOT EXISTS idx_acc_journal_lines_verification_id
  ON public.acc_journal_lines (verification_id);
CREATE INDEX IF NOT EXISTS idx_acc_purchase_lines_purchase_id
  ON public.acc_purchase_lines (purchase_id);
CREATE INDEX IF NOT EXISTS idx_acc_verifications_period_id
  ON public.acc_verifications (period_id);

-- Customer-scoped lookups (RLS policies and portal pages filter on these).
CREATE INDEX IF NOT EXISTS idx_quotes_customer_id
  ON public.quotes (customer_id);
CREATE INDEX IF NOT EXISTS idx_boms_customer_id
  ON public.boms (customer_id);
CREATE INDEX IF NOT EXISTS idx_device_instances_customer_id
  ON public.device_instances (customer_id);
CREATE INDEX IF NOT EXISTS idx_model_runs_home_id
  ON public.model_runs (home_id);
CREATE INDEX IF NOT EXISTS idx_contacts_converted_to_customer_id
  ON public.contacts (converted_to_customer_id);
