-- Step 1: Add category_id column to skus table
ALTER TABLE public.skus 
ADD COLUMN category_id uuid REFERENCES public.sku_categories(id);

-- Step 2: Add category_id column to margin_rules table  
ALTER TABLE public.margin_rules
ADD COLUMN category_id uuid REFERENCES public.sku_categories(id);

-- Step 3: Populate skus.category_id by matching category name
UPDATE public.skus s
SET category_id = sc.id
FROM public.sku_categories sc
WHERE s.category = sc.name;

-- Step 4: Populate margin_rules.category_id by matching category name
UPDATE public.margin_rules mr
SET category_id = sc.id
FROM public.sku_categories sc
WHERE mr.category = sc.name;

-- Step 5: Create indexes for the new foreign key columns
CREATE INDEX idx_skus_category_id ON public.skus(category_id);
CREATE INDEX idx_margin_rules_category_id ON public.margin_rules(category_id);

-- Step 6: Add comments explaining the migration state
COMMENT ON COLUMN public.skus.category IS 'DEPRECATED: Use category_id instead. Will be removed after verification.';
COMMENT ON COLUMN public.skus.category_id IS 'Foreign key to sku_categories table - the single source of truth for categories.';
COMMENT ON COLUMN public.margin_rules.category IS 'DEPRECATED: Use category_id instead. Will be removed after verification.';
COMMENT ON COLUMN public.margin_rules.category_id IS 'Foreign key to sku_categories table - the single source of truth for categories.';