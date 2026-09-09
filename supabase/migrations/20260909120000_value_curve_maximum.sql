-- Some installations already have the column without this migration recorded.
-- Preserve their values, and enforce the same constraint on both upgrade paths.
alter table public.energy_optimisation_value_curves
  add column if not exists max_value_sek_per_kwh double precision;

alter table public.energy_optimisation_value_curves
  drop constraint if exists energy_optimisation_value_curves_max_value_sek_per_kwh_check,
  add constraint energy_optimisation_value_curves_max_value_sek_per_kwh_check
    check (max_value_sek_per_kwh >= 0 and max_value_sek_per_kwh < 'Infinity'::double precision);
