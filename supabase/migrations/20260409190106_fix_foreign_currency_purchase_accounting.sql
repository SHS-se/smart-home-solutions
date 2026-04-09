ALTER TABLE public.acc_purchases
  ADD COLUMN IF NOT EXISTS original_currency text,
  ADD COLUMN IF NOT EXISTS original_gross_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS original_net_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS original_vat_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS ecb_exchange_rate numeric(18,8),
  ADD COLUMN IF NOT EXISTS ecb_exchange_rate_date date,
  ADD COLUMN IF NOT EXISTS exchange_rate_source text NOT NULL DEFAULT 'SEK',
  ADD COLUMN IF NOT EXISTS exchange_rate_date date,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8),
  ADD COLUMN IF NOT EXISTS exchange_rate_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exchange_rate_override_reason text,
  ADD COLUMN IF NOT EXISTS converted_gross_amount_sek numeric(12,2),
  ADD COLUMN IF NOT EXISTS converted_net_amount_sek numeric(12,2),
  ADD COLUMN IF NOT EXISTS converted_vat_amount_sek numeric(12,2);

DO $$
BEGIN
  ALTER TABLE public.acc_purchases
    ADD CONSTRAINT acc_purchases_exchange_rate_source_chk
    CHECK (exchange_rate_source IN ('SEK', 'ECB', 'MANUAL_OVERRIDE', 'LEGACY_UNCONVERTED'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.acc_purchases
    ADD CONSTRAINT acc_purchases_exchange_rate_positive_chk
    CHECK (exchange_rate IS NULL OR exchange_rate > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.acc_journal_lines
  ADD COLUMN IF NOT EXISTS original_currency text,
  ADD COLUMN IF NOT EXISTS original_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS exchange_rate_source text,
  ADD COLUMN IF NOT EXISTS exchange_rate_date date,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,8),
  ADD COLUMN IF NOT EXISTS exchange_rate_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS converted_amount_sek numeric(12,2);

DO $$
BEGIN
  ALTER TABLE public.acc_journal_lines
    ADD CONSTRAINT acc_journal_lines_exchange_rate_source_chk
    CHECK (exchange_rate_source IS NULL OR exchange_rate_source IN ('SEK', 'ECB', 'MANUAL_OVERRIDE', 'LEGACY_UNCONVERTED'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.acc_journal_lines
    ADD CONSTRAINT acc_journal_lines_exchange_rate_positive_chk
    CHECK (exchange_rate IS NULL OR exchange_rate > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.acc_currency_repair_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL UNIQUE REFERENCES public.acc_purchases(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('draft_can_auto_fix', 'draft_fixed', 'posted_requires_correction', 'correction_proposed', 'reviewed')),
  detected_reason text NOT NULL,
  stored_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposal_snapshot jsonb,
  note text,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acc_currency_repair_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view currency repair cases" ON public.acc_currency_repair_cases;
CREATE POLICY "Staff can view currency repair cases" ON public.acc_currency_repair_cases
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Admins can manage currency repair cases" ON public.acc_currency_repair_cases;
CREATE POLICY "Admins can manage currency repair cases" ON public.acc_currency_repair_cases
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS acc_purchases_foreign_currency_idx
  ON public.acc_purchases (currency, document_date)
  WHERE currency <> 'SEK';

CREATE INDEX IF NOT EXISTS acc_currency_repair_cases_status_idx
  ON public.acc_currency_repair_cases (status, updated_at DESC);

UPDATE public.acc_purchases
SET
  original_currency = COALESCE(original_currency, currency),
  original_gross_amount = COALESCE(original_gross_amount, gross_amount),
  original_net_amount = COALESCE(original_net_amount, net_amount),
  original_vat_amount = COALESCE(original_vat_amount, vat_amount),
  converted_gross_amount_sek = COALESCE(converted_gross_amount_sek, gross_amount),
  converted_net_amount_sek = COALESCE(converted_net_amount_sek, net_amount),
  converted_vat_amount_sek = COALESCE(converted_vat_amount_sek, vat_amount),
  ecb_exchange_rate = COALESCE(ecb_exchange_rate, CASE WHEN currency = 'SEK' THEN 1 ELSE NULL END),
  ecb_exchange_rate_date = COALESCE(ecb_exchange_rate_date, CASE WHEN currency = 'SEK' THEN document_date ELSE NULL END),
  exchange_rate_source = CASE
    WHEN currency = 'SEK' THEN 'SEK'
    WHEN exchange_rate_source = 'SEK' THEN 'LEGACY_UNCONVERTED'
    ELSE exchange_rate_source
  END,
  exchange_rate_date = COALESCE(exchange_rate_date, CASE WHEN currency = 'SEK' THEN document_date ELSE NULL END),
  exchange_rate = COALESCE(exchange_rate, CASE WHEN currency = 'SEK' THEN 1 ELSE NULL END)
WHERE original_currency IS NULL
   OR converted_gross_amount_sek IS NULL
   OR converted_net_amount_sek IS NULL
   OR converted_vat_amount_sek IS NULL
   OR (currency <> 'SEK' AND exchange_rate_source = 'SEK');

UPDATE public.acc_journal_lines jl
SET
  original_currency = COALESCE(jl.original_currency, p.currency),
  exchange_rate_source = COALESCE(jl.exchange_rate_source, CASE WHEN p.currency = 'SEK' THEN 'SEK' ELSE 'LEGACY_UNCONVERTED' END),
  exchange_rate_date = COALESCE(jl.exchange_rate_date, CASE WHEN p.currency = 'SEK' THEN p.document_date ELSE NULL END),
  exchange_rate = COALESCE(jl.exchange_rate, CASE WHEN p.currency = 'SEK' THEN 1 ELSE NULL END),
  converted_amount_sek = COALESCE(jl.converted_amount_sek, GREATEST(jl.debit, jl.credit))
FROM public.acc_verifications v
JOIN public.acc_purchases p
  ON p.id = v.source_id
 AND v.source_type = 'purchase'
WHERE jl.verification_id = v.id
  AND (
    jl.original_currency IS NULL
    OR jl.converted_amount_sek IS NULL
    OR jl.exchange_rate_source IS NULL
  );

CREATE OR REPLACE FUNCTION public.acc_assert_purchase_exchange_override_allowed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF COALESCE(NEW.exchange_rate_overridden, false) OR NEW.exchange_rate_source = 'MANUAL_OVERRIDE' THEN
    IF NOT public.is_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Only admin users may override exchange rates';
    END IF;

    IF NULLIF(BTRIM(COALESCE(NEW.exchange_rate_override_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Manual exchange-rate overrides require a reason';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS acc_purchases_exchange_override_guard ON public.acc_purchases;
CREATE TRIGGER acc_purchases_exchange_override_guard
  BEFORE INSERT OR UPDATE ON public.acc_purchases
  FOR EACH ROW
  EXECUTE FUNCTION public.acc_assert_purchase_exchange_override_allowed();

DROP TRIGGER IF EXISTS acc_currency_repair_cases_updated_at ON public.acc_currency_repair_cases;
CREATE TRIGGER acc_currency_repair_cases_updated_at
  BEFORE UPDATE ON public.acc_currency_repair_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();
