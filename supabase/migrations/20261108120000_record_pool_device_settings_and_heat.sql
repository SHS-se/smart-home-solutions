-- Each pool device quarter can carry the device's own power setting (a heat
-- pump's output, a pump's capacity) when it held one value throughout, and the
-- heat its meter recorded. Both are read in Home Assistant, never written by
-- SHS. Null means not observed: no setting mapped, a quarter in which it
-- changed, an unavailable entity, or no heat meter. The pool refit learns draw
-- and efficiency per setting from these quarters.
ALTER TABLE public.energy_optimisation_device_slots
  ADD COLUMN power_setting double precision,
  ADD COLUMN heat_kwh numeric CHECK (heat_kwh BETWEEN 0 AND 100);

COMMENT ON COLUMN public.energy_optimisation_device_slots.power_setting IS
  'The device''s own power setting held throughout the quarter; null when not observed.';
COMMENT ON COLUMN public.energy_optimisation_device_slots.heat_kwh IS
  'Heat the device''s heat meter recorded in the quarter, kWh; null when not metered.';
