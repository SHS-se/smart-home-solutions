-- Keep the same two physical reservations. Separate function endpoints prevent
-- the two slots sharing a JavaScript isolate and its accumulated CPU budget.
-- Old bounded roots ignore this additive field and keep calling the primary.
CREATE OR REPLACE FUNCTION public.take_energy_learning_dispatch_work(p_run_fence bigint,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,private,public AS $$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>2 THEN RAISE EXCEPTION 'Invalid dispatch group'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(155367,1) OR NOT pg_try_advisory_xact_lock(155367,2) THEN RETURN NULL; END IF;
 PERFORM 1 FROM private.energy_learning_dispatch WHERE singleton AND run_fence=p_run_fence
   AND run_state='active' AND run_until>clock_timestamp() FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM private.refill_energy_learning_work();
 WITH candidates AS (
   SELECT delivery_id FROM private.energy_learning_tickets WHERE fence IS NULL AND dispatch_fence IS NULL
     AND expires_at>clock_timestamp() ORDER BY slot LIMIT p_limit FOR UPDATE SKIP LOCKED
 ), assigned AS (
   UPDATE private.energy_learning_tickets t SET dispatch_fence=p_run_fence
   FROM candidates c WHERE t.delivery_id=c.delivery_id RETURNING t.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',job_id,'delivery_id',delivery_id,
     'worker_url',(SELECT function_url FROM private.energy_learning_credentials WHERE singleton)||CASE WHEN slot=2 THEN '-peer' ELSE '' END) ORDER BY slot),'[]'::jsonb)
   INTO result FROM assigned;
 RETURN result;
END; $$;
