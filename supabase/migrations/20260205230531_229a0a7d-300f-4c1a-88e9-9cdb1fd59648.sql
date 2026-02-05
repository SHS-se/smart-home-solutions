
-- Migration: BOM/Quote Architectural Separation
-- Step 1: Drop pricing columns from bom_items
ALTER TABLE public.bom_items DROP COLUMN IF EXISTS sell_price;
ALTER TABLE public.bom_items DROP COLUMN IF EXISTS sell_price_ex_vat_at_time;
ALTER TABLE public.bom_items DROP COLUMN IF EXISTS sell_price_inc_vat_at_time;
ALTER TABLE public.bom_items DROP COLUMN IF EXISTS vat_rate_at_time;
ALTER TABLE public.bom_items DROP COLUMN IF EXISTS pricing_source;
ALTER TABLE public.bom_items DROP COLUMN IF EXISTS cost;

-- Step 2: Drop bom_price_revision_id FK from quotes
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_bom_price_revision_id_fkey;
ALTER TABLE public.quotes DROP COLUMN IF EXISTS bom_price_revision_id;

-- Step 3: Drop bom_price_revision_items table (child first)
DROP TABLE IF EXISTS public.bom_price_revision_items;

-- Step 4: Drop bom_price_revisions table
DROP TABLE IF EXISTS public.bom_price_revisions;

-- Step 5: Add source_bom_version to quote_lines for informational context
ALTER TABLE public.quote_lines ADD COLUMN IF NOT EXISTS source_bom_version integer;
