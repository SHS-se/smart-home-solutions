-- Plan and exact conditional economics are installed by the same row upsert.
ALTER TABLE public.energy_optimisation_current
  ADD COLUMN battery_projection jsonb;
COMMENT ON COLUMN public.energy_optimisation_current.battery_projection IS
  'Selected resolved conditional battery economics; never actuator authority. Null requires a fresh generation.';
