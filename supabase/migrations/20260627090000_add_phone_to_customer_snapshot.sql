-- Add the customer phone to the frozen buyer snapshot so issued invoices/quotes
-- can render the customer's phone (alongside the email already captured).
-- Mirrors 20260626170000_snapshot_customer_details_on_documents: same trigger,
-- now also capturing contact_phone, plus a backfill for already-frozen rows.

CREATE OR REPLACE FUNCTION public.freeze_customer_snapshot_on_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only act on the draft -> issued transition, and only if not already frozen.
  IF OLD.status IS DISTINCT FROM 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_snapshot IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT jsonb_build_object(
    'name', c.name,
    'email', c.contact_email,
    'phone', c.contact_phone,
    'street', CASE WHEN c.billing_same_as_site THEN c.site_street ELSE c.billing_street END,
    'postcode', CASE WHEN c.billing_same_as_site THEN c.site_postcode ELSE c.billing_postcode END,
    'city', CASE WHEN c.billing_same_as_site THEN c.site_city ELSE c.billing_city END
  )
  INTO NEW.customer_snapshot
  FROM public.customers_with_identity c
  WHERE c.id = NEW.customer_id;

  RETURN NEW;
END;
$$;

-- Backfill phone onto snapshots frozen before this column existed. The phone was
-- not captured at freeze time, so we use the customer's current phone (best
-- available); name/email/address in the snapshot are left untouched.
UPDATE public.invoices inv
SET customer_snapshot = inv.customer_snapshot || jsonb_build_object('phone', c.contact_phone)
FROM public.customers_with_identity c
WHERE c.id = inv.customer_id
  AND inv.customer_snapshot IS NOT NULL
  AND NOT (inv.customer_snapshot ? 'phone');

UPDATE public.quotes q
SET customer_snapshot = q.customer_snapshot || jsonb_build_object('phone', c.contact_phone)
FROM public.customers_with_identity c
WHERE c.id = q.customer_id
  AND q.customer_snapshot IS NOT NULL
  AND NOT (q.customer_snapshot ? 'phone');
