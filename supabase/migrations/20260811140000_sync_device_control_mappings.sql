-- A website selection is a requested planning role. Home Assistant owns the
-- installation-specific entity mapping and reports whether the matching local
-- mapping is usable. Until that acknowledgement arrives the device remains in
-- empirical base load.

ALTER TABLE public.energy_optimisation_devices
  ADD COLUMN mapping_status text NOT NULL DEFAULT 'not_configured'
    CHECK (mapping_status IN ('not_configured', 'ready', 'invalid')),
  ADD COLUMN mapped_control_type text
    CHECK (mapped_control_type IN (
      'switch_schedule', 'variable_power', 'permit_inhibit', 'setpoint',
      'current_limit'
    )),
  ADD COLUMN mapping_error text
    CHECK (mapping_error IS NULL OR length(mapping_error) BETWEEN 1 AND 1000),
  ADD COLUMN mapping_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(mapping_summary) = 'object'),
  ADD COLUMN mapping_reported_at timestamptz,
  ADD CONSTRAINT energy_optimisation_devices_mapping_consistent
    CHECK (
      (mapping_status = 'not_configured'
        AND mapped_control_type IS NULL
        AND mapping_error IS NULL)
      OR
      (mapping_status = 'ready'
        AND mapped_control_type IS NOT NULL
        AND mapping_error IS NULL)
      OR
      (mapping_status = 'invalid'
        AND mapped_control_type IS NOT NULL
        AND mapping_error IS NOT NULL)
    );

-- Discovery provides suggestions, but a newly discovered appliance is never
-- controllable until the customer explicitly opts it in on the website.
CREATE OR REPLACE FUNCTION public.initialise_energy_device_classifications()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.load_type_override IS NULL THEN
    NEW.load_type_override := NEW.suggested_load_type;
  END IF;

  IF NEW.planning_role_override IS NULL THEN
    NEW.planning_role_override := 'base_load';
    NEW.control_type_override := NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.initialise_energy_device_classifications()
  FROM PUBLIC, anon, authenticated;
