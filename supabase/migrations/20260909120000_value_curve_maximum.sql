alter table public.energy_optimisation_value_curves
  add column max_value_sek_per_kwh double precision
  check (max_value_sek_per_kwh >= 0 and max_value_sek_per_kwh < 'Infinity'::double precision);
