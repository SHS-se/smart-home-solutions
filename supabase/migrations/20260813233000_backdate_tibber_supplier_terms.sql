-- Supplier terms covering history, so a past quarter can be priced at all.
--
-- The Tibber profile was seeded with a single version valid from 2026-08-13.
-- integration-prices resolves terms per day:
--
--   const version = versions.find(candidate =>
--     candidate.valid_from <= localDate && (!candidate.valid_to || ...));
--   if (!version) throw new Error(`supplier terms missing for ${localDate}`);
--
-- so every date before 2026-08-13 threw, and the function's catch-all turned
-- that into an opaque 502 price_lookup_failed. The grid half was never the
-- problem: the Ellevio catalogue is effective-dated from 2025-01-01 and
-- resolves any date in that range exactly.
--
-- THIS VERSION IS AN ASSUMPTION, NOT A PUBLISHED HISTORICAL RATE. It carries
-- today's terms backwards because Tibber's påslag and rörligt inköpspris change
-- rarely, which makes it a good approximation and not a measurement. The
-- revision name says so, so nobody later mistakes it for sourced data. The
-- spot price it multiplies IS real per-quarter market data, so the error is
-- bounded by the markup — a few öre per kWh, not the price itself.
--
-- Replace it by publishing the real terms through
-- publish_energy_supplier_version(); that shortens this row's validity
-- automatically rather than needing it deleted.
--
-- ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.6.
INSERT INTO public.energy_supplier_versions (
  id,
  profile_id,
  revision,
  valid_from,
  valid_to,
  calculation_model,
  definition,
  source_url
)
SELECT
  '6d159c2f-31a1-4dd3-9f93-000000000024',
  version.profile_id,
  'tibber_se_assumed_from_2025-01-01',
  DATE '2025-01-01',
  -- Ends the day before the published version begins, so the real terms win
  -- for every date they cover.
  version.valid_from - 1,
  version.calculation_model,
  version.definition,
  version.source_url
FROM public.energy_supplier_versions version
WHERE version.revision = 'tibber_se_2026-08-13'
  AND version.valid_from > DATE '2025-01-01'
  AND NOT EXISTS (
    SELECT 1 FROM public.energy_supplier_versions existing
    WHERE existing.profile_id = version.profile_id
      AND existing.revision = 'tibber_se_assumed_from_2025-01-01'
  )
ON CONFLICT (profile_id, valid_from) DO NOTHING;

COMMENT ON COLUMN public.energy_supplier_versions.revision IS
  'Publisher revision. A revision containing "assumed" carries later terms backwards and is an approximation, not a published historical rate.';
