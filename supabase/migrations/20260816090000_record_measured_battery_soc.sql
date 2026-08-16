-- Record the measured state of charge alongside the energy that moved.
--
-- The actual slots carried battery charge and discharge energy but never the
-- level those flows produced, so the portal could draw a planned SOC line and
-- nothing behind it. Home Assistant measures both the house battery and the
-- car, and the integration now sends the quarter-hour mean of each.
--
-- Deriving the past from charge and discharge energy was the alternative and
-- was rejected: it would be a second battery model free to drift from the
-- planner's, and it could never be right for the car, whose charge also leaves
-- by being driven where no house meter sees it.
--
-- Fractions rather than percentages, matching every other SOC in the contract
-- (ENERGY_OPTIMISATION_ARCHITECTURE.md §5.4). Existing rows stay NULL: these
-- are measurements, and nothing measured them at the time.

ALTER TABLE public.energy_optimisation_actual_slots
  ADD COLUMN IF NOT EXISTS battery_soc numeric,
  ADD COLUMN IF NOT EXISTS ev_soc numeric;

ALTER TABLE public.energy_optimisation_actual_slots
  DROP CONSTRAINT IF EXISTS energy_optimisation_actual_slots_soc_range;

ALTER TABLE public.energy_optimisation_actual_slots
  ADD CONSTRAINT energy_optimisation_actual_slots_soc_range CHECK (
    (battery_soc IS NULL OR battery_soc BETWEEN 0 AND 1) AND
    (ev_soc IS NULL OR ev_soc BETWEEN 0 AND 1)
  );

COMMENT ON COLUMN public.energy_optimisation_actual_slots.battery_soc IS
  'Measured house battery state of charge for the quarter, 0..1, mean of the recorder''s five-minute means.';
COMMENT ON COLUMN public.energy_optimisation_actual_slots.ev_soc IS
  'Measured vehicle state of charge for the quarter, 0..1. Absent while the car is away from its reporting integration.';
