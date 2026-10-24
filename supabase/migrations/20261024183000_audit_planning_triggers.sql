-- Audit is committed with the operation it describes, independent of worker logs,
-- HTTP replies, execution-journal clearing and planning-job retention.
CREATE TABLE public.energy_replan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid,
  job_id uuid,
  snapshot_id uuid,
  reference_plan_id uuid,
  plan_id uuid,
  event text NOT NULL,
  source text NOT NULL,
  forced boolean NOT NULL,
  actor_id uuid,
  reason jsonb NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(home_id,event_key),
  CHECK (public.energy_home_matches_customer(home_id,customer_id))
);
CREATE INDEX energy_replan_events_home_time ON public.energy_replan_events(home_id,sequence DESC);
ALTER TABLE public.energy_replan_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Energy subscribers read own planning audit" ON public.energy_replan_events
  FOR SELECT TO authenticated USING(public.can_access_energy_billing_customer(customer_id));
REVOKE ALL ON public.energy_replan_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.energy_replan_events TO authenticated,service_role;

-- Origin is supplied only by authenticated service endpoints, never copied from
-- an untrusted portal body. Local origin lasts exactly the queue transaction.
DROP FUNCTION public.request_energy_optimisation_replan(uuid);
CREATE FUNCTION public.request_energy_optimisation_replan(p_home_id uuid,p_origin jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.energy_optimisation_current%ROWTYPE; requested uuid;
BEGIN
  IF p_origin->>'source' NOT IN ('portal','integration') OR p_origin->>'source' IS NULL
    OR NULLIF(p_origin->>'reason','') IS NULL THEN
    RAISE EXCEPTION 'Replan origin and reason are required';
  END IF;
  SELECT * INTO c FROM public.energy_optimisation_current WHERE home_id=p_home_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No energy snapshot for this home'; END IF;
  IF c.replan_request_id IS NOT NULL AND c.replan_request_id IS DISTINCT FROM c.replan_completed_request_id
    AND c.replan_error IS NULL THEN RETURN c.replan_request_id; END IF;
  requested:=gen_random_uuid();
  PERFORM set_config('shs.replan_origin',p_origin::text,true);
  UPDATE public.energy_optimisation_current SET replan_request_id=requested,
    replan_requested_at=now(),replan_error=NULL WHERE home_id=p_home_id;
  PERFORM set_config('shs.replan_origin','',true);
  RETURN requested;
END; $$;
REVOKE ALL ON FUNCTION public.request_energy_optimisation_replan(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_energy_optimisation_replan(uuid,jsonb) TO service_role;

CREATE FUNCTION private.audit_energy_replan_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE origin jsonb; e public.energy_replan_events%ROWTYPE;
BEGIN
  IF NEW.replan_request_id IS NOT NULL AND NEW.replan_request_id IS DISTINCT FROM OLD.replan_request_id THEN
    origin:=NULLIF(current_setting('shs.replan_origin',true),'')::jsonb;
    IF origin IS NULL THEN
      origin:=jsonb_build_object('source',CASE WHEN NEW.fixed_plan_revision IS DISTINCT FROM OLD.fixed_plan_revision
        THEN 'fixed_schedule' ELSE 'database' END,'reason',CASE WHEN NEW.fixed_plan_revision IS DISTINCT FROM OLD.fixed_plan_revision
        THEN 'fixed_schedule_changed' ELSE 'unattributed_database_request' END);
    END IF;
    INSERT INTO public.energy_replan_events(home_id,customer_id,event_key,request_id,reference_plan_id,event,source,forced,actor_id,reason)
      VALUES(NEW.home_id,NEW.customer_id,NEW.replan_request_id||':requested',NEW.replan_request_id,OLD.plan_id,
        'requested',origin->>'source',true,(origin->>'actor_id')::uuid,origin);
  END IF;
  IF NEW.replan_error IS NOT NULL AND NEW.replan_error IS DISTINCT FROM OLD.replan_error THEN
    SELECT * INTO e FROM public.energy_replan_events WHERE home_id=NEW.home_id
      AND request_id=NEW.replan_request_id AND event='requested';
    IF FOUND THEN
      INSERT INTO public.energy_replan_events(home_id,customer_id,event_key,request_id,reference_plan_id,event,source,forced,actor_id,reason,details)
        VALUES(e.home_id,e.customer_id,e.request_id||':request_failed:'||md5(NEW.replan_error),e.request_id,e.reference_plan_id,
          'request_failed',e.source,true,e.actor_id,e.reason,jsonb_build_object('detail',NEW.replan_error)) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  IF NEW.ha_ack_status IN ('accepted','rejected') AND (NEW.ha_ack_status IS DISTINCT FROM OLD.ha_ack_status OR NEW.plan_id IS DISTINCT FROM OLD.plan_id) THEN
    SELECT * INTO e FROM public.energy_replan_events WHERE home_id=NEW.home_id AND plan_id=NEW.plan_id
      AND event='published' ORDER BY sequence DESC LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.energy_replan_events(home_id,customer_id,event_key,request_id,job_id,snapshot_id,reference_plan_id,plan_id,event,source,forced,actor_id,reason,details)
        VALUES(e.home_id,e.customer_id,e.job_id||':ack:'||NEW.ha_ack_status,e.request_id,e.job_id,e.snapshot_id,e.reference_plan_id,e.plan_id,
          NEW.ha_ack_status,e.source,e.forced,e.actor_id,e.reason,jsonb_build_object('ack_request_id',NEW.ha_ack_request_id,'error',NEW.ha_ack_error)) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER audit_energy_replan_request AFTER UPDATE OF replan_request_id,replan_error,ha_ack_status
  ON public.energy_optimisation_current FOR EACH ROW EXECUTE FUNCTION private.audit_energy_replan_request();

CREATE FUNCTION private.freeze_energy_planning_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE provenance jsonb; e public.energy_replan_events%ROWTYPE;
BEGIN
  IF NEW.context->'execution_replan'->>'request_id' IS NOT NULL THEN
    provenance:=jsonb_build_object('source','execution','forced',true,'reason',NEW.context->'execution_replan');
  ELSIF NEW.context->>'replan_request_id' IS NOT NULL THEN
    SELECT * INTO e FROM public.energy_replan_events WHERE home_id=NEW.home_id
      AND request_id=(NEW.context->>'replan_request_id')::uuid AND event='requested';
    IF FOUND THEN provenance:=jsonb_build_object('source',e.source,'forced',true,'actor_id',e.actor_id,'reason',e.reason);
    ELSE provenance:=jsonb_build_object('source','unknown','forced',true,'reason',jsonb_build_object('code','request_predates_audit')); END IF;
  ELSE
    provenance:=(NEW.context->'planning_trigger')::jsonb;
    IF provenance IS NULL OR provenance->>'source' IS NULL OR provenance->>'source' NOT IN ('initial_plan','price_release') THEN
      RAISE EXCEPTION 'Planning admission requires an explicit audit reason';
    END IF;
  END IF;
  NEW.context:=(NEW.context::jsonb||jsonb_build_object('planning_trigger',provenance))::json;
  RETURN NEW;
END; $$;
CREATE TRIGGER freeze_energy_planning_trigger BEFORE INSERT ON private.energy_planning_jobs
  FOR EACH ROW EXECUTE FUNCTION private.freeze_energy_planning_trigger();

-- Pending jobs already on disk must still be able to finish. Preserve known
-- execution evidence and label historical attribution honestly; do not invent it.
UPDATE private.energy_planning_jobs SET context=(context::jsonb||jsonb_build_object('planning_trigger',
  CASE WHEN context->'execution_replan'->>'request_id' IS NOT NULL THEN
    jsonb_build_object('source','execution','forced',true,'reason',context->'execution_replan')
  ELSE jsonb_build_object('source','unknown','forced',context->>'replan_request_id' IS NOT NULL,
    'reason',jsonb_build_object('code','job_predates_audit')) END))::json
  WHERE context->'planning_trigger' IS NULL;

CREATE FUNCTION private.audit_energy_planning_job()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE p jsonb:=NEW.context->'planning_trigger'; stage text;
BEGIN
  IF TG_OP='INSERT' THEN stage:='admitted';
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN stage:=NEW.state;
  ELSIF NEW.fence IS DISTINCT FROM OLD.fence THEN stage:='solving';
  ELSE RETURN NEW; END IF;
  INSERT INTO public.energy_replan_events(home_id,customer_id,event_key,request_id,job_id,snapshot_id,reference_plan_id,plan_id,event,source,forced,actor_id,reason,details)
    VALUES(NEW.home_id,NEW.customer_id,NEW.id||':'||stage||':'||NEW.fence,
      COALESCE(NEW.context->'execution_replan'->>'request_id',NEW.context->>'replan_request_id')::uuid,
      NEW.id,NEW.snapshot_id,(NEW.context->>'reference_plan_id')::uuid,NEW.plan_id,stage,p->>'source',(p->>'forced')::boolean,
      (p->>'actor_id')::uuid,p->'reason',jsonb_build_object('fence',NEW.fence,'code',NEW.code,'detail',NEW.detail,
        'exchange_request_id',NEW.context->>'request_id','integration_version',NEW.context->>'integration_version',
        'completion_basis',NEW.context->>'completion_basis')) ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER audit_energy_planning_job AFTER INSERT OR UPDATE OF state,fence ON private.energy_planning_jobs
  FOR EACH ROW EXECUTE FUNCTION private.audit_energy_planning_job();
