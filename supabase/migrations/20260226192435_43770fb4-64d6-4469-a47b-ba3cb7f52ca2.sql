-- Backfill orphaned home_photos to their customer's primary_home_id
UPDATE home_photos hp
SET home_id = c.primary_home_id
FROM customers c
WHERE hp.customer_id = c.id
  AND hp.home_id IS NULL
  AND c.primary_home_id IS NOT NULL;