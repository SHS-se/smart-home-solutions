-- Promotional data belongs in the website bundle, never in customer storage.
-- Remove the short-lived integration demo rows created during beta testing and
-- make the current-plan table reject anything except a live HA plan.
DELETE FROM public.energy_optimisation_plan_runs
WHERE summary #>> '{sources,base_load,quality}' = 'synthetic';

DELETE FROM public.energy_optimisation_current
WHERE snapshot ->> 'mode' IS DISTINCT FROM 'live'
   OR plan ->> 'mode' IS DISTINCT FROM 'live';

ALTER TABLE public.energy_optimisation_current
  ADD CONSTRAINT energy_optimisation_current_live_only
  CHECK (
    snapshot ->> 'mode' = 'live'
    AND plan ->> 'mode' = 'live'
  );
