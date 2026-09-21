ALTER TABLE public.energy_optimisation_value_curves
  ADD COLUMN generation_mode text NOT NULL DEFAULT 'custom'
  CHECK (generation_mode IN ('custom', 'price_only', 'balanced')),
  ADD CONSTRAINT energy_value_curve_generation_mode_store
  CHECK (store_key = 'battery' OR generation_mode = 'custom');

CREATE TABLE public.energy_optimisation_battery_cost_curves (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  key text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  input jsonb NOT NULL,
  progress jsonb NOT NULL DEFAULT '{"evaluations":[]}'::jsonb,
  revision bigint NOT NULL DEFAULT 0,
  record jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (home_id, key),
  CONSTRAINT energy_battery_cost_home_customer_consistent
    CHECK (public.energy_home_matches_customer(home_id, customer_id))
);
CREATE INDEX energy_battery_cost_created ON public.energy_optimisation_battery_cost_curves(home_id, created_at);
ALTER TABLE public.energy_optimisation_battery_cost_curves ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Energy subscribers read own battery cost curves"
  ON public.energy_optimisation_battery_cost_curves FOR SELECT TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));
REVOKE ALL ON public.energy_optimisation_battery_cost_curves FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_optimisation_battery_cost_curves TO authenticated;
GRANT ALL ON public.energy_optimisation_battery_cost_curves TO service_role;

-- Frozen source and ready results are invariants even when requests race.
CREATE FUNCTION public.guard_battery_cost_curve_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.home_id IS DISTINCT FROM OLD.home_id OR NEW.key IS DISTINCT FROM OLD.key
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.input IS DISTINCT FROM OLD.input
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.record IS NOT NULL THEN
    RAISE EXCEPTION 'Battery cost curve source and completed selection are immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Battery cost curve revision must advance once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_battery_cost_curve_update BEFORE UPDATE
  ON public.energy_optimisation_battery_cost_curves
  FOR EACH ROW EXECUTE FUNCTION public.guard_battery_cost_curve_update();

-- Keep in-progress jobs and the newest completed selection independently of
-- current-plan overwrites. Embedded selections do not depend on cache rows.
CREATE FUNCTION public.prune_battery_cost_curves() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.energy_optimisation_battery_cost_curves old
  WHERE old.home_id = NEW.home_id AND old.record IS NOT NULL
    AND old.created_at < now() - interval '2 days'
    AND old.key <> (SELECT latest.key FROM public.energy_optimisation_battery_cost_curves latest
      WHERE latest.home_id = NEW.home_id AND latest.record IS NOT NULL
      ORDER BY latest.created_at DESC, latest.key DESC LIMIT 1);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.prune_battery_cost_curves() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER prune_battery_cost_curves AFTER INSERT OR UPDATE
  ON public.energy_optimisation_battery_cost_curves
  FOR EACH ROW EXECUTE FUNCTION public.prune_battery_cost_curves();
