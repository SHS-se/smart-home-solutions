-- Reviewed unreliability belongs to a physical meter epoch. Raw evidence,
-- temperatures and immutable model revisions remain available for inspection.
CREATE TABLE private.energy_heating_meter_exclusions (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 device_key text NOT NULL CHECK(length(device_key)>0),
 statistic_id text NOT NULL CHECK(length(statistic_id)>0),
 valid_from timestamptz NOT NULL,
 valid_to timestamptz NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason))>0),
 reviewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(home_id,device_key,statistic_id,valid_from),
 CHECK(isfinite(valid_from) AND isfinite(valid_to) AND valid_to>valid_from)
);
ALTER TABLE private.energy_heating_meter_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_heating_meter_exclusions FROM PUBLIC,anon,authenticated,service_role;

-- Model windows have native interval bounds. Missing old provenance is not
-- evidence that a retained calibration avoided a newly reviewed bad epoch.
CREATE FUNCTION private.heating_calibration_overlaps(p_fit jsonb,p_from timestamptz,p_to timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p_fit->>'training_from' IS NULL OR p_fit->>'training_to' IS NULL THEN true
   ELSE (p_fit->>'training_from')::timestamptz<p_to AND (p_fit->>'training_to')::timestamptz>p_from END;
$$;
REVOKE ALL ON FUNCTION private.heating_calibration_overlaps(jsonb,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.review_heating_meter_exclusion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE home uuid; meter text; first_at timestamptz; last_at timestamptz; room text; general_bad boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 home:=CASE WHEN TG_OP='DELETE' THEN OLD.home_id ELSE NEW.home_id END;
 meter:=CASE WHEN TG_OP='DELETE' THEN OLD.device_key ELSE NEW.device_key END;
 IF TG_OP='UPDATE' AND (NEW.home_id,NEW.device_key,NEW.statistic_id) IS DISTINCT FROM (OLD.home_id,OLD.device_key,OLD.statistic_id)
 THEN RAISE EXCEPTION 'Replace a reviewed meter identity by deleting and inserting its policy'; END IF;
 first_at:=CASE WHEN TG_OP='DELETE' THEN OLD.valid_from WHEN TG_OP='UPDATE' THEN least(OLD.valid_from,NEW.valid_from) ELSE NEW.valid_from END;
 last_at:=CASE WHEN TG_OP='DELETE' THEN OLD.valid_to WHEN TG_OP='UPDATE' THEN greatest(OLD.valid_to,NEW.valid_to) ELSE NEW.valid_to END;
 SELECT d.mapping_summary->>'room_key' INTO room FROM energy_optimisation_devices d
 WHERE d.home_id=home AND d.device_key=meter AND d.retired_at IS NULL AND d.category='heating';
 IF room IS NOT NULL THEN
   SELECT private.heating_calibration_overlaps(jsonb_build_object('training_from',m.training_from,'training_to',m.training_to),first_at,last_at)
     INTO general_bad FROM energy_optimisation_zone_models m WHERE m.home_id=home AND m.room_key=room;
   UPDATE energy_optimisation_zone_models m SET
     heating_bands=(coalesce(m.heating_bands,'{}'::jsonb)-CASE WHEN general_bad THEN ARRAY['reference','reference_revision','general_attempt'] ELSE ARRAY[]::text[] END)
       ||jsonb_build_object(
         'active',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.heating_bands->'active','[]'::jsonb)) b
           WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
         'candidates',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.heating_bands->'candidates','[]'::jsonb)) b
           WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
         'window_attempts','{}'::jsonb,'window_evidence_updated_at','{}'::jsonb,'attempted','{}'::jsonb,'pending_windows',1)
       ||CASE WHEN general_bad THEN jsonb_build_object('reference_revision',NULL) ELSE '{}'::jsonb END,
     trained=CASE WHEN general_bad THEN false ELSE m.trained END,
     rejection_reason=CASE WHEN general_bad THEN 'insufficient_samples' ELSE m.rejection_reason END,
     gain_c_per_wh=CASE WHEN general_bad THEN NULL ELSE m.gain_c_per_wh END,
     cooling_constant_per_h=CASE WHEN general_bad THEN NULL ELSE m.cooling_constant_per_h END,
     last_attempted_at=NULL,
     last_fit_attempt=jsonb_build_object('status','withdrawn','issues',jsonb_build_array('unreliable_meter_history'),
       'reviewed_device_key',meter,'from',first_at,'to',last_at)
   WHERE m.home_id=home AND m.room_key=room;
 END IF;
 UPDATE energy_optimisation_device_operating_points m SET
   operating_points=(coalesce(m.operating_points,'{}'::jsonb)-CASE
     WHEN private.heating_calibration_overlaps(m.operating_points->'reference',first_at,last_at)
       THEN ARRAY['reference'] ELSE ARRAY[]::text[] END)||jsonb_build_object(
     'points',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.operating_points->'points','[]'::jsonb)) b
       WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
     'versioned',coalesce(m.operating_points->'versioned','{}'::jsonb)||jsonb_build_object(
       'candidates',(SELECT coalesce(jsonb_agg(b),'[]'::jsonb) FROM jsonb_array_elements(coalesce(m.operating_points#>'{versioned,candidates}','[]'::jsonb)) b
         WHERE NOT private.heating_calibration_overlaps(b,first_at,last_at)),
       'attempted','{}'::jsonb,'evidence_updated_at','{}'::jsonb,'pending_bands',1)),
   last_attempted_at=NULL,last_fit_attempt=jsonb_build_object('status','withdrawn','issues',jsonb_build_array('unreliable_meter_history'))
 WHERE m.home_id=home AND m.device_key=meter;
 -- Existing publication revisions fence captured numerical scratch. Requeue
 -- only these owners through their ordinary generation/lease recovery path.
 UPDATE private.energy_learning_jobs j SET pending=true,generation=j.generation+1,fence=j.fence+1,
   wake_after=now(),lease_until=NULL,last_error=NULL,finished_at=NULL,attempts=0
 WHERE j.home_id=home AND ((j.owner_kind='room' AND j.owner_key=room)
   OR (j.owner_kind='device' AND j.owner_key=meter));
 PERFORM private.wake_energy_learning_job(j.id) FROM private.energy_learning_jobs j
 WHERE j.home_id=home AND j.pending AND ((j.owner_kind='room' AND j.owner_key=room)
   OR (j.owner_kind='device' AND j.owner_key=meter));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
REVOKE ALL ON FUNCTION private.review_heating_meter_exclusion() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER review_heating_meter_exclusion AFTER INSERT OR UPDATE OR DELETE ON private.energy_heating_meter_exclusions
 FOR EACH ROW EXECUTE FUNCTION private.review_heating_meter_exclusion();

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
REVOKE ALL ON FUNCTION private.energy_room_thermal_intervals(uuid,uuid,text,timestamptz,timestamptz,boolean)
 FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION public.get_energy_weather_heating_days(
 p_home_id uuid,p_customer_id uuid,p_device_key text,p_binding text,p_from timestamptz,p_to timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH owner AS (
  SELECT id,home_id,customer_id,statistic_id FROM energy_optimisation_devices
  WHERE home_id=p_home_id AND customer_id=p_customer_id AND device_key=p_device_key AND retired_at IS NULL
 ),
 exclusions AS MATERIALIZED (
   SELECT * FROM private.energy_heating_meter_exclusions WHERE home_id=p_home_id AND device_key=p_device_key
     AND valid_from<p_to AND valid_to>p_from
 ), meter_epochs AS MATERIALIZED (
   SELECT h.valid_from,h.valid_to,h.observed_device_statistics->>p_device_key AS statistic_id
   FROM private.energy_heating_history_sources h
   JOIN private.energy_heating_history_targets(p_home_id) t ON t.room_key=h.room_key
     AND t.source_key=h.target_source_key AND t.device_statistics=h.target_device_statistics
   WHERE h.home_id=p_home_id AND h.observed_device_statistics ? p_device_key
     AND h.valid_from<p_to AND h.valid_to>p_from
 ), withdrawals AS MATERIALIZED (
  SELECT w.* FROM owner d JOIN private.energy_weather_heating_withdrawals w ON w.device_id=d.id
   AND w.home_id=d.home_id AND w.customer_id=d.customer_id
  WHERE w.binding=p_binding AND w.start_ts>=date_trunc('hour',p_from,'UTC') AND w.start_ts<p_to
 ), quarters AS MATERIALIZED (
  SELECT s.start_ts,o.temperature_c,s.energy_kwh,w.evidence_updated_at AS withdrawn_at,
    greatest(s.weather_heating_updated_at,o.weather_heating_updated_at) AS changed
  FROM owner d JOIN energy_optimisation_device_slots s
    ON s.device_id=d.id AND s.home_id=d.home_id AND s.customer_id=d.customer_id
  JOIN energy_optimisation_outdoor_slots o ON o.home_id=s.home_id AND o.customer_id=s.customer_id AND o.start_ts=s.start_ts
  LEFT JOIN withdrawals w ON w.start_ts=s.start_ts AND w.duration_s=900 AND w.band_c IS NULL
    AND w.evidence_updated_at>=s.weather_heating_updated_at
  WHERE s.start_ts>=date_trunc('hour',p_from,'UTC') AND s.start_ts+interval '15 minutes'<=p_to
    AND s.quality->>'weather_heating_binding'=p_binding AND s.energy_kwh>0 AND o.temperature_c IS NOT NULL
 AND NOT EXISTS(SELECT FROM exclusions x WHERE x.valid_from<s.start_ts+interval '15 minutes' AND x.valid_to>s.start_ts
       AND (EXISTS(SELECT FROM meter_epochs e WHERE e.statistic_id=x.statistic_id
         AND e.valid_from<s.start_ts+interval '15 minutes' AND e.valid_to>s.start_ts)
         OR (NOT EXISTS(SELECT FROM meter_epochs e WHERE e.valid_from<s.start_ts+interval '15 minutes' AND e.valid_to>s.start_ts)
           AND x.statistic_id=coalesce(nullif(split_part(p_binding,'|',3),''),d.statistic_id))))
 ), confirmed_hours AS (
  SELECT date_trunc('hour',q.start_ts,'UTC') AS at,max(q.changed) AS changed
  FROM quarters q WHERE q.withdrawn_at IS NULL GROUP BY 1
 ), withdrawn_hours AS (
  SELECT date_trunc('hour',w.start_ts,'UTC') AS at,max(w.evidence_updated_at) AS changed
  FROM withdrawals w WHERE w.duration_s=900 GROUP BY 1
 ), imported AS (
  SELECT h.*,c.changed AS confirmed_at,w.evidence_updated_at AS withdrawn_at,
    greatest(h.weather_heating_updated_at,c.changed,r.changed,w.evidence_updated_at) AS changed
  FROM owner d JOIN private.energy_weather_heating_hourly_imports h
    ON h.device_id=d.id AND h.home_id=d.home_id AND h.customer_id=d.customer_id
  LEFT JOIN confirmed_hours c ON c.at=h.start_ts
  LEFT JOIN withdrawn_hours r ON r.at=h.start_ts
  LEFT JOIN withdrawals w ON w.start_ts=h.start_ts AND w.duration_s=3600 AND w.band_c IS NULL
    AND w.evidence_updated_at>=h.weather_heating_updated_at
  WHERE h.binding=p_binding AND h.start_ts>=p_from AND h.start_ts+interval '1 hour'<=p_to
 AND NOT EXISTS(SELECT FROM exclusions x WHERE x.valid_from<h.start_ts+interval '1 hour' AND x.valid_to>h.start_ts
       AND (EXISTS(SELECT FROM meter_epochs e WHERE e.statistic_id=x.statistic_id
         AND e.valid_from<h.start_ts+interval '1 hour' AND e.valid_to>h.start_ts)
         OR (NOT EXISTS(SELECT FROM meter_epochs e WHERE e.valid_from<h.start_ts+interval '1 hour' AND e.valid_to>h.start_ts)
           AND x.statistic_id=coalesce(nullif(split_part(p_binding,'|',3),''),d.statistic_id))))
 ), training AS (
  SELECT (q.start_ts AT TIME ZONE 'UTC')::date AS day,
    avg(q.temperature_c)::double precision AS outdoor_c,
    avg(q.energy_kwh*4000)::double precision AS watts,count(*)*0.25 AS hours,
    max(q.changed) AS evidence_updated_at
  FROM quarters q WHERE q.start_ts>=p_from AND q.withdrawn_at IS NULL
  GROUP BY 1,floor(q.temperature_c)
  UNION ALL
  SELECT (h.start_ts AT TIME ZONE 'UTC')::date,h.outdoor_c::double precision,h.watts::double precision,1::numeric,h.changed
  FROM imported h WHERE h.confirmed_at IS NULL AND h.withdrawn_at IS NULL
 ), lost AS (
  SELECT w.start_ts,w.band_c,w.evidence_updated_at AS changed
  FROM withdrawals w WHERE w.band_c IS NOT NULL AND w.start_ts>=p_from
    AND w.start_ts+make_interval(secs=>w.duration_s)<=p_to
  UNION ALL
  SELECT q.start_ts,(floor(q.temperature_c/5)*5)::integer,q.withdrawn_at
  FROM quarters q WHERE q.start_ts>=p_from AND q.withdrawn_at IS NOT NULL
  UNION ALL
  SELECT h.start_ts,(floor(h.outdoor_c/5)*5)::integer,h.changed
  FROM imported h WHERE h.confirmed_at IS NOT NULL OR h.withdrawn_at IS NOT NULL
 ), day_bands AS (
  SELECT * FROM training
  UNION ALL
  SELECT (l.start_ts AT TIME ZONE 'UTC')::date,l.band_c::double precision,NULL::double precision,0::numeric,max(l.changed)
  FROM lost l GROUP BY 1,l.band_c
 )
 SELECT COALESCE(jsonb_agg(to_jsonb(day_bands) ORDER BY day,outdoor_c,watts,hours),'[]'::jsonb)
 FROM day_bands;
$$;

-- Stored warmth uses the same reviewed reliability facts. A rejected counter
-- remains missing, so the existing bounded history estimate can keep planning.
CREATE OR REPLACE FUNCTION public.get_energy_room_planning_history(
  p_customer_id uuid, p_home_id uuid, p_room_keys text[],
  p_from timestamptz, p_to timestamptz
) RETURNS TABLE (room_key text, temperature_starts jsonb, heater_quarters jsonb, outdoor_quarters jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public,private AS $$
  WITH room_devices AS (
    SELECT device.id,device.device_key,device.statistic_id, device.mapping_summary ->> 'room_key' AS room_key
    FROM public.energy_optimisation_devices AS device
    WHERE public.energy_home_matches_customer(p_home_id,p_customer_id)
      AND device.home_id = p_home_id AND device.customer_id = p_customer_id
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
      AND device.mapping_summary ->> 'room_key' = ANY(p_room_keys)
  ), exclusions AS MATERIALIZED (
    SELECT x.* FROM private.energy_heating_meter_exclusions x WHERE x.home_id=p_home_id
      AND x.valid_from<p_to AND x.valid_to>p_from
      AND EXISTS(SELECT FROM room_devices d WHERE d.device_key=x.device_key)
  ), assignments AS MATERIALIZED (
    SELECT h.* FROM private.energy_heating_history_sources h
    JOIN private.energy_heating_history_targets(p_home_id) t ON t.room_key=h.room_key
      AND t.source_key=h.target_source_key AND t.device_statistics=h.target_device_statistics
    WHERE h.home_id=p_home_id AND h.valid_from<p_to AND h.valid_to>p_from
  ), rooms AS (
    SELECT device.room_key, count(*) AS heater_count
    FROM room_devices AS device GROUP BY device.room_key
  ), temperature AS (
    SELECT slot.room_key, jsonb_agg(extract(epoch FROM slot.start_ts) * 1000 ORDER BY slot.start_ts) AS starts
    FROM public.energy_optimisation_thermal_slots AS slot
    JOIN rooms ON rooms.room_key = slot.room_key
    WHERE slot.home_id = p_home_id AND slot.customer_id = p_customer_id
      AND slot.start_ts >= p_from AND slot.start_ts+interval '15 minutes'<=p_to
      AND NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=slot.room_key
        AND h.observed_source_key<>h.target_source_key
        AND h.valid_from<slot.start_ts+interval '15 minutes' AND h.valid_to>slot.start_ts)
    GROUP BY slot.room_key
  ), measured_heater AS (
    SELECT device.room_key,slot.start_ts,
      CASE WHEN EXISTS(SELECT FROM exclusions x WHERE x.device_key=device.device_key
        AND x.valid_from<slot.start_ts+interval '15 minutes' AND x.valid_to>slot.start_ts
        AND (EXISTS(SELECT FROM assignments h WHERE h.room_key=device.room_key
          AND h.observed_device_statistics->>device.device_key=x.statistic_id
          AND h.valid_from<slot.start_ts+interval '15 minutes' AND h.valid_to>slot.start_ts)
          OR (NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=device.room_key
            AND h.valid_from<slot.start_ts+interval '15 minutes' AND h.valid_to>slot.start_ts)
            AND x.statistic_id=device.statistic_id)))
        OR EXISTS(SELECT FROM assignments h WHERE h.room_key=device.room_key
        AND h.valid_from<slot.start_ts+interval '15 minutes' AND h.valid_to>slot.start_ts
        AND (h.valid_from>slot.start_ts OR h.valid_to<slot.start_ts+interval '15 minutes'
          OR h.observed_device_statistics->>device.device_key IS DISTINCT FROM device.statistic_id))
        THEN NULL::numeric
        ELSE least(slot.energy_kwh,(SELECT min((h.heater_energy_limits_w->>device.device_key)::numeric)/4000
          FROM assignments h WHERE h.room_key=device.room_key AND h.valid_from<=slot.start_ts
            AND h.valid_to>=slot.start_ts+interval '15 minutes')) END AS energy_kwh
    FROM public.energy_optimisation_device_slots slot
    JOIN room_devices device ON device.id=slot.device_id
    WHERE slot.home_id=p_home_id AND slot.customer_id=p_customer_id
      AND slot.start_ts>=p_from AND slot.start_ts+interval '15 minutes'<=p_to
  ), heater AS (
    -- Attribution limits apply to each actually measured quarter before the
    -- room sum. Missing meters and mixed source epochs remain unknown; neither
    -- partial-quarter energy nor a reviewed cap is extrapolated into a reading.
    SELECT m.room_key,m.start_ts,sum(m.energy_kwh)*4000 AS watts
    FROM measured_heater m JOIN rooms ON rooms.room_key=m.room_key
    GROUP BY m.room_key,m.start_ts,rooms.heater_count
    HAVING count(m.energy_kwh)=rooms.heater_count
  ), heating AS (
    SELECT heater.room_key, jsonb_agg(jsonb_build_array(extract(epoch FROM heater.start_ts) * 1000, heater.watts)
      ORDER BY heater.start_ts) AS quarters
    FROM heater GROUP BY heater.room_key
  )
  SELECT rooms.room_key, COALESCE(temperature.starts, '[]'::jsonb), COALESCE(heating.quarters, '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_array(extract(epoch FROM o.start_ts)*1000,o.temperature_c) ORDER BY o.start_ts)
      FROM energy_optimisation_outdoor_slots o WHERE o.home_id=p_home_id AND o.customer_id=p_customer_id
        AND o.start_ts>=p_from AND o.start_ts<p_to AND o.temperature_c IS NOT NULL),'[]'::jsonb)
  FROM rooms
  LEFT JOIN temperature USING (room_key)
  LEFT JOIN heating USING (room_key)
  ORDER BY rooms.room_key;
$$;
