-- What the owner wants, as one number per store: the pool's temperature and
-- the car's range. The planner works out what a degree or a kilometre is worth
-- from these and each plan's own prices, solar and weather, so nothing about
-- money is stored and there are no curves to edit. Replaces the pool and car
-- rows of energy_optimisation_value_curves, which are no longer read.
CREATE TABLE public.energy_optimisation_comfort_targets (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  pool_target_c numeric NOT NULL DEFAULT 30 CHECK (pool_target_c BETWEEN 10 AND 40),
  ev_target_km numeric NOT NULL DEFAULT 300 CHECK (ev_target_km BETWEEN 0 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT energy_comfort_targets_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);

ALTER TABLE public.energy_optimisation_comfort_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own comfort targets"
  ON public.energy_optimisation_comfort_targets FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers write own comfort targets"
  ON public.energy_optimisation_comfort_targets FOR ALL TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id))
  WITH CHECK (public.can_access_energy_billing_customer(customer_id));

-- A home that had set its comfortable level keeps it: the middle point of its
-- three-point curve was exactly that level.
INSERT INTO public.energy_optimisation_comfort_targets (home_id, customer_id, pool_target_c, ev_target_km)
SELECT homes.home_id, homes.customer_id,
  COALESCE(LEAST(40, GREATEST(10, (pool.points -> 1 ->> 'at')::numeric)), 30),
  COALESCE(LEAST(1000, GREATEST(0, (ev.points -> 1 ->> 'at')::numeric)), 300)
FROM (SELECT DISTINCT home_id, customer_id FROM public.energy_optimisation_value_curves) AS homes
LEFT JOIN public.energy_optimisation_value_curves AS pool
  ON pool.home_id = homes.home_id AND pool.store_key = 'pool' AND jsonb_array_length(pool.points) = 3
LEFT JOIN public.energy_optimisation_value_curves AS ev
  ON ev.home_id = homes.home_id AND ev.store_key = 'ev' AND jsonb_array_length(ev.points) = 3
ON CONFLICT (home_id) DO NOTHING;

-- A changed target is worth a new plan, as a changed curve was.
CREATE FUNCTION public.energy_comfort_target_recommendation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE h uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN h := OLD.home_id; ELSE h := NEW.home_id; END IF;
  PERFORM public.recommend_energy_replan(h, 'comfort_targets',
    'A comfort target changed. Replan to apply it to the schedule.', now());
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.energy_comfort_target_recommendation() FROM PUBLIC;
CREATE TRIGGER energy_comfort_target_changed AFTER INSERT OR UPDATE OR DELETE ON public.energy_optimisation_comfort_targets
  FOR EACH ROW EXECUTE FUNCTION public.energy_comfort_target_recommendation();
