-- Sync invoice quote-number snapshots after quote renumbering.

UPDATE public.invoices i
SET quote_number = q.quote_number
FROM public.quotes q
WHERE i.quote_id = q.id
  AND q.quote_number IS NOT NULL
  AND i.quote_number IS DISTINCT FROM q.quote_number;

UPDATE public.invoices
SET quote_number = CASE
  WHEN quote_number LIKE 'Q-%' THEN 'Q-' || LPAD(SUBSTRING(quote_number FROM 3)::integer::text, 6, '0')
  WHEN quote_number LIKE 'TQ-%' THEN 'TQ-' || LPAD(SUBSTRING(quote_number FROM 4)::integer::text, 6, '0')
  ELSE quote_number
END
WHERE quote_id IS NULL
  AND quote_number ~ '^(Q|TQ)-\d+$';

UPDATE public.billing_events be
SET metadata = jsonb_set(COALESCE(be.metadata, '{}'::jsonb), '{quote_number}', to_jsonb(q.quote_number))
FROM public.quotes q
WHERE be.quote_id = q.id
  AND q.quote_number IS NOT NULL
  AND be.metadata ? 'quote_number'
  AND be.metadata->>'quote_number' IS DISTINCT FROM q.quote_number;

UPDATE public.invoice_events ie
SET metadata = jsonb_set(COALESCE(ie.metadata, '{}'::jsonb), '{quote_number}', to_jsonb(q.quote_number))
FROM public.invoices i
JOIN public.quotes q ON q.id = i.quote_id
WHERE ie.invoice_id = i.id
  AND q.quote_number IS NOT NULL
  AND ie.metadata ? 'quote_number'
  AND ie.metadata->>'quote_number' IS DISTINCT FROM q.quote_number;
