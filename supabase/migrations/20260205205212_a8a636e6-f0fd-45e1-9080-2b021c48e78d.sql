-- Make quote_number nullable (future quotes won't have one until sent to Stripe)
ALTER TABLE public.quotes ALTER COLUMN quote_number DROP NOT NULL;

-- Set default to null
ALTER TABLE public.quotes ALTER COLUMN quote_number SET DEFAULT NULL;

-- Drop the auto-generation trigger (no longer needed)
DROP TRIGGER IF EXISTS generate_quote_number ON public.quotes;