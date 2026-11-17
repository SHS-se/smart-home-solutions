-- The Device Model tab reads the selected device's published fit.
-- The existing customer access policy still applies to every row.
GRANT SELECT (home_id, device_key, operating_points)
  ON public.energy_optimisation_device_operating_points TO authenticated;
