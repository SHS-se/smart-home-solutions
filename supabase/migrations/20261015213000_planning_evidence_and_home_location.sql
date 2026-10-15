-- Model quality describes the latest attempt independently of usable parameters.
ALTER TABLE public.energy_optimisation_zone_models
  ADD COLUMN last_attempted_at timestamptz,
  ADD COLUMN last_fit_attempt jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE public.energy_optimisation_zone_models SET last_attempted_at = fitted_at;

ALTER TABLE public.energy_optimisation_pool_model
  ADD COLUMN last_attempted_at timestamptz,
  ADD COLUMN last_fit_attempt jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE public.energy_optimisation_pool_model SET last_attempted_at = fitted_at;

-- There is exactly one planner installation address per home. Seed only an
-- unambiguous existing single-home account; never replace an explicit address.
UPDATE public.homes h
SET address_text = concat_ws(', ', nullif(trim(c.site_street), ''),
  nullif(trim(concat_ws(' ', c.site_postcode, c.site_city)), ''))
FROM public.customers c
WHERE c.id = h.customer_id AND nullif(trim(h.address_text), '') IS NULL
  AND nullif(trim(c.site_street), '') IS NOT NULL
  AND (SELECT count(*) FROM public.homes sibling WHERE sibling.customer_id = h.customer_id) = 1;

CREATE TABLE public.energy_home_locations (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  address_text text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  provider text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.energy_home_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read own planner location" ON public.energy_home_locations
  FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id));
REVOKE ALL ON public.energy_home_locations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_home_locations TO authenticated;
GRANT ALL ON public.energy_home_locations TO service_role;

-- Exact room demand and explicit pool permissions accompany retained commands.
CREATE OR REPLACE FUNCTION public.get_energy_replan_state(p_home_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.energy_optimisation_current%ROWTYPE; reference jsonb;
BEGIN
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=p_home_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.plan->>'status'='ready' THEN
    SELECT jsonb_build_object('plan_id',c.plan_id,'hot_water_permissions',c.plan->'hot_water_permissions','slots',COALESCE(jsonb_agg(jsonb_build_object(
      'start',value->'start','pool_w',value->'pool_w','pool_command_w',value->'pool_command_w','pool_permitted',value->'pool_permitted',
      'device_loads_w',value->'device_loads_w','room_heating_w',value->'room_heating_w',
      'ev_target_current_a',value->'ev_target_current_a','ev_min_current_a',value->'ev_min_current_a','ev_max_current_a',value->'ev_max_current_a',
      'boiler_battery_allowed',value->'boiler_battery_allowed','boiler_permitted',value->'boiler_permitted','boiler_expected_w',value->'boiler_expected_w',
      'battery_command',value->'battery_command','device_commands',value->'device_commands') ORDER BY ordinal),'[]'::jsonb))
      INTO reference FROM jsonb_array_elements(c.plan->'plans'->'priority'->'slots') WITH ORDINALITY AS slots(value,ordinal);
  END IF;
  RETURN jsonb_build_object('fixed_plan',c.fixed_plan,'fixed_plan_revision',c.fixed_plan_revision,
    'reference_plan_id',c.plan_id,'published_commands',reference);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_replan_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_replan_state(uuid) TO service_role;
