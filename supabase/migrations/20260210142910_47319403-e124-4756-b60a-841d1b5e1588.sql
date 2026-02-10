
-- Add metadata columns for processed photos
ALTER TABLE public.home_photos
  ADD COLUMN IF NOT EXISTS width integer,
  ADD COLUMN IF NOT EXISTS height integer,
  ADD COLUMN IF NOT EXISTS original_filename text;
