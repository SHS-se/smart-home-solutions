-- Add structured address fields for Swedish addresses
-- Site/installation address (always used)
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS site_street text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS site_postcode text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS site_city text;

-- Billing address (only used when different from site)
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS billing_street text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS billing_postcode text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS billing_city text;

-- Flag to indicate if billing address is same as site address (defaults to true)
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS billing_same_as_site boolean DEFAULT true;

-- Migrate existing data from old fields
-- site_address goes to site_street (as it was freeform)
UPDATE public.customers 
SET site_street = site_address 
WHERE site_address IS NOT NULL AND site_street IS NULL;

-- address goes to billing_street (as it was freeform)
UPDATE public.customers 
SET billing_street = address 
WHERE address IS NOT NULL AND billing_street IS NULL;

-- If billing address was set, assume it was intentionally different
UPDATE public.customers
SET billing_same_as_site = false
WHERE billing_street IS NOT NULL AND billing_street != '';

-- Drop old columns after migration
ALTER TABLE public.customers DROP COLUMN IF EXISTS address;
ALTER TABLE public.customers DROP COLUMN IF EXISTS site_address;