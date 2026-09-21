-- OLD is a built-in PL/pgSQL trigger record, so it cannot also qualify the
-- deletion target. Replace the deployed function without changing its trigger.
CREATE OR REPLACE FUNCTION public.prune_battery_cost_curves() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.energy_optimisation_battery_cost_curves AS expired_curve
  WHERE expired_curve.home_id = NEW.home_id AND expired_curve.record IS NOT NULL
    AND expired_curve.created_at < now() - interval '2 days'
    AND expired_curve.key <> (SELECT latest.key FROM public.energy_optimisation_battery_cost_curves latest
      WHERE latest.home_id = NEW.home_id AND latest.record IS NOT NULL
      ORDER BY latest.created_at DESC, latest.key DESC LIMIT 1);
  RETURN NEW;
END;
$$;
