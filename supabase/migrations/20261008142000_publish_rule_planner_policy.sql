-- The live planner reads a domain policy publication, independently of bench
-- run/results retention. TEST's existing rule editor publishes to this row.
CREATE TABLE public.energy_planner_rule_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(criteria)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.energy_planner_rule_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_planner_rule_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.energy_planner_rule_policy TO service_role;
INSERT INTO public.energy_planner_rule_policy(id) VALUES(true);
CREATE FUNCTION public.publish_bench_rule_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.energy_planner_rule_policy SET criteria=NEW.criteria,updated_at=now() WHERE id=true;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.publish_bench_rule_policy() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF to_regclass('public.bench_rules') IS NOT NULL THEN
    EXECUTE 'UPDATE public.energy_planner_rule_policy SET criteria=(SELECT criteria FROM public.bench_rules WHERE id=true) WHERE id=true';
    EXECUTE 'CREATE TRIGGER publish_live_rule_policy AFTER INSERT OR UPDATE OF criteria ON public.bench_rules FOR EACH ROW EXECUTE FUNCTION public.publish_bench_rule_policy()';
  END IF;
END; $$;
