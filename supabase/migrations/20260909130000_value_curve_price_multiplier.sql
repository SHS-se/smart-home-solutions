alter table public.energy_optimisation_value_curves
  add column urgent_price_multiplier double precision,
  add constraint value_curve_price_multiplier_valid check (
    urgent_price_multiplier >= 0 and urgent_price_multiplier < 'Infinity'::double precision
  ),
  add constraint value_curve_price_mode_exclusive check (
    max_value_sek_per_kwh is null or urgent_price_multiplier is null
  );

-- Existing automatic three-threshold settings use the original 3x policy.
update public.energy_optimisation_value_curves
set urgent_price_multiplier = 3
where max_value_sek_per_kwh is null and jsonb_array_length(points) = 3;
