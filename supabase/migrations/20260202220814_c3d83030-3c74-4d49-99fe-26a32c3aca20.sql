
-- Step 1: Add 'key' column to sku_categories as machine identifier
ALTER TABLE public.sku_categories
ADD COLUMN IF NOT EXISTS key TEXT UNIQUE;

-- Populate key from existing names (lowercase, underscores)
UPDATE public.sku_categories
SET key = LOWER(REPLACE(name, ' ', '_'))
WHERE key IS NULL;

-- Make key NOT NULL after population
ALTER TABLE public.sku_categories
ALTER COLUMN key SET NOT NULL;

-- Step 2: Drop legacy text-based function overloads
-- Drop the text-based sku_compute_pricing
DROP FUNCTION IF EXISTS public.sku_compute_pricing(
  p_purchase_price numeric,
  p_purchase_includes_vat boolean,
  p_vat_rate numeric,
  p_category text,
  p_margin_override_percent numeric,
  p_rounding_override_sek integer
);

-- Drop the text-based sku_insert_price_history
DROP FUNCTION IF EXISTS public.sku_insert_price_history(
  p_sku_id uuid,
  p_change_reason text,
  p_purchase_price numeric,
  p_purchase_includes_vat boolean,
  p_vat_rate numeric,
  p_cost_ex_vat numeric,
  p_category text,
  p_margin_override_percent numeric,
  p_rounding_override_sek integer,
  p_rule_margin_percent numeric,
  p_rule_rounding_sek integer,
  p_effective_margin_percent numeric,
  p_effective_rounding_sek integer,
  p_sell_price_ex_vat numeric,
  p_sell_price_inc_vat numeric
);

-- Step 3: Make margin_rules.category_id NOT NULL and set as PRIMARY KEY
-- First ensure all rows have category_id set
UPDATE public.margin_rules mr
SET category_id = sc.id
FROM public.sku_categories sc
WHERE mr.category_id IS NULL
  AND LOWER(REPLACE(sc.name, ' ', '_')) = LOWER(REPLACE(mr.description, ' ', '_'));

-- Add primary key constraint on category_id (drop any existing if present)
-- margin_rules should have ONE row per category
ALTER TABLE public.margin_rules
DROP CONSTRAINT IF EXISTS margin_rules_pkey;

ALTER TABLE public.margin_rules
ALTER COLUMN category_id SET NOT NULL;

ALTER TABLE public.margin_rules
ADD CONSTRAINT margin_rules_pkey PRIMARY KEY (category_id);

-- Step 4: Make skus.category_id NOT NULL
ALTER TABLE public.skus
ALTER COLUMN category_id SET NOT NULL;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_skus_category_id ON public.skus(category_id);
CREATE INDEX IF NOT EXISTS idx_sku_price_history_sku_id ON public.sku_price_history(sku_id);

-- Step 5: Add foreign key constraint to skus if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'skus_category_id_fkey'
  ) THEN
    ALTER TABLE public.skus
    ADD CONSTRAINT skus_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES public.sku_categories(id);
  END IF;
END $$;
