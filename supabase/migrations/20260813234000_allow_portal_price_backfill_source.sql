-- A third writer of quarter prices: the portal's own backfill.
--
-- 'integration' and 'snapshot' both mean Home Assistant computed the figure.
-- 'portal_backfill' means backfill-energy-prices did, from the same published
-- spot data and the same effective-dated tariffs, using the TypeScript port of
-- the integration's price calculation. Recording which one wrote a row matters:
-- the port is checked against the Python by a shared fixture, but if that check
-- ever fails, this column is how you find the affected quarters.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.6.
ALTER TABLE public.energy_optimisation_price_slots
  DROP CONSTRAINT energy_optimisation_price_slots_source_check;

ALTER TABLE public.energy_optimisation_price_slots
  ADD CONSTRAINT energy_optimisation_price_slots_source_check
  CHECK (source IN ('integration', 'snapshot', 'portal_backfill'));
