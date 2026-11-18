-- Raw vectors are shared by every room and band. Store their exact content
-- digest once rather than serializing and hashing every vector on each read.
ALTER TABLE public.energy_heating_probe_observations
 ADD COLUMN probe_fingerprint text GENERATED ALWAYS AS (md5(probes::text)) STORED;

-- Generated columns are not available in BEFORE triggers. Their value derives
-- entirely from already-compared raw facts; exclude that derived field so an
-- identical overlap upload cannot advance the material evidence clock.
CREATE OR REPLACE FUNCTION private.track_heating_evidence_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.learning_updated_at=statement_timestamp();
 ELSIF (to_jsonb(NEW)-ARRAY['learning_updated_at','received_at','device_token_id','probe_fingerprint'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['learning_updated_at','received_at','device_token_id','probe_fingerprint'])
 THEN NEW.learning_updated_at=statement_timestamp();
 ELSE NEW.learning_updated_at=OLD.learning_updated_at;
 END IF;
 RETURN NEW;
END; $$;

-- Every configured room-air peer can affect freshness and household
-- temperature, even if its heater is unresolved or outside the target roster.
CREATE OR REPLACE FUNCTION private.energy_heating_source_fingerprint(p_home_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT md5(jsonb_build_array(
  (SELECT coalesce(jsonb_agg(jsonb_build_array(room_key,source_key,device_statistics) ORDER BY room_key),'[]'::jsonb)
    FROM private.energy_heating_history_targets(p_home_id)),
  (SELECT coalesce(jsonb_agg(to_jsonb(h)-ARRAY['home_id','basis'] ORDER BY room_key,valid_from,valid_to,observed_source_key),'[]'::jsonb)
    FROM private.energy_heating_history_sources h WHERE home_id=p_home_id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(r.key,r.value->>'source_key') ORDER BY r.key),'[]'::jsonb)
    FROM energy_room_profiles p CROSS JOIN LATERAL jsonb_each(p.rooms) r WHERE p.home_id=p_home_id)
 )::text);
$$;
INSERT INTO private.energy_heating_source_revisions AS prior(home_id,fingerprint)
 SELECT home_id,private.energy_heating_source_fingerprint(home_id) FROM (
   SELECT home_id FROM public.energy_room_profiles
   UNION SELECT home_id FROM private.energy_heating_source_revisions
 ) homes
ON CONFLICT(home_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,
 learning_updated_at=greatest(prior.learning_updated_at,statement_timestamp())
WHERE prior.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint;

-- Keep source qualification and resolution selection unchanged,
-- while removing quadratic joins and repeated wide probe-vector materialization.
-- A 400-day learning read must fit the existing SQL request budget.
CREATE FUNCTION private.energy_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz,p_include_probe_evidence boolean)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb,native_updated_at timestamptz,probe_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH sources AS MATERIALIZED (SELECT * FROM private.energy_heating_observation_sources(p_home_id)
   WHERE room_key=p_room_key),
 targets AS MATERIALIZED (SELECT * FROM private.energy_heating_history_targets(p_home_id)),
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
 ), probe_vectors AS NOT MATERIALIZED (
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
     CASE WHEN n.device_energy_kwh ?& ARRAY(SELECT jsonb_object_keys(s.device_statistics))
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
     q.heat_w,900,'recorder_5minute_mean'::text,false,s.source_key,CASE WHEN p_include_probe_evidence THEN p.probes END,NULL::timestamptz,p.learning_updated_at
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
REVOKE ALL ON FUNCTION private.energy_room_thermal_intervals(uuid,uuid,text,timestamptz,timestamptz,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

-- Existing consumers retain the same canonical full-evidence contract.
CREATE OR REPLACE FUNCTION public.get_energy_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 SELECT room_key,room_name,active_power_w,start_ts,room_temperature_c,cooling,outdoor_temperature_c,
   solar_w_per_m2,house_temperature_c,heat_w,duration_s,source,heat_attributed,temperature_source_key,probe_evidence
 FROM private.energy_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to,true);
$$;

CREATE OR REPLACE FUNCTION public.get_energy_room_heating_fit_windows(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(window_key text,band_c integer,from_at timestamptz,to_at timestamptz,
 fingerprint text,evidence_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH sources AS MATERIALIZED (SELECT * FROM private.energy_heating_observation_sources(p_home_id)
   WHERE room_key=p_room_key),
 observations AS MATERIALIZED (
  SELECT * FROM private.energy_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to,false) q
  WHERE q.room_key=p_room_key
 ), legacy_energy_changes AS MATERIALIZED (
  -- Resolve each source clock once per observation range, not once for every
  -- returned quarter (which repeatedly scanned the same device's meter index).
  SELECT e.start_ts,max(e.learning_updated_at) AS changed
  FROM energy_optimisation_devices d JOIN energy_optimisation_device_slots e ON e.device_id=d.id
  WHERE d.home_id=p_home_id AND e.home_id=p_home_id AND d.mapping_summary->>'room_key'=p_room_key
    AND d.retired_at IS NULL AND e.start_ts>=p_from AND e.start_ts<p_to
  GROUP BY e.start_ts
 ), probe_hashes AS MATERIALIZED (
  -- Bands have overlapping read spans. Hash each retained raw vector once;
  -- include every unknown fact in the ordered span digest.
  SELECT start_ts,duration_s,md5(jsonb_build_array(start_ts,duration_s,probe_fingerprint)::text) AS span_hash,learning_updated_at
  FROM energy_heating_probe_observations
  WHERE home_id=p_home_id AND customer_id=p_customer_id AND start_ts>=p_from AND start_ts<p_to
 ), revisions AS MATERIALIZED (
  -- The canonical reader already selected and qualified native source rows.
  -- Carry their clocks through rather than repeating source qualification and
  -- touching all three legacy tables for every native observation.
  SELECT q.*,identity.fingerprint AS source_fingerprint,
    greatest(q.native_updated_at,q.probe_updated_at,identity.learning_updated_at) AS changed
  FROM observations q
  LEFT JOIN private.energy_heating_source_revisions identity ON identity.home_id=p_home_id
  WHERE q.native_updated_at IS NOT NULL
  UNION ALL
  SELECT q.*,identity.fingerprint AS source_fingerprint,
    greatest(t.learning_updated_at,o.learning_updated_at,h.learning_updated_at,e.changed,
      q.probe_updated_at,identity.learning_updated_at) AS changed
  FROM observations q
  LEFT JOIN private.energy_heating_source_revisions identity ON identity.home_id=p_home_id
  LEFT JOIN energy_optimisation_thermal_slots t ON t.home_id=p_home_id
    AND t.room_key=q.room_key AND t.start_ts=q.start_ts
  LEFT JOIN energy_optimisation_outdoor_slots o ON o.home_id=p_home_id AND o.start_ts=q.start_ts
  LEFT JOIN energy_optimisation_house_slots h ON h.home_id=p_home_id AND h.start_ts=q.start_ts
  LEFT JOIN legacy_energy_changes e ON e.start_ts=q.start_ts
  WHERE q.native_updated_at IS NULL
 ), bands AS (
  SELECT (floor(outdoor_temperature_c/5)*5)::integer AS band,
    min(start_ts) AS begin_at,max(start_ts+make_interval(secs=>duration_s)) AS finish,
    max(changed) AS changed,
    -- Raw probe-span and source-identity digests below cover qualification.
    -- Do not reconstruct and hash the same qualified vector a second time.
    -- Fixed-length ordered digests bound aggregate memory; an empty probe
    -- span below hashes the empty string, distinct from a missing raw vector.
    md5(string_agg(md5((to_jsonb(r)-ARRAY['changed','probe_evidence','native_updated_at','probe_updated_at','active_power_w','room_name'])::text),''
      ORDER BY start_ts,duration_s)) AS fingerprint
  FROM revisions r WHERE outdoor_temperature_c IS NOT NULL
  GROUP BY floor(outdoor_temperature_c/5)
 )
 SELECT band::text,band,greatest(p_from,begin_at-interval '1 hour'),finish,
   md5(jsonb_build_array(b.fingerprint,probe_span.fingerprint)::text),greatest(b.changed,probe_span.changed)
 FROM bands b
 -- The read-time freshness detector uses ordinary cadence outside the fitted
 -- band. Track its whole read span, but not unrelated future summer history.
 LEFT JOIN LATERAL (
   SELECT md5(coalesce(string_agg(p.span_hash,''
     ORDER BY p.start_ts,p.duration_s),'')) AS fingerprint,
     max(p.learning_updated_at) AS changed
   FROM probe_hashes p
   WHERE p.start_ts>=greatest(p_from,b.begin_at-interval '1 hour')
     AND p.start_ts+make_interval(secs=>p.duration_s)<=b.finish
 ) probe_span ON true
 ORDER BY b.finish DESC,b.band;
$$;

-- Context capture needs the first qualifying native interval, not a full scan.
-- LEFT JOIN preserves the prior NULL result when no interval qualifies.
CREATE OR REPLACE FUNCTION private.energy_room_heating_contexts(p_home_id uuid, p_history boolean DEFAULT false)
RETURNS TABLE(room_key text, binding text, observed_since timestamptz)
LANGUAGE sql STABLE SET search_path=public,private AS $$
  WITH grouped AS (
    SELECT d.mapping_summary->>'room_key' AS room_key,
      max(d.first_seen_at) AS meters_since,
      jsonb_agg(jsonb_build_array(d.id,d.statistic_id,d.control_type_override) ORDER BY d.id) AS meters
    FROM energy_optimisation_devices d
    WHERE d.home_id=p_home_id AND d.retired_at IS NULL AND d.planning_role_override='controllable'
      AND d.control_type_override IN ('setpoint','switch_schedule')
      AND jsonb_typeof(d.mapping_summary->'room_key')='string'
    GROUP BY d.mapping_summary->>'room_key'
    HAVING bool_and(d.category='heating')
  ), changed AS (
    SELECT max(note_date)::timestamptz AS since
    FROM energy_history_notes
    WHERE home_id=p_home_id AND note_date<=current_date
      AND event_type IN ('renovation','heating_system_change')
  )
  SELECT g.room_key,
    md5(jsonb_build_array(g.meters,p.rooms->g.room_key->>'source_key',changed.since,
      passive.device_id, neighbors.sources)::text),
    greatest(least(greatest(g.meters_since, prior.last_at), native.first_at), changed.since)
  FROM grouped g
  CROSS JOIN changed
  LEFT JOIN energy_room_profiles p ON p.home_id=p_home_id
  LEFT JOIN private.energy_room_passive_heat_sources passive ON passive.home_id=p_home_id AND passive.room_key=g.room_key
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_array(other.room_key,p.rooms->other.room_key->>'source_key') ORDER BY other.room_key) AS sources
    FROM jsonb_array_elements(p.connections) edge
    CROSS JOIN LATERAL (VALUES (edge->'rooms'->>0,edge->'rooms'->>1),(edge->'rooms'->>1,edge->'rooms'->>0))
      AS other(receiver_key, room_key)
    WHERE other.receiver_key=g.room_key
  ) neighbors ON true
  LEFT JOIN LATERAL (
    SELECT max(s.start_ts) + interval '15 minutes' AS last_at FROM energy_room_probe_slots s
    WHERE p_history AND s.home_id=p_home_id AND s.room_key=g.room_key AND s.source_key IS DISTINCT FROM p.rooms->g.room_key->>'source_key'
  ) prior ON true
  LEFT JOIN LATERAL (
    SELECT n.start_ts AS first_at FROM energy_heating_observations n
    JOIN private.energy_heating_observation_sources(p_home_id) src ON src.room_key=n.room_key
      AND private.energy_heating_source_matches(p_home_id,n.room_key,n.source_key,n.device_statistics,
        src.source_key,src.device_statistics,n.start_ts,n.duration_s)
    WHERE p_history AND n.home_id=p_home_id AND n.room_key=g.room_key
    ORDER BY n.start_ts LIMIT 1
  ) native ON true;
$$;
