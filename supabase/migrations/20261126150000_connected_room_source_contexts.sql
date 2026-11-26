-- Named observed rooms share the existing durable learning lane. A probe-only
-- room never acquires a heater, control, meter reading or comfort service.
CREATE FUNCTION private.room_connection_graph(p_home uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 WITH graph AS (
   SELECT p.app_map_owner AS owner,p.app_map_revision AS revision,
     coalesce((SELECT jsonb_agg(e->'rooms' ORDER BY e->'rooms') FROM jsonb_array_elements(p.connections) e),'[]'::jsonb) AS connections
   FROM (SELECT 1) singleton LEFT JOIN energy_room_profiles p ON p.home_id=p_home
 ) SELECT jsonb_build_object('owner',owner,'revision',revision,'connections',connections,
   'topology_hash',encode(sha256(convert_to(connections::text,'UTF8')),'hex')) FROM graph;
$$;
REVOKE ALL ON FUNCTION private.room_connection_graph(uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION private.energy_room_heating_contexts(uuid,boolean) RENAME TO energy_controlled_room_heating_contexts;
CREATE FUNCTION private.energy_room_observed_contexts(p_home_id uuid,p_history boolean DEFAULT false)
RETURNS TABLE(room_key text,binding text,observed_since timestamptz)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 SELECT t.room_key,md5(jsonb_build_array(t.room_key,t.source_key,private.room_connection_graph(p_home_id),
   private.energy_heating_source_fingerprint(p_home_id))::text),
   CASE WHEN p_history THEN (SELECT min(p.start_ts) FROM energy_heating_probe_observations p
     WHERE p.home_id=p_home_id AND EXISTS(SELECT FROM jsonb_array_elements(p.probes) v WHERE v->>'area_key'=t.room_key)) END
 FROM private.energy_heating_history_targets(p_home_id) t
 WHERE t.device_statistics='{}'::jsonb
   AND NOT EXISTS(SELECT FROM private.energy_controlled_room_heating_contexts(p_home_id,false) c WHERE c.room_key=t.room_key)
   AND EXISTS(SELECT FROM jsonb_array_elements(private.room_connection_graph(p_home_id)->'connections') edge
     WHERE edge ? t.room_key);
$$;
REVOKE ALL ON FUNCTION private.energy_room_observed_contexts(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION private.energy_room_heating_contexts(p_home_id uuid,p_history boolean DEFAULT false)
RETURNS TABLE(room_key text,binding text,observed_since timestamptz)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 SELECT c.room_key,md5(jsonb_build_array(c.binding,private.room_connection_graph(p_home_id))::text),c.observed_since
 FROM private.energy_controlled_room_heating_contexts(p_home_id,p_history) c
 UNION ALL SELECT * FROM private.energy_room_observed_contexts(p_home_id,p_history);
$$;
REVOKE ALL ON FUNCTION private.energy_room_heating_contexts(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.room_connected_capture(p_home uuid,p_room text,p_policy text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 WITH graph AS (SELECT private.room_connection_graph(p_home) AS value), peers AS (
   SELECT DISTINCT CASE WHEN edge->>0=p_room THEN edge->>1 ELSE edge->>0 END AS key
   FROM graph CROSS JOIN LATERAL jsonb_array_elements(value->'connections') edge WHERE edge ? p_room
 ) SELECT jsonb_build_object('graph',graph.value,
   'peerKeys',(SELECT coalesce(jsonb_agg(key ORDER BY key COLLATE "C"),'[]'::jsonb) FROM peers),
   'sourceKeys',(SELECT coalesce(jsonb_object_agg(r.key,r.value->'source_key'),'{}'::jsonb)
     FROM energy_room_profiles p CROSS JOIN LATERAL jsonb_each(p.rooms) r
     WHERE p.home_id=p_home AND (r.key=p_room OR r.key IN (SELECT key FROM peers))),
   'observedOnly',EXISTS(SELECT FROM private.energy_room_observed_contexts(p_home,false) c WHERE c.room_key=p_room),
   'policyFingerprint',p_policy) FROM graph;
$$;
REVOKE ALL ON FUNCTION private.room_connected_capture(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.room_context_metadata(p_home uuid,p_room text,p_binding text,p_since timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,private AS $$
 SELECT jsonb_build_object('binding',p_binding,'observed_since',p_since,
   'room_name',coalesce(p.rooms->p_room->>'name',p_room),'source_key',p.rooms->p_room->'source_key',
   'peer_keys',c->'peerKeys','observed_only',c->'observedOnly','graph',c->'graph')
 FROM (SELECT private.room_connected_capture(p_home,p_room,NULL) AS c) capture
 LEFT JOIN energy_room_profiles p ON p.home_id=p_home;
$$;
REVOKE ALL ON FUNCTION private.room_context_metadata(uuid,text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_energy_room_heating_context(p_home_id uuid,p_room_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 SELECT private.room_context_metadata(p_home_id,c.room_key,c.binding,c.observed_since)
 FROM private.energy_room_heating_contexts(p_home_id,true) c WHERE c.room_key=p_room_key;
$$;
CREATE OR REPLACE FUNCTION public.capture_energy_device_models(p_home_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 WITH contexts AS MATERIALIZED (
   SELECT c.room_key,private.room_context_metadata(p_home_id,c.room_key,c.binding,c.observed_since) AS value
   FROM private.energy_room_heating_contexts(p_home_id,false) c
 ) SELECT jsonb_build_object(
   'rooms',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY room_key) FROM energy_optimisation_zone_models m WHERE home_id=p_home_id),'[]'::jsonb),
   'pool',(SELECT to_jsonb(m) FROM energy_optimisation_pool_model m WHERE home_id=p_home_id),
   'devices',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY device_key) FROM energy_optimisation_device_operating_points m WHERE home_id=p_home_id),'[]'::jsonb),
   'room_heating',coalesce((SELECT jsonb_object_agg(room_key,value) FROM contexts WHERE value->'observed_only'='false'::jsonb),'{}'::jsonb),
   'room_observed',coalesce((SELECT jsonb_object_agg(room_key,value) FROM contexts WHERE value->'observed_only'='true'::jsonb),'{}'::jsonb),
   'room_graph',private.room_connection_graph(p_home_id));
$$;


CREATE OR REPLACE FUNCTION private.room_evidence_policy_fingerprint(
 p_home uuid,p_room text,p_binding text,p_from timestamptz,p_to timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,private SET timezone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(
   private.energy_heating_source_fingerprint(p_home),
   private.room_connection_graph(p_home),
   (SELECT coalesce(jsonb_agg(jsonb_build_array(x.device_key,x.statistic_id,x.valid_from,x.valid_to)
      ORDER BY x.device_key,x.statistic_id,x.valid_from,x.valid_to),'[]'::jsonb)
    FROM private.room_evidence_policy_exclusions(p_home,p_room,p_from,p_to) x),
   (SELECT coalesce(jsonb_agg(jsonb_build_array(f.id,f.kind,f.from_at,f.to_at) ORDER BY f.id),'[]'::jsonb)
    FROM private.energy_room_operation_facts f WHERE f.home_id=p_home AND f.room_key=p_room AND f.binding=p_binding
      AND f.basis='customer_assertion' AND f.from_at<p_to AND f.to_at>p_from)
 )::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION private.room_evidence_policy_fingerprint(uuid,text,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_energy_room_evidence_work(p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text,
 p_from_at timestamptz,p_to_at timestamptz,p_implementation text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
DECLARE next_work jsonb;
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) OR
   NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(p_home_id) WHERE room_key=p_room_key AND binding=p_binding)
 THEN RAISE EXCEPTION 'Home or room binding mismatch'; END IF;
 IF p_from_at IS NULL OR p_to_at IS NULL OR NOT isfinite(p_from_at) OR NOT isfinite(p_to_at)
   OR p_to_at<p_from_at OR coalesce(p_implementation,'')='' THEN RAISE EXCEPTION 'Invalid evidence scope'; END IF;
 -- Each refit may have appended only a few quarters. Compute the union of
 -- owned starts and test dirt set-wise, without fetching payloads or running
 -- a separate statement for every previously recorded tail.
 WITH blocks AS MATERIALIZED (
   SELECT from_at,to_at,source_revision,solar_retry_at,solar_after FROM private.energy_room_evidence_blocks
   WHERE home_id=p_home_id AND customer_id=p_customer_id AND room_key=p_room_key AND binding=p_binding
     AND implementation=p_implementation AND from_at<p_to_at AND to_at>p_from_at
 ), gaps AS (
   SELECT unnest(tstzmultirange(tstzrange(p_from_at,p_to_at,'[)'))
     -coalesce(range_agg(tstzrange(from_at,to_at,'[)')),'{}'::tstzmultirange)) AS gap FROM blocks
 ), pending AS (
   SELECT lower(gap) AS from_at,least(upper(gap),lower(gap)+interval '240 hours') AS to_at,
     NULL::timestamptz AS solar_retry_at,NULL::timestamptz AS solar_after FROM gaps
   UNION ALL
   SELECT b.from_at,b.to_at,b.solar_retry_at,b.solar_after FROM blocks b
   -- A canonical quarter can supersede an hour spanning an internal seam.
   -- The publication horizon itself is exclusive.
   WHERE b.solar_retry_at<=now() OR (b.solar_after IS NOT NULL AND b.solar_retry_at IS NULL)
     OR EXISTS(SELECT FROM private.energy_room_evidence_changes d WHERE d.home_id=p_home_id AND d.room_key IN ('',p_room_key)
       AND d.revision>b.source_revision AND d.affected && tstzrange(greatest(p_from_at,b.from_at-interval '1 hour'),
         least(p_to_at,b.to_at+interval '1 hour'),'[)'))
 )
 SELECT to_jsonb(p) INTO next_work FROM pending p ORDER BY p.from_at LIMIT 1;
 RETURN jsonb_build_object('source_revision',coalesce((SELECT revision FROM private.energy_room_evidence_clocks
   WHERE home_id=p_home_id),0),'next',next_work,
   'policy_fingerprint',private.room_evidence_policy_fingerprint(p_home_id,p_room_key,p_binding,p_from_at,p_to_at),
   'connected',private.room_connected_capture(p_home_id,p_room_key,
     private.room_evidence_policy_fingerprint(p_home_id,p_room_key,p_binding,p_from_at,p_to_at)));
END; $$;



CREATE FUNCTION private.energy_qualified_room_probe_vectors(
 p_customer_id uuid,p_home_id uuid,p_from timestamptz,p_to timestamptz,p_include_probe_evidence boolean)
RETURNS TABLE(start_ts timestamptz,duration_s integer,learning_updated_at timestamptz,
 raw_probes jsonb,source_valid boolean,probes jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 WITH targets AS MATERIALIZED (SELECT * FROM private.energy_heating_history_targets(p_home_id)),
 peers AS MATERIALIZED (
   -- House contributors are all configured room probes, independently of
   -- whether their heaters can currently participate in thermal learning.
   SELECT r.key AS room_key,r.value->>'source_key' AS source_key
   FROM energy_room_profiles p CROSS JOIN LATERAL jsonb_each(p.rooms) r
   WHERE p.home_id=p_home_id
 ),
 assignments AS MATERIALIZED (
   SELECT h.* FROM private.energy_heating_history_sources h
   JOIN targets t ON t.room_key=h.room_key
     AND t.source_key=h.target_source_key AND t.device_statistics=h.target_device_statistics
   WHERE h.home_id=p_home_id AND h.valid_from<p_to AND h.valid_to>p_from
 )

   -- Discovery needs the same source-validity decision, but not a reconstructed
   -- JSON vector: every raw fact is already covered by the full-span digest.
   SELECT p.start_ts,p.duration_s,p.learning_updated_at,p.probes AS raw_probes,
     qualified.source_valid,qualified.probes
   FROM energy_heating_probe_observations p
   CROSS JOIN LATERAL (
     SELECT coalesce(bool_and(coalesce(valid,false)),true) AS source_valid,
       CASE WHEN p_include_probe_evidence THEN coalesce(jsonb_agg(v ORDER BY position)
         FILTER(WHERE p_include_probe_evidence AND valid),'[]'::jsonb) END AS probes
     FROM jsonb_array_elements(p.probes) WITH ORDINALITY facts(v,position)
     LEFT JOIN peers t ON t.room_key=v->>'area_key'
     CROSS JOIN LATERAL (SELECT t.room_key IS NOT NULL AND ((
       NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=t.room_key
         AND h.valid_from<p.start_ts+make_interval(secs=>p.duration_s) AND h.valid_to>p.start_ts)
       AND (t.source_key IS NULL OR v->>'source_key'=t.source_key)
      ) OR (
       EXISTS(SELECT FROM assignments h WHERE h.room_key=t.room_key AND h.observed_source_key=v->>'source_key'
         AND h.valid_from<=p.start_ts AND h.valid_to>=p.start_ts+make_interval(secs=>p.duration_s))
       AND NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=t.room_key
         AND h.valid_from<p.start_ts+make_interval(secs=>p.duration_s) AND h.valid_to>p.start_ts
         AND (h.valid_from>p.start_ts OR h.valid_to<p.start_ts+make_interval(secs=>p.duration_s)))
      )) AS valid) validity
   ) qualified
   WHERE p.home_id=p_home_id AND p.customer_id=p_customer_id AND p.start_ts>=p_from
     AND p.start_ts+make_interval(secs=>p.duration_s)<=p_to
;
$$;
REVOKE ALL ON FUNCTION private.energy_qualified_room_probe_vectors(uuid,uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION private.energy_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz,p_include_probe_evidence boolean)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb,native_updated_at timestamptz,probe_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH sources AS MATERIALIZED (SELECT * FROM private.energy_heating_observation_sources(p_home_id)
   WHERE room_key=p_room_key),
 exclusions AS MATERIALIZED (
   SELECT x.* FROM private.energy_heating_meter_exclusions x WHERE x.home_id=p_home_id
     AND x.valid_from<p_to AND x.valid_to>p_from
     AND EXISTS(SELECT FROM sources s WHERE s.device_statistics ? x.device_key)
 ),
 targets AS MATERIALIZED (SELECT * FROM private.energy_heating_history_targets(p_home_id)),
 assignments AS MATERIALIZED (
   SELECT h.* FROM private.energy_heating_history_sources h
   JOIN targets t ON t.room_key=h.room_key
     AND t.source_key=h.target_source_key AND t.device_statistics=h.target_device_statistics
   WHERE h.home_id=p_home_id AND h.valid_from<p_to AND h.valid_to>p_from
 ), probe_vectors AS NOT MATERIALIZED (
   SELECT * FROM private.energy_qualified_room_probe_vectors(p_customer_id,p_home_id,p_from,p_to,p_include_probe_evidence)
 ), legacy_since AS (
   -- Legacy rows have no meter/probe lineage. Extending the context with
   -- explicitly attributed native history must not re-admit ambiguous legacy
   -- rows from before the current meter or thermometer binding.
   SELECT greatest(max(d.first_seen_at), (SELECT max(p.start_ts)+interval '15 minutes'
     FROM energy_room_probe_slots p JOIN energy_room_profiles r ON r.home_id=p.home_id
     WHERE p.home_id=p_home_id AND p.room_key=p_room_key
       AND p.source_key IS DISTINCT FROM r.rooms->p_room_key->>'source_key')) AS at
   FROM energy_optimisation_devices d WHERE d.home_id=p_home_id AND d.customer_id=p_customer_id
     AND d.mapping_summary->>'room_key'=p_room_key AND d.retired_at IS NULL
     AND d.planning_role_override='controllable' AND d.control_type_override IN ('setpoint','switch_schedule')
 ),
 native AS MATERIALIZED (
   SELECT n.room_key,s.room_name,s.active_power_w,n.start_ts,n.room_temperature_c,n.cooling,
     n.outdoor_temperature_c,n.solar_w_per_m2,
     CASE WHEN p.source_valid=false OR EXISTS(
       SELECT FROM assignments h WHERE h.observed_source_key<>h.target_source_key
         AND h.valid_from<n.start_ts+make_interval(secs=>n.duration_s) AND h.valid_to>n.start_ts
         AND NOT EXISTS(SELECT FROM jsonb_array_elements(p.raw_probes) v
           WHERE v->>'area_key'=h.room_key AND v->>'source_key'=h.observed_source_key
             AND h.valid_from<=n.start_ts AND h.valid_to>=n.start_ts+make_interval(secs=>n.duration_s)))
       THEN NULL::double precision ELSE n.house_temperature_c END AS house_temperature_c,
     CASE WHEN NOT EXISTS(SELECT FROM exclusions x
       WHERE n.device_statistics->>x.device_key=x.statistic_id
         AND x.valid_from<n.start_ts+make_interval(secs=>n.duration_s) AND x.valid_to>n.start_ts)
       AND n.device_energy_kwh ?& ARRAY(SELECT jsonb_object_keys(s.device_statistics))
       AND NOT EXISTS (SELECT FROM jsonb_each(n.device_energy_kwh) e(k,v)
         WHERE s.device_statistics ? k AND jsonb_typeof(v) IS DISTINCT FROM 'number') THEN
       (SELECT sum(least(v::double precision,
           (attribution.limits->>k)::double precision*n.duration_s/3600000))
         FROM jsonb_each_text(n.device_energy_kwh) e(k,v)
         WHERE s.device_statistics ? k)*3600000/n.duration_s ELSE NULL END AS heat_w,
     n.duration_s,n.source,attribution.limits<>'{}'::jsonb AS heat_attributed,
     n.source_key AS temperature_source_key,CASE WHEN p_include_probe_evidence THEN p.probes END AS probe_evidence,
     max(n.learning_updated_at) OVER (PARTITION BY n.room_key,n.start_ts,n.duration_s) AS native_updated_at,
     p.learning_updated_at AS probe_updated_at
   FROM energy_heating_observations n JOIN sources s ON s.room_key=n.room_key
   LEFT JOIN LATERAL (
     SELECT h.heater_energy_limits_w,h.valid_from FROM assignments h
     WHERE h.room_key=n.room_key
       AND h.target_source_key=s.source_key AND h.target_device_statistics=s.device_statistics
       AND h.observed_source_key=n.source_key AND h.observed_device_statistics=n.device_statistics
       AND n.start_ts>=h.valid_from AND n.start_ts+make_interval(secs=>n.duration_s)<=h.valid_to
     ORDER BY h.valid_from DESC LIMIT 1
   ) reviewed ON true
   CROSS JOIN LATERAL (SELECT coalesce(reviewed.heater_energy_limits_w,n.heater_energy_limits_w) AS limits) attribution
   LEFT JOIN probe_vectors p ON p.start_ts=n.start_ts AND p.duration_s=n.duration_s
   WHERE public.energy_home_matches_customer(p_home_id,p_customer_id)
     AND n.home_id=p_home_id AND n.customer_id=p_customer_id AND n.room_key=p_room_key AND n.start_ts>=p_from
     AND n.start_ts+make_interval(secs=>n.duration_s)<=p_to
     -- Same authoritative source rule as energy_heating_source_matches, applied
     -- to the range's already-captured assignments rather than issuing a new
     -- source-history query for each of 38,400 native intervals.
     AND (reviewed.valid_from IS NOT NULL OR (
       n.source_key=s.source_key AND n.device_statistics=s.device_statistics
       AND NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=n.room_key
         AND h.target_source_key=s.source_key AND h.target_device_statistics=s.device_statistics
         AND n.start_ts<h.valid_to AND n.start_ts+make_interval(secs=>n.duration_s)>h.valid_from)))
 ), native_coverage AS MATERIALIZED (
   -- Native intervals are exact epoch-aligned quarters/hours. Keep only their
   -- narrow covered-quarter keys for the legacy overlap anti-join. Legacy
   -- timestamps can carry fractional seconds, so floor their lookup key below.
   SELECT start_ts+quarter*interval '15 minutes' AS start_ts FROM native
   CROSS JOIN LATERAL generate_series(0,duration_s/900-1) quarter
 ), fine AS MATERIALIZED (
   SELECT * FROM native WHERE duration_s=900
   UNION ALL
   SELECT q.room_key,q.room_name,q.active_power_w,q.start_ts,q.room_temperature_c,q.cooling,
     q.outdoor_temperature_c,q.solar_w_per_m2,
     CASE WHEN p.source_valid=false OR EXISTS(SELECT FROM assignments h WHERE h.observed_source_key<>h.target_source_key
       AND h.valid_from<q.start_ts+interval '15 minutes' AND h.valid_to>q.start_ts)
       THEN NULL::double precision ELSE q.house_temperature_c END,
     CASE WHEN EXISTS(SELECT FROM exclusions x WHERE s.device_statistics->>x.device_key=x.statistic_id
       AND x.valid_from<q.start_ts+interval '15 minutes' AND x.valid_to>q.start_ts)
       THEN NULL::double precision ELSE q.heat_w END,900,'recorder_5minute_mean'::text,false,s.source_key,CASE WHEN p_include_probe_evidence THEN p.probes END,NULL::timestamptz,p.learning_updated_at
   FROM legacy_since l
   CROSS JOIN LATERAL private.energy_room_training_quarters(
     p_customer_id,p_home_id,p_room_key,greatest(p_from,l.at),p_to) q
   JOIN sources s USING(room_key)
   LEFT JOIN probe_vectors p ON p.start_ts=q.start_ts AND p.duration_s=900
   WHERE public.energy_home_matches_customer(p_home_id,p_customer_id)
     AND (l.at IS NULL OR q.start_ts>=l.at)
     AND NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=q.room_key
       AND h.valid_from<q.start_ts+interval '15 minutes' AND h.valid_to>q.start_ts)
     AND NOT EXISTS (SELECT FROM native_coverage n WHERE n.start_ts=
       date_bin(interval '15 minutes',q.start_ts,timestamptz '1970-01-01 00:00:00+00'))
 ), complete_fine AS (
   SELECT room_key,date_trunc('hour',start_ts) AS hour FROM fine
   WHERE room_temperature_c IS NOT NULL AND outdoor_temperature_c IS NOT NULL
     AND house_temperature_c IS NOT NULL AND heat_w IS NOT NULL AND cooling IS NOT NULL
   GROUP BY 1,2 HAVING count(*)=4
 ), coarse AS MATERIALIZED (
   SELECT n.* FROM native n WHERE duration_s=3600
     -- Known heating in an otherwise incomplete hour still carries stored heat.
     -- The learner decides which temperature transitions are identifiable.
     AND NOT EXISTS (SELECT FROM complete_fine f WHERE f.room_key=n.room_key AND f.hour=n.start_ts)
 )
 SELECT * FROM coarse UNION ALL
 SELECT f.* FROM fine f WHERE NOT EXISTS (SELECT FROM coarse c WHERE c.room_key=f.room_key
   AND c.start_ts=date_trunc('hour',f.start_ts))
 ORDER BY room_key,start_ts;
$$;


CREATE FUNCTION private.energy_observed_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 WITH context AS MATERIALIZED (
   SELECT c.room_key,coalesce(p.rooms->c.room_key->>'name',c.room_key) AS room_name
   FROM private.energy_room_observed_contexts(p_home_id,false) c JOIN energy_room_profiles p ON p.home_id=p_home_id
   WHERE c.room_key=p_room_key AND public.energy_home_matches_customer(p_home_id,p_customer_id)
 ), weather AS MATERIALIZED (
   -- These are contemporaneous measured native weather means, not resampled
   -- endpoints or a forecast. Missing weather remains an unknown covariate.
   SELECT n.start_ts,n.duration_s,percentile_cont(.5) WITHIN GROUP(ORDER BY n.outdoor_temperature_c) AS outdoor_c,
     percentile_cont(.5) WITHIN GROUP(ORDER BY n.solar_w_per_m2) AS solar
   FROM energy_heating_observations n WHERE n.home_id=p_home_id AND n.customer_id=p_customer_id
     AND n.start_ts>=p_from AND n.start_ts+make_interval(secs=>n.duration_s)<=p_to
   GROUP BY n.start_ts,n.duration_s
 ), raw AS MATERIALIZED (
   SELECT c.room_key,c.room_name,NULL::double precision AS active_power_w,v.start_ts,
     (probe->>'mean')::double precision AS room_temperature_c,NULL::boolean AS cooling,w.outdoor_c AS outdoor_temperature_c,
     w.solar AS solar_w_per_m2,NULL::double precision AS house_temperature_c,NULL::double precision AS heat_w,
     v.duration_s,CASE WHEN v.duration_s=900 THEN 'recorder_5minute_mean' ELSE 'recorder_hour_mean' END AS source,
     false AS heat_attributed,probe->>'source_key' AS temperature_source_key,v.probes AS probe_evidence
   FROM context c CROSS JOIN LATERAL private.energy_qualified_room_probe_vectors(p_customer_id,p_home_id,p_from,p_to,true) v
   CROSS JOIN LATERAL jsonb_array_elements(v.probes) probe
   LEFT JOIN weather w ON w.start_ts=v.start_ts AND w.duration_s=v.duration_s
   WHERE probe->>'area_key'=c.room_key
 ), complete_fine AS (
   SELECT date_trunc('hour',start_ts) AS hour FROM raw WHERE duration_s=900
     AND room_temperature_c IS NOT NULL AND outdoor_temperature_c IS NOT NULL
   GROUP BY 1 HAVING count(*)=4
 ), coarse AS MATERIALIZED (
   SELECT * FROM raw r WHERE duration_s=3600 AND NOT EXISTS(SELECT FROM complete_fine f WHERE f.hour=r.start_ts)
 ) SELECT * FROM coarse UNION ALL SELECT r.* FROM raw r WHERE duration_s=900
   AND NOT EXISTS(SELECT FROM coarse c WHERE c.start_ts=date_trunc('hour',r.start_ts)) ORDER BY start_ts;
$$;
REVOKE ALL ON FUNCTION private.energy_observed_room_thermal_intervals(uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_energy_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,private AS $$
 SELECT room_key,room_name,active_power_w,start_ts,room_temperature_c,cooling,outdoor_temperature_c,
   solar_w_per_m2,house_temperature_c,heat_w,duration_s,source,heat_attributed,temperature_source_key,probe_evidence
 FROM private.energy_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to,true)
 UNION ALL SELECT * FROM private.energy_observed_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to);
$$;

-- The revision checked app map is policy, even when its pair set is unchanged.
DO $$ DECLARE operation text; transition_tables text; projection text;
BEGIN
 projection:='SELECT s.home_id,''''::text AS room_key,tstzrange(NULL::timestamptz,NULL::timestamptz,''[)'') AS span,
   (SELECT jsonb_object_agg(r.key,r.value->''source_key'') FROM jsonb_each(s.rooms) r),
   s.connections,s.app_map_owner,s.app_map_revision FROM %I s';
 FOREACH operation IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('DROP TRIGGER %I ON public.energy_room_profiles','room_evidence_'||lower(operation));
   transition_tables:=CASE operation WHEN 'INSERT' THEN 'NEW TABLE AS new_source'
     WHEN 'DELETE' THEN 'OLD TABLE AS old_source' ELSE 'OLD TABLE AS old_source NEW TABLE AS new_source' END;
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.energy_room_profiles REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION private.journal_room_evidence(%L)',
     'room_evidence_'||lower(operation),operation,transition_tables,projection);
 END LOOP;
END; $$;


CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean; heating_bindings jsonb;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
  -- Complete durable ownership includes passive observed graph nodes, but does
  -- not change the app's controllable-device roster or planning permissions.
  p_owners:=p_owners||coalesce((SELECT jsonb_agg(jsonb_build_object('kind','room','key',c.room_key,
    'input',coalesce((SELECT o->'input' FROM jsonb_array_elements(p_owners) o WHERE o->>'kind'='room' LIMIT 1),'{}'::jsonb)))
    FROM private.energy_room_observed_contexts(p_home_id,false) c
    WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(p_owners) o WHERE o->>'kind'='room' AND o->>'key'=c.room_key)),'[]'::jsonb);
  SELECT COALESCE(jsonb_object_agg(c.room_key,c.binding),'{}'::jsonb) INTO heating_bindings
    FROM private.energy_room_heating_contexts(p_home_id) c;
  -- The capture supplies the complete current ownership set. Removal fences an
  -- in-flight fit too; retained models stay available if a device is remapped.
  UPDATE private.energy_learning_jobs j SET pending=false,generation=generation+1,fence=fence+1,
    lease_until=NULL,finished_at=now(),last_error='Learning owner removed'
  WHERE home_id=p_home_id AND pending AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_owners) AS current_owner(value)
      WHERE current_owner.value->>'kind'=j.owner_kind AND current_owner.value->>'key'=j.owner_key);
  FOR o IN SELECT value FROM jsonb_array_elements(p_owners) LOOP
    IF o->>'kind'='room' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at < now()-CASE
          WHEN trained AND (heating_bands IS NULL OR heating_bands->>'reference_revision' IS NOT NULL)
          THEN interval '24 hours' ELSE interval '1 hour' END
        OR (heating_bindings ? (o->>'key') AND heating_bands->>'calibration_policy' IS DISTINCT FROM 'measured_room_runs_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands#>>'{shared_attempt,implementation}' IS DISTINCT FROM
          'chronological_native_evidence_v1:measured_room_runs_v1:native_mean_onset_peak_v1:state_carrying_forecast_v1:adaptive_connected_native_v1')
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL
          AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        -- A fit made by another room learner is refitted on the next upload.
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL AND o->'input' ? 'learner_version'
          AND heating_bands#>>'{shared_attempt,learner_version}' IS DISTINCT FROM o->'input'->>'learner_version')
        OR (trained AND NOT (heating_bindings ? (o->>'key'))
          AND (last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'interval_mean_transition_holdout_v1'
            OR last_fit_attempt->'learning'->>'family' IS DISTINCT FROM 'house_outdoor_solar_v1'))
      INTO due FROM public.energy_optimisation_zone_models WHERE home_id=p_home_id AND room_key=o->>'key';
    ELSIF o->>'kind'='pool' AND o->>'key'='pool' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR (heat_pump_epoch_start IS NOT NULL AND heat_pump_epoch_start>last_attempted_at)
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM 'pool_interval_mean_v1'
      INTO due FROM public.energy_optimisation_pool_model WHERE home_id=p_home_id;
    ELSIF o->>'kind'='device' AND COALESCE(o->>'key','')<>'' THEN
      SELECT last_attempted_at IS NULL OR last_attempted_at<now()-interval '24 hours'
        OR last_fit_attempt->'learning'->>'method' IS DISTINCT FROM
          CASE WHEN o->'input'->>'weather_heating_binding' IS NULL
            THEN 'device_operating_points_v1' ELSE 'weather_heating_draw_v1' END
        OR (o->'input'->>'weather_heating_binding' IS NOT NULL AND
          operating_points->>'binding' IS DISTINCT FROM o->'input'->>'weather_heating_binding')
      INTO due FROM public.energy_optimisation_device_operating_points WHERE home_id=p_home_id AND device_key=o->>'key';
    ELSE RAISE EXCEPTION 'Invalid learning owner'; END IF;
    IF COALESCE(due,true) OR (o->>'kind'='device' AND EXISTS (
      SELECT 1 FROM private.energy_learning_jobs j
      WHERE j.home_id=p_home_id AND j.owner_kind='device' AND j.owner_key=o->>'key'
        AND j.pending AND j.input IS DISTINCT FROM o->'input'
    )) THEN
      INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
        VALUES(p_home_id,p_customer_id,o->>'kind',o->>'key',o->'input')
      ON CONFLICT(home_id,owner_kind,owner_key) DO UPDATE SET
        pending=true,generation=energy_learning_jobs.generation+1,input=EXCLUDED.input,
        fence=energy_learning_jobs.fence+1,lease_until=NULL,wake_after=now(),attempts=0,last_error=NULL,finished_at=NULL
        WHERE NOT energy_learning_jobs.pending OR energy_learning_jobs.input IS DISTINCT FROM EXCLUDED.input RETURNING id INTO v_id;
      IF FOUND THEN PERFORM private.wake_energy_learning_job(v_id); n:=n+1; END IF;
    END IF;
  END LOOP;
  RETURN n;
END; $$;
