-- Repair: acc_verifications ended up with TWO source_type check constraints.
--
-- 20260405221422 created the table with an inline check (auto-named
-- acc_verifications_source_type_check) allowing ('purchase', 'manual',
-- 'vat_adjustment'). 20260611100000 then ADDed the sales-accounting set as a
-- NEW constraint (acc_verifications_source_type_chk) without dropping the old
-- one. Rows must satisfy both, and the intersection is just 'purchase' — so
-- posting a sales invoice or customer payment violates the stale constraint
-- (23514). The stale constraint was dropped manually on the test project but
-- never as a migration, which is why prod still failed.
--
-- Converge every environment on one canonical constraint. Existing rows are
-- safe: 20260611100000 already validated all rows against this exact set when
-- it was applied.

ALTER TABLE public.acc_verifications
  DROP CONSTRAINT IF EXISTS acc_verifications_source_type_check;

ALTER TABLE public.acc_verifications
  DROP CONSTRAINT IF EXISTS acc_verifications_source_type_chk;

ALTER TABLE public.acc_verifications
  ADD CONSTRAINT acc_verifications_source_type_chk
  CHECK (source_type IN ('purchase', 'sales_invoice', 'sales_invoice_correction', 'customer_payment'));
