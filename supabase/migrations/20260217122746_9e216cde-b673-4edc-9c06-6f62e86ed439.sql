
-- Add home_id to home_photos for per-property photo scoping
ALTER TABLE public.home_photos
  ADD COLUMN home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE;

-- Backfill: set home_id from customer's primary_home_id
UPDATE public.home_photos hp
SET home_id = c.primary_home_id
FROM public.customers c
WHERE hp.customer_id = c.id
  AND hp.home_id IS NULL
  AND c.primary_home_id IS NOT NULL;

-- Create index for efficient per-home queries
CREATE INDEX idx_home_photos_home_id ON public.home_photos(home_id);
