-- Learn continuous water-reading response, separately from electrical startup.
-- No home-specific coefficients, runtime rule or startup delay is seeded.
ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN thermal_dynamics jsonb
  CHECK (thermal_dynamics IS NULL OR jsonb_typeof(thermal_dynamics) = 'object');

COMMENT ON COLUMN public.energy_optimisation_pool_model.thermal_dynamics IS
  'Learned first-order response to compressor electricity: heat gain, standing '
  'cooling, response time, fit evidence and calibration response checkpoint. '
  'Current pending contribution is reconstructed from metered history at capture.';

UPDATE public.energy_optimisation_pool_model SET last_attempted_at = 'epoch';
