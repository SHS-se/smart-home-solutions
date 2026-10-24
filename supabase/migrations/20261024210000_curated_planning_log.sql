-- Readable 72-hour activity is a projection of the durable planning audit.
-- A run occupies one row; heartbeats and solver phases never create a feed.
CREATE TABLE public.energy_planning_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK(kind IN ('planning','warning','exchange')),
  severity text NOT NULL CHECK(severity IN ('info','warning','error')),
  state text NOT NULL,
  reason jsonb NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences bigint NOT NULL DEFAULT 1,
  UNIQUE(home_id,event_key),
  CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
CREATE INDEX energy_planning_log_home_sequence ON public.energy_planning_log(home_id,sequence DESC);
CREATE INDEX energy_planning_log_retention ON public.energy_planning_log(occurred_at);
ALTER TABLE public.energy_planning_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Subscribers read recent planning activity" ON public.energy_planning_log FOR SELECT TO authenticated
  USING(public.can_access_energy_billing_customer(customer_id) AND occurred_at >= now()-interval '72 hours');
REVOKE ALL ON public.energy_planning_log FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.energy_planning_log TO authenticated,service_role;

CREATE FUNCTION private.merge_planning_log_counts(a jsonb,b jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM (
    SELECT key,sum(value::bigint) value FROM (
      SELECT * FROM jsonb_each_text(COALESCE(a,'{}'::jsonb))
      UNION ALL SELECT * FROM jsonb_each_text(COALESCE(b,'{}'::jsonb))
    ) counts GROUP BY key
  ) totals;
$$;

CREATE FUNCTION private.write_planning_log(p_home uuid,p_customer uuid,p_key text,p_kind text,p_severity text,
  p_state text,p_reason jsonb,p_details jsonb,p_receipt text,p_at timestamptz DEFAULT clock_timestamp())
RETURNS void LANGUAGE sql SET search_path=public,private AS $$
  -- A long-running job can finish after its original readable entry expired.
  -- Start a fresh recent entry for that outcome, with a fresh paging sequence.
  DELETE FROM public.energy_planning_log WHERE home_id=p_home AND event_key=p_key
    AND occurred_at < p_at-interval '72 hours';
  INSERT INTO public.energy_planning_log AS l(home_id,customer_id,event_key,occurred_at,last_seen_at,kind,severity,state,reason,details)
    VALUES(p_home,p_customer,p_key,p_at,p_at,p_kind,p_severity,p_state,p_reason,
      p_details||jsonb_build_object('receipt_ids',jsonb_build_array(p_receipt)))
  ON CONFLICT(home_id,event_key) DO UPDATE SET
    last_seen_at=GREATEST(l.last_seen_at,excluded.last_seen_at),state=excluded.state,reason=excluded.reason,
    severity=CASE WHEN l.kind='warning' AND l.severity='error' THEN 'error' ELSE excluded.severity END,
    occurrences=l.occurrences+1,
    details=l.details||excluded.details||jsonb_build_object(
      'receipt_ids',(l.details->'receipt_ids')||(excluded.details->'receipt_ids'),
      'counts',private.merge_planning_log_counts(l.details->'counts',excluded.details->'counts'))
  WHERE NOT(l.details->'receipt_ids' ? p_receipt);
$$;

CREATE FUNCTION private.project_energy_planning_event(e public.energy_replan_events)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE extra jsonb; run_summary jsonb;
BEGIN
  SELECT summary INTO run_summary FROM public.energy_optimisation_plan_runs WHERE id=e.plan_id;
  extra:=e.details||jsonb_build_object('job_id',e.job_id,'plan_id',e.plan_id,'source',e.source,
    'calculation_ms',run_summary->'calculation_ms');
  PERFORM private.write_planning_log(e.home_id,e.customer_id,
    CASE WHEN e.request_id IS NOT NULL THEN 'request:'||e.request_id ELSE 'job:'||e.job_id END,
    'planning',CASE WHEN e.event IN ('failed','request_failed','rejected') THEN 'error' ELSE 'info' END,
    e.event,e.reason,extra,e.id::text,e.occurred_at);
END; $$;
CREATE FUNCTION private.project_energy_planning_log()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
  PERFORM private.project_energy_planning_event(NEW);
  RETURN NEW;
END; $$;
CREATE TRIGGER project_energy_planning_log AFTER INSERT ON public.energy_replan_events
  FOR EACH ROW EXECUTE FUNCTION private.project_energy_planning_log();

-- Replay only the requested readable window, preserving original receipt order.
DO $$ DECLARE e public.energy_replan_events%ROWTYPE;
BEGIN
  FOR e IN SELECT * FROM public.energy_replan_events WHERE occurred_at>=now()-interval '72 hours' ORDER BY sequence LOOP
    PERFORM private.project_energy_planning_event(e);
  END LOOP;
END; $$;

-- Called for completed uploads and actionable warnings, never for status polls.
CREATE FUNCTION public.record_energy_planning_activity(p_home_id uuid,p_customer_id uuid,p_activity jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE receipt text:=p_activity->>'receipt_id'; counts jsonb:=p_activity->'counts'; w jsonb;
  at_time timestamptz:=clock_timestamp();
BEGIN
  IF NULLIF(receipt,'') IS NULL OR (p_activity->>'source' IS NULL OR p_activity->>'source' NOT IN ('home_assistant','planner')) THEN
    RAISE EXCEPTION 'Planning activity requires source and receipt identity';
  END IF;
  IF counts IS NOT NULL THEN
    IF jsonb_typeof(counts)<>'object' OR EXISTS(SELECT 1 FROM jsonb_each_text(counts) WHERE value!~'^[0-9]+$') THEN
      RAISE EXCEPTION 'Transfer counts require nonnegative integers';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each_text(counts) WHERE value::bigint>0) THEN
      PERFORM private.write_planning_log(p_home_id,p_customer_id,
        'exchange:'||to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD-HH'),'exchange','info','received',
        jsonb_build_object('code','ha_data_received'),jsonb_build_object('counts',counts),receipt,at_time);
    END IF;
  END IF;
  FOR w IN SELECT value FROM jsonb_array_elements(COALESCE(p_activity->'warnings','[]'::jsonb)) LOOP
    IF NULLIF(w->>'code','') IS NULL OR NULLIF(w->>'scope','') IS NULL OR NULLIF(w->>'message','') IS NULL
      OR w->>'severity' NOT IN ('warning','error') THEN RAISE EXCEPTION 'Invalid planning warning'; END IF;
    PERFORM private.write_planning_log(p_home_id,p_customer_id,
      'warning:'||to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD')||':'||(w->>'scope')||':'||(w->>'code')||':'||COALESCE(w->>'entity_id',''),
      'warning',w->>'severity','observed',w,
      jsonb_build_object('source',p_activity->>'source'),receipt,at_time);
  END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.record_energy_planning_activity(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_energy_planning_activity(uuid,uuid,jsonb) TO service_role;

-- HA reports arrive frequently. Record changed problems, not healthy heartbeats.
CREATE FUNCTION private.log_energy_runtime_problem()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE message text; code text; at_time timestamptz:=clock_timestamp();
BEGIN
  IF NEW.ha_runtime->>'last_error' IS DISTINCT FROM OLD.ha_runtime->>'last_error'
    OR NEW.ha_runtime->>'state' IS DISTINCT FROM OLD.ha_runtime->>'state' THEN
    message:=NULLIF(NEW.ha_runtime->>'last_error','');
    IF message IS NOT NULL OR NEW.ha_runtime->>'state' IN ('unavailable','expired','invalid','incomplete','infeasible') THEN
      code:='ha_runtime_'||(NEW.ha_runtime->>'state')||':'||md5(regexp_replace(
        COALESCE(message,NEW.ha_runtime->>'reason'),'\s*\[request_id=[^]]+\]','','g'));
      PERFORM private.write_planning_log(NEW.home_id,NEW.customer_id,
        'warning:'||to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD')||':'||code,
        'warning','error','observed',jsonb_build_object('code',code,'scope','home_assistant',
          'message',COALESCE(message,NEW.ha_runtime->>'reason'),'severity','error'),
        jsonb_build_object('source','home_assistant'),gen_random_uuid()::text,at_time);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER log_energy_runtime_problem AFTER UPDATE OF ha_runtime ON public.energy_optimisation_current
  FOR EACH ROW EXECUTE FUNCTION private.log_energy_runtime_problem();

CREATE FUNCTION private.prune_energy_planning_log()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  DELETE FROM public.energy_planning_log WHERE id IN (
    SELECT id FROM public.energy_planning_log WHERE occurred_at < now()-interval '72 hours'
    ORDER BY occurred_at LIMIT 5000 FOR UPDATE SKIP LOCKED
  );
$$;
SELECT cron.schedule('prune-energy-planning-log','*/5 * * * *','SELECT private.prune_energy_planning_log()');
