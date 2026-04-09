DROP TRIGGER IF EXISTS acc_currency_repair_cases_updated_at ON public.acc_currency_repair_cases;
DROP POLICY IF EXISTS "Staff can view currency repair cases" ON public.acc_currency_repair_cases;
DROP POLICY IF EXISTS "Admins can manage currency repair cases" ON public.acc_currency_repair_cases;
DROP TABLE IF EXISTS public.acc_currency_repair_cases;

UPDATE public.acc_purchases
SET
  original_currency = COALESCE(original_currency, currency),
  original_gross_amount = COALESCE(original_gross_amount, gross_amount),
  original_net_amount = COALESCE(original_net_amount, net_amount),
  original_vat_amount = COALESCE(original_vat_amount, vat_amount),
  exchange_rate_source = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN 'SEK'
    ELSE exchange_rate_source
  END,
  exchange_rate_date = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(exchange_rate_date, document_date)
    ELSE exchange_rate_date
  END,
  exchange_rate = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(exchange_rate, 1)
    ELSE exchange_rate
  END,
  converted_gross_amount_sek = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(converted_gross_amount_sek, COALESCE(original_gross_amount, gross_amount))
    ELSE converted_gross_amount_sek
  END,
  converted_net_amount_sek = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(converted_net_amount_sek, COALESCE(original_net_amount, net_amount))
    ELSE converted_net_amount_sek
  END,
  converted_vat_amount_sek = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(converted_vat_amount_sek, COALESCE(original_vat_amount, vat_amount))
    ELSE converted_vat_amount_sek
  END,
  gross_amount = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(converted_gross_amount_sek, COALESCE(original_gross_amount, gross_amount), gross_amount)
    ELSE gross_amount
  END,
  net_amount = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(converted_net_amount_sek, COALESCE(original_net_amount, net_amount), net_amount)
    ELSE net_amount
  END,
  vat_amount = CASE
    WHEN COALESCE(original_currency, currency) = 'SEK' THEN COALESCE(converted_vat_amount_sek, COALESCE(original_vat_amount, vat_amount), vat_amount)
    ELSE vat_amount
  END;

UPDATE public.acc_journal_lines jl
SET
  original_currency = COALESCE(original_currency, 'SEK'),
  exchange_rate_source = COALESCE(exchange_rate_source, 'SEK'),
  exchange_rate_date = COALESCE(exchange_rate_date, v.verification_date),
  exchange_rate = COALESCE(exchange_rate, 1),
  converted_amount_sek = COALESCE(converted_amount_sek, GREATEST(jl.debit, jl.credit))
FROM public.acc_verifications v
WHERE jl.verification_id = v.id
  AND (jl.original_currency IS NULL OR jl.exchange_rate IS NULL OR jl.converted_amount_sek IS NULL);
