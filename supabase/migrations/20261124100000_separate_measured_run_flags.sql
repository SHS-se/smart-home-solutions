-- Judge a run's heating and cooling points separately, each against its own
-- published line. Accepted ledgers in the earlier shape remain valid until the
-- next fit replaces them; no stored model or ledger is rewritten here.
CREATE OR REPLACE FUNCTION private.validate_measured_room_ledger(ledger jsonb,support jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n integer; run jsonb; point jsonb; line jsonb; key text; kind text; value jsonb; separate boolean;
BEGIN
 IF jsonb_typeof(ledger) IS DISTINCT FROM 'object' OR ledger->>'policy' IS DISTINCT FROM 'measured_room_runs_v1'
   OR jsonb_typeof(ledger->'runs') IS DISTINCT FROM 'array' OR jsonb_typeof(support) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Invalid measured room ledger'; END IF;
 n:=jsonb_array_length(ledger->'runs');
 -- Heating and cooling points are flagged separately. Ledgers published before
 -- that split carry one run-level disposition until the next fit replaces them.
 separate:=support ? 'heating_flagged_runs';
 FOREACH key IN ARRAY ARRAY['fitted_observations','residual_degrees_of_freedom','observed_runs','heating_runs','cooling_runs','unmeasured_runs']
   ||CASE WHEN separate THEN ARRAY['heating_flagged_runs','cooling_flagged_runs'] ELSE ARRAY['flagged_runs'] END LOOP
   value:=support->key;
   IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR (value::text)::numeric<0
     OR trunc((value::text)::numeric)<>(value::text)::numeric THEN RAISE EXCEPTION 'Invalid measured room count: %',key; END IF;
 END LOOP;
 IF jsonb_typeof(ledger->'observed_runs') IS DISTINCT FROM 'number'
   OR (ledger->>'observed_runs')::numeric<>n OR (support->>'observed_runs')::numeric<>n
   OR n<>(SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(ledger->'runs') r)
   OR (support->>'heating_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r WHERE jsonb_typeof(r->'heating')='object')
   OR (support->>'cooling_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r WHERE jsonb_typeof(r->'cooling')='object')
   OR separate AND (
     (support->>'heating_flagged_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r WHERE r->>'heating_status' IN ('above_line','below_line'))
     OR (support->>'cooling_flagged_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r WHERE r->>'cooling_status' IN ('above_line','below_line'))
     OR (support->>'unmeasured_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r
       WHERE jsonb_typeof(r->'heating')='null' AND jsonb_typeof(r->'cooling')='null'))
   OR NOT separate AND (
     (support->>'flagged_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r WHERE r->>'disposition' IN ('above_line','below_line'))
     OR (support->>'unmeasured_runs')::numeric<>(SELECT count(*) FROM jsonb_array_elements(ledger->'runs') r WHERE r->>'disposition'='unmeasured'))
 THEN RAISE EXCEPTION 'Invalid measured room population'; END IF;
 FOR run IN SELECT r FROM jsonb_array_elements(ledger->'runs') r LOOP
   IF jsonb_typeof(run->'id') IS DISTINCT FROM 'string' OR run->>'id'=''
     OR NOT separate AND coalesce(run->>'disposition','') NOT IN ('consistent','above_line','below_line','unmeasured')
     OR separate AND (run ? 'disposition'
       OR coalesce(jsonb_typeof(run->'heating_status'),'missing')='missing' OR coalesce(jsonb_typeof(run->'cooling_status'),'missing')='missing'
       OR coalesce(run->>'heating_status','consistent') NOT IN ('consistent','above_line','below_line')
       OR coalesce(run->>'cooling_status','consistent') NOT IN ('consistent','above_line','below_line')
       OR jsonb_typeof(run->'heating')='null' AND jsonb_typeof(run->'heating_status')<>'null'
       OR jsonb_typeof(run->'cooling')='null' AND jsonb_typeof(run->'cooling_status')<>'null')
     OR jsonb_typeof(run->'reasons') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'Invalid measured room assessment'; END IF;
   IF EXISTS(SELECT FROM jsonb_array_elements(run->'reasons') r WHERE jsonb_typeof(r)<>'string')
     THEN RAISE EXCEPTION 'Invalid measured room reasons'; END IF;
   FOREACH key IN ARRAY ARRAY['from_ms','on_ms','off_ms','to_ms','energy_kwh'] LOOP
     IF jsonb_typeof(run->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid measured room field: %',key; END IF;
   END LOOP;
   FOREACH key IN ARRAY ARRAY['reference_heating_c_per_kwh','reference_cooling_c_per_h','heating_residual','cooling_residual'] LOOP
     IF coalesce(jsonb_typeof(run->key),'missing') NOT IN ('number','null') THEN RAISE EXCEPTION 'Invalid measured room residual: %',key; END IF;
   END LOOP;
   FOREACH kind IN ARRAY ARRAY['heating','cooling'] LOOP
     point:=run->kind;
     IF jsonb_typeof(point)='null' THEN CONTINUE; END IF;
     IF jsonb_typeof(point) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid measured room point'; END IF;
     FOREACH key IN ARRAY CASE kind WHEN 'heating' THEN ARRAY['on_ms','peak_ms','peak_end_ms','energy_kwh','hours','rise_c','c_per_kwh','room_start_c','room_peak_c','room_mean_c','outdoor_c']
       ELSE ARRAY['from_ms','to_ms','hours','c_per_h','room_c','outdoor_c','energy_kwh'] END LOOP
       IF jsonb_typeof(point->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid measured room point field: %',key; END IF;
     END LOOP;
     IF coalesce(jsonb_typeof(point->'house_c'),'missing') NOT IN ('number','null') THEN RAISE EXCEPTION 'Invalid measured room house temperature'; END IF;
     IF kind='heating' THEN
       IF jsonb_typeof(point->'native_seconds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid measured native intervals'; END IF;
       IF EXISTS(SELECT FROM jsonb_array_elements(point->'native_seconds') v WHERE jsonb_typeof(v)<>'number') THEN RAISE EXCEPTION 'Invalid measured native interval'; END IF;
     END IF;
   END LOOP;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['room_c','house_c'] LOOP
   IF jsonb_typeof(support#>ARRAY['reference',key]) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid measured room reference'; END IF;
 END LOOP;
 FOREACH kind IN ARRAY ARRAY['heating','cooling','reference_heating','reference_cooling'] LOOP
   line:=support#>ARRAY['lines',kind];
   IF jsonb_typeof(line)='null' THEN CONTINUE; END IF;
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid measured room line'; END IF;
   FOREACH key IN ARRAY ARRAY['reference_outdoor_c','intercept','slope_per_c','robust_scale','points','effective_points'] LOOP
     IF jsonb_typeof(line->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid measured room line field: %',key; END IF;
   END LOOP;
   IF coalesce(line->>'constraint','') NOT IN ('rises','falls') OR coalesce(line->>'units','') NOT IN ('c_per_kwh','c_per_h')
     THEN RAISE EXCEPTION 'Invalid measured room line units'; END IF;
 END LOOP;
 IF jsonb_typeof(support#>'{validation,observations}') IS DISTINCT FROM 'number'
   OR (support#>>'{validation,observations}')::numeric<0
   OR trunc((support#>>'{validation,observations}')::numeric)<>(support#>>'{validation,observations}')::numeric
   OR coalesce(jsonb_typeof(support#>'{validation,training_to}'),'missing') NOT IN ('string','null')
 THEN RAISE EXCEPTION 'Invalid measured room validation'; END IF;
 FOREACH key IN ARRAY ARRAY['trajectory_mae_c','trajectory_bias_c'] LOOP
   IF coalesce(jsonb_typeof(support#>ARRAY['validation',key]),'missing') NOT IN ('number','null')
     THEN RAISE EXCEPTION 'Invalid measured room validation field'; END IF;
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION private.validate_measured_room_ledger(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION private.validate_measured_room_ledger(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
