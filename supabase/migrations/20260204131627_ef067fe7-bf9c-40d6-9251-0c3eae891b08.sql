-- Add is_test column to skus table
ALTER TABLE public.skus ADD COLUMN is_test boolean NOT NULL DEFAULT false;

-- Add index for efficient filtering
CREATE INDEX idx_skus_is_test ON public.skus(is_test);