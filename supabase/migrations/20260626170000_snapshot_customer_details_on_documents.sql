-- Freeze the customer (buyer) details onto invoices and quotes when they leave
-- draft, so an issued document never changes if the customer's name/address is
-- later edited. Complements invoices.business_snapshot (the seller side): once a
-- document is out of draft, both buyer and seller details are frozen.
--
-- Seller details on quotes are still hard-coded in the quote renderer (not yet
-- settings-driven), so only the customer side needs freezing there. Quote line
-- items/prices are already stored per row (quote_lines), so they are frozen too.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS customer_snapshot jsonb;
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS customer_snapshot jsonb;

COMMENT ON COLUMN public.invoices.customer_snapshot IS
  'Frozen buyer details (name, email, billing address) captured when the invoice left draft. Source of truth for the customer block; NULL only for drafts and legacy rows (which fall back to live customer data).';
COMMENT ON COLUMN public.quotes.customer_snapshot IS
  'Frozen buyer details captured when the quote left draft (e.g. was sent). NULL only for drafts and legacy rows (which fall back to live customer data).';

-- Shared BEFORE UPDATE trigger: the first time a document transitions out of
-- 'draft', capture the resolved customer details. Runs for any draft-exit path
-- (invoice finalize, quote send, etc.) and never overwrites an existing snapshot,
-- so re-sends / status changes after issuance leave the frozen copy intact.
-- Only references columns common to both tables (status, customer_id,
-- customer_snapshot), so one function serves invoices and quotes.
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

DROP TRIGGER IF EXISTS freeze_customer_snapshot ON public.invoices;
CREATE TRIGGER freeze_customer_snapshot
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_customer_snapshot_on_issue();

DROP TRIGGER IF EXISTS freeze_customer_snapshot ON public.quotes;
CREATE TRIGGER freeze_customer_snapshot
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_customer_snapshot_on_issue();

-- Backfill already-issued (non-draft) documents at their current customer
-- details so future edits to the customer cannot change them.
UPDATE public.invoices inv
SET customer_snapshot = jsonb_build_object(
  'name', c.name,
  'email', c.contact_email,
  'street', CASE WHEN c.billing_same_as_site THEN c.site_street ELSE c.billing_street END,
  'postcode', CASE WHEN c.billing_same_as_site THEN c.site_postcode ELSE c.billing_postcode END,
  'city', CASE WHEN c.billing_same_as_site THEN c.site_city ELSE c.billing_city END
)
FROM public.customers_with_identity c
WHERE c.id = inv.customer_id
  AND inv.status IS DISTINCT FROM 'draft'
  AND inv.customer_snapshot IS NULL;

UPDATE public.quotes q
SET customer_snapshot = jsonb_build_object(
  'name', c.name,
  'email', c.contact_email,
  'street', CASE WHEN c.billing_same_as_site THEN c.site_street ELSE c.billing_street END,
  'postcode', CASE WHEN c.billing_same_as_site THEN c.site_postcode ELSE c.billing_postcode END,
  'city', CASE WHEN c.billing_same_as_site THEN c.site_city ELSE c.billing_city END
)
FROM public.customers_with_identity c
WHERE c.id = q.customer_id
  AND q.status IS DISTINCT FROM 'draft'
  AND q.customer_snapshot IS NULL;
