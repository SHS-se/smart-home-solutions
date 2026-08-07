-- A grid calculation can now span a whole month while still missing days: the
-- meter drops out, the integration bills the days it did record, and names the
-- ones it could not. Without this the only signal was is_complete, which the
-- ingest function derived from the coverage span alone -- so an outage in the
-- middle of a finished month was stored as final while its energy totals were
-- short by however long the meter was down.
ALTER TABLE public.energy_tariff_calculations
  ADD COLUMN missing_days jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(missing_days) = 'array');

COMMENT ON COLUMN public.energy_tariff_calculations.missing_days IS
  'ISO dates inside the coverage span with no usable hourly meter data. '
  'Non-empty means the totals under-report and is_complete is false.';
