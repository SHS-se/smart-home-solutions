-- Backfill: create a home for every customer that doesn't have one
INSERT INTO public.homes (customer_id, name)
SELECT c.id, 'My home'
FROM public.customers c
LEFT JOIN public.homes h ON h.customer_id = c.id
WHERE h.id IS NULL;

-- Set primary_home_id for customers that don't have one set
UPDATE public.customers c
SET primary_home_id = (
  SELECT h.id FROM public.homes h
  WHERE h.customer_id = c.id
  ORDER BY h.created_at ASC
  LIMIT 1
)
WHERE c.primary_home_id IS NULL;

-- Backfill home_id on any orphaned home_answers rows
UPDATE public.home_answers ha
SET home_id = (
  SELECT h.id FROM public.homes h
  WHERE h.customer_id = ha.customer_id
  ORDER BY h.created_at ASC
  LIMIT 1
)
WHERE ha.home_id IS NULL;