-- Keep morning and afternoon exchanges in distinct hourly activity rows.
-- Existing rows retain their recorded counts and receipt identities.
CREATE OR REPLACE FUNCTION public.record_energy_planning_activity(p_home_id uuid,p_customer_id uuid,p_activity jsonb)
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
        'exchange:'||to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD-HH24'),'exchange','info','received',
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
