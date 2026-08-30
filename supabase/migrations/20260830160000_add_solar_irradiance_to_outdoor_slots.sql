-- Solar irradiance alongside outdoor temperature, per completed quarter.
--
-- The 1R1C zone fit currently has one constant, `background_gain_c_per_h`, to
-- stand for every watt of heat a room receives that no heater delivered:
-- sunshine, cooking, lighting, occupants. A constant cannot tell a bright
-- Sunday from an overcast one, so it under-predicts the bright day and
-- over-predicts the dull one by the same amount — and in a house with real
-- glazing the sun is the largest term it is being asked to hide.
--
-- Separating it needs irradiance as a series, joined to the same quarters the
-- zone observations already use. It belongs on the outdoor table for the same
-- reason temperature does: a home has one sky, whatever its rooms are doing.
--
-- Nullable, and it will stay nullable. Rows written before this column existed
-- have no irradiance and never will, homes whose coordinates are unknown
-- cannot have any, and the provider's own reanalysis does not cover its oldest
-- days. The fit reads it as evidence where it exists rather than a
-- precondition, so a quarter without it is still a quarter worth training on.

ALTER TABLE public.energy_optimisation_outdoor_slots
  ADD COLUMN solar_w_per_m2 numeric
    CHECK (solar_w_per_m2 IS NULL OR solar_w_per_m2 BETWEEN 0 AND 1500);

COMMENT ON COLUMN public.energy_optimisation_outdoor_slots.solar_w_per_m2 IS
  'Global horizontal irradiance, W/m2, mean over the quarter. Weather as it '
  'fell on the site, before any array orientation, shading or inverter '
  'derating — a wall gains heat from the sky, not from a PV forecast.';
