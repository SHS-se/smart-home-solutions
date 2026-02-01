-- Drop deprecated text category column from skus table
-- category_id (uuid FK) is now the source of truth
ALTER TABLE public.skus DROP COLUMN IF EXISTS category;

-- Drop deprecated text category column from margin_rules table
-- category_id (uuid FK) is now the source of truth
ALTER TABLE public.margin_rules DROP COLUMN IF EXISTS category;