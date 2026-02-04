-- Backfill existing quotes that were sent but don't have stripe_status
UPDATE quotes 
SET stripe_status = 'open' 
WHERE status = 'sent' 
  AND stripe_quote_id IS NOT NULL 
  AND stripe_status IS NULL;

-- Add constraint to enforce valid Stripe quote statuses
ALTER TABLE quotes 
ADD CONSTRAINT quotes_stripe_status_check 
CHECK (stripe_status IS NULL OR stripe_status IN ('draft', 'open', 'accepted', 'canceled'));