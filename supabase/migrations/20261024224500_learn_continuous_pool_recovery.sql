-- Old run-age fits reset efficiency at every stop. Refit measured chronology
-- into the continuous source reservoir; retain the electrical startup fit.
UPDATE public.energy_optimisation_pool_model
SET thermal_dynamics = NULL, last_attempted_at = NULL
WHERE thermal_dynamics IS NOT NULL AND thermal_dynamics->>'version' IS DISTINCT FROM '2';

COMMENT ON COLUMN public.energy_optimisation_pool_model.thermal_dynamics IS
  'Version 2 measured water lag and continuous source depletion/recovery, with independently fitted initial memories and observed checkpoints.';
