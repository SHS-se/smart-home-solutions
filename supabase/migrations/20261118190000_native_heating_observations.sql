-- Learning observations retain Recorder's real interval, separately from
-- quarter-only billing, planning state and electrical actuals.
CREATE TABLE public.energy_heating_observations (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  room_key text NOT NULL,
  source_revision text NOT NULL,
  source_key text NOT NULL,
  device_statistics jsonb NOT NULL,
  start_ts timestamptz NOT NULL,
  duration_s integer NOT NULL CHECK (duration_s IN (900,3600)),
  source text NOT NULL CHECK (source IN ('recorder_5minute_mean','recorder_hour_mean')),
  room_temperature_c double precision,
  outdoor_temperature_c double precision,
  house_temperature_c double precision,
  solar_w_per_m2 double precision,
  device_energy_kwh jsonb NOT NULL,
  heater_energy_limits_w jsonb NOT NULL DEFAULT '{}'::jsonb,
  cooling boolean,
  learning_updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (home_id,room_key,source_revision,start_ts,duration_s),
  CHECK (mod(extract(epoch FROM start_ts)::numeric,duration_s)=0),
  CHECK ((duration_s=900)=(source='recorder_5minute_mean'))
);
CREATE INDEX energy_heating_observations_window ON public.energy_heating_observations(home_id,room_key,start_ts);
ALTER TABLE public.energy_heating_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_heating_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.energy_heating_observations TO service_role;

-- A retained observation ages without becoming new evidence. Advance this
-- clock only when measured fields change, not on identical overlap uploads.
CREATE FUNCTION private.track_heating_evidence_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.learning_updated_at=statement_timestamp();
 ELSIF (to_jsonb(NEW)-ARRAY['learning_updated_at','received_at','device_token_id'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['learning_updated_at','received_at','device_token_id'])
 THEN NEW.learning_updated_at=statement_timestamp();
 ELSE NEW.learning_updated_at=OLD.learning_updated_at;
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.track_heating_evidence_update() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER heating_evidence_updated BEFORE INSERT OR UPDATE ON public.energy_heating_observations
 FOR EACH ROW EXECUTE FUNCTION private.track_heating_evidence_update();
-- Shared native probe facts are stored once per home interval. Inferred stale
-- labels belong to the read-time qualifier, never to this raw evidence table.
CREATE TABLE public.energy_heating_probe_observations (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL,
 start_ts timestamptz NOT NULL,
 duration_s integer NOT NULL CHECK(duration_s IN (900,3600)),
 probes jsonb NOT NULL CHECK(jsonb_typeof(probes)='array'),
 learning_updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(home_id,start_ts,duration_s),
 CHECK(mod(extract(epoch FROM start_ts)::numeric,duration_s)=0),
 CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
ALTER TABLE public.energy_heating_probe_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_heating_probe_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.energy_heating_probe_observations TO service_role;
CREATE TRIGGER heating_probe_evidence_updated BEFORE INSERT OR UPDATE ON public.energy_heating_probe_observations
 FOR EACH ROW EXECUTE FUNCTION private.track_heating_evidence_update();

CREATE FUNCTION private.merge_heating_probe_facts(p_previous jsonb,p_incoming jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,private AS $$
 WITH incoming AS (
  SELECT DISTINCT ON (v->>'source_key') v FROM jsonb_array_elements(p_incoming) WITH ORDINALITY r(v,position)
  ORDER BY v->>'source_key',position DESC
 ), matched AS (
  SELECT n.v AS n,o.v AS o,
   n.v->'mean' IS NOT NULL AND n.v->'mean'<>'null'::jsonb AS measured,
   n.v->'area_key' IS NOT DISTINCT FROM o.v->'area_key' AND
     (n.v->>'cohort_key' IS NULL OR n.v->'cohort_key' IS NOT DISTINCT FROM o.v->'cohort_key') AND
     (n.v->'mean' IS NULL OR n.v->'mean'='null'::jsonb OR n.v->'mean' IS NOT DISTINCT FROM o.v->'mean') AS same
  FROM incoming n LEFT JOIN LATERAL (
   SELECT v FROM jsonb_array_elements(p_previous) r(v) WHERE v->>'source_key'=n.v->>'source_key' LIMIT 1
  ) o ON true
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'source_key',n->'source_key','area_key',n->'area_key',
  'mean',coalesce(nullif(n->'mean','null'::jsonb),o->'mean','null'::jsonb),
  'cohort_key',coalesce(nullif(n->'cohort_key','null'::jsonb),o->'cohort_key'),
  'unchanged',CASE WHEN measured THEN coalesce(nullif(n->'unchanged','null'::jsonb),CASE WHEN same THEN o->'unchanged' END)
    WHEN same THEN o->'unchanged' END,
  'joint_unchanged',CASE WHEN measured THEN coalesce(nullif(n->'joint_unchanged','null'::jsonb),CASE WHEN same THEN o->'joint_unchanged' END)
    WHEN same THEN o->'joint_unchanged' END,
  'reported',coalesce(nullif(n->'reported','null'::jsonb),CASE WHEN same THEN o->'reported' END),
  'unavailable',coalesce(nullif(n->'unavailable','null'::jsonb),CASE WHEN same THEN o->'unavailable' END)
 ) ORDER BY n->>'source_key'),'[]'::jsonb) FROM matched;
$$;
REVOKE ALL ON FUNCTION private.merge_heating_probe_facts(jsonb,jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.record_energy_heating_probe_observations(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE accepted integer;
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Probe observations must be an array'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_rows) r WHERE jsonb_typeof(r->'probes') IS DISTINCT FROM 'array')
 THEN RAISE EXCEPTION 'Probe evidence must be an array'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_rows) r CROSS JOIN LATERAL jsonb_array_elements(r->'probes') p
   WHERE jsonb_typeof(p) IS DISTINCT FROM 'object' OR coalesce(p->>'source_key','')!~'^[0-9a-f]{64}$'
    OR jsonb_typeof(p->'area_key') IS DISTINCT FROM 'string' OR length(p->>'area_key')=0
    OR (p ? 'mean' AND jsonb_typeof(p->'mean') NOT IN ('number','null'))
    OR (p ? 'cohort_key' AND jsonb_typeof(p->'cohort_key') NOT IN ('string','null'))
    OR EXISTS(SELECT FROM unnest(ARRAY['unchanged','joint_unchanged','reported','unavailable']) k
      WHERE p ? k AND jsonb_typeof(p->k) NOT IN ('boolean','null')))
 THEN RAISE EXCEPTION 'Invalid probe evidence'; END IF;
 WITH incoming AS (
  SELECT DISTINCT ON ((r->>'start')::timestamptz,(r->>'duration_s')::integer)
    (r->>'start')::timestamptz AS start_ts,(r->>'duration_s')::integer AS duration_s,r->'probes' AS probes
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY rows(r,position)
  ORDER BY (r->>'start')::timestamptz,(r->>'duration_s')::integer,position DESC
 ), written AS (
  INSERT INTO energy_heating_probe_observations AS prior(home_id,customer_id,start_ts,duration_s,probes)
  SELECT p_home_id,p_customer_id,start_ts,duration_s,private.merge_heating_probe_facts('[]'::jsonb,probes) FROM incoming
  ON CONFLICT(home_id,start_ts,duration_s) DO UPDATE SET
    probes=private.merge_heating_probe_facts(prior.probes,EXCLUDED.probes)
  RETURNING 1
 ) SELECT count(*) INTO accepted FROM written;
 DELETE FROM energy_heating_probe_observations WHERE ctid IN (
  SELECT ctid FROM energy_heating_probe_observations WHERE home_id=p_home_id
   AND start_ts<now()-interval '400 days' ORDER BY start_ts LIMIT 2000 FOR UPDATE SKIP LOCKED);
 RETURN accepted;
END; $$;
REVOKE ALL ON FUNCTION public.record_energy_heating_probe_observations(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_energy_heating_probe_observations(uuid,uuid,jsonb) TO service_role;

-- Existing quarter products remain eligible observations until native capture
-- covers them. Their corrections need the same material-change clock.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['energy_optimisation_thermal_slots','energy_optimisation_outdoor_slots',
   'energy_optimisation_house_slots','energy_optimisation_device_slots'] LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN learning_updated_at timestamptz NOT NULL DEFAULT statement_timestamp()',relation);
  EXECUTE format('CREATE TRIGGER heating_evidence_updated BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.track_heating_evidence_update()',relation);
 END LOOP;
END; $$;

-- This is source identity, not the model's boundary/doorway revision. Changing
-- a doorway does not invalidate measurements from the same thermometer/meter.
CREATE FUNCTION private.energy_heating_observation_sources(p_home_id uuid)
RETURNS TABLE(room_key text,room_name text,source_key text,device_statistics jsonb,active_power_w double precision)
LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT d.mapping_summary->>'room_key',max(d.mapping_summary->>'room_name'),
   p.rooms->(d.mapping_summary->>'room_key')->>'source_key',
   jsonb_object_agg(d.device_key,d.statistic_id),sum(d.active_power_w)::double precision
 FROM energy_optimisation_devices d JOIN energy_room_profiles p USING(home_id)
 WHERE d.home_id=p_home_id AND d.retired_at IS NULL AND d.planning_role_override='controllable'
   AND d.control_type_override IN ('setpoint','switch_schedule') AND d.mapping_status='ready'
   AND d.mapped_control_type=d.control_type_override
 GROUP BY d.mapping_summary->>'room_key',p.rooms
 HAVING bool_and(d.category='heating');
$$;
REVOKE ALL ON FUNCTION private.energy_heating_observation_sources(uuid) FROM PUBLIC,anon,authenticated;

-- Historical room-air contributors can be unheated. A room with an unresolved
-- installed heater is not silently reclassified as an empty meter binding.
CREATE FUNCTION private.energy_heating_history_targets(p_home_id uuid)
RETURNS TABLE(room_key text,source_key text,device_statistics jsonb)
LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT r.key,r.value->>'source_key',coalesce(s.device_statistics,'{}'::jsonb)
 FROM energy_room_profiles p CROSS JOIN LATERAL jsonb_each(p.rooms) r
 LEFT JOIN private.energy_heating_observation_sources(p_home_id) s ON s.room_key=r.key
 WHERE p.home_id=p_home_id AND r.value->>'source_key' ~ '^[0-9a-f]{64}$'
  AND (s.room_key IS NOT NULL OR NOT EXISTS(SELECT FROM energy_optimisation_devices d
    WHERE d.home_id=p_home_id AND d.retired_at IS NULL AND d.category='heating'
      AND d.planning_role_override='controllable' AND d.control_type_override IN ('setpoint','switch_schedule')
      AND d.mapping_summary->>'room_key'=r.key));
$$;
REVOKE ALL ON FUNCTION private.energy_heating_history_targets(uuid) FROM PUBLIC,anon,authenticated;

-- Explicit historical source assignments retain the observed sensor/meter IDs.
-- Only the service role can register reviewed lineage; ordinary uploads cannot
-- assert that a former shared meter or renamed probe is today's physical source.
CREATE TABLE private.energy_heating_history_sources (
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 room_key text NOT NULL,
 target_source_key text NOT NULL,
 target_device_statistics jsonb NOT NULL,
 observed_source_key text NOT NULL,
 observed_temperature_entity_id text NOT NULL,
 heater_energy_limits_w jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(heater_energy_limits_w)='object'),
 observed_device_statistics jsonb NOT NULL,
 valid_from timestamptz NOT NULL,
 valid_to timestamptz NOT NULL CHECK(valid_to>valid_from),
 basis text NOT NULL CHECK(length(basis)>0),
 PRIMARY KEY(home_id,room_key,observed_source_key,valid_from),
 CHECK(observed_source_key=encode(sha256(convert_to(observed_temperature_entity_id,'UTF8')),'hex'))
);
ALTER TABLE private.energy_heating_history_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_heating_history_sources FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.energy_heating_history_sources TO service_role;

-- A room cannot have two competing reviewed identities for the same dates.
CREATE FUNCTION private.validate_heating_history_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF length(NEW.room_key)=0 OR length(NEW.target_source_key)=0 OR length(NEW.observed_temperature_entity_id)=0
   OR NOT isfinite(NEW.valid_from) OR NOT isfinite(NEW.valid_to)
   OR NEW.valid_from<'0001-01-01 00:00:00+00'::timestamptz OR NEW.valid_to>='10000-01-01 00:00:00+00'::timestamptz
 THEN RAISE EXCEPTION 'Invalid historical heating source identity or timestamps'; END IF;
 IF jsonb_typeof(NEW.target_device_statistics) IS DISTINCT FROM 'object'
   OR jsonb_typeof(NEW.observed_device_statistics) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Heating meter source identities must be objects'; END IF;
 IF EXISTS(SELECT FROM jsonb_each(NEW.target_device_statistics) e(k,v)
     WHERE k='' OR jsonb_typeof(v)<>'string' OR v='""'::jsonb)
   OR EXISTS(SELECT FROM jsonb_each(NEW.observed_device_statistics) e(k,v)
     WHERE k='' OR jsonb_typeof(v)<>'string' OR v='""'::jsonb)
 THEN RAISE EXCEPTION 'Heating meter source identities are incomplete'; END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW.target_device_statistics) k)
   IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(NEW.observed_device_statistics) k)
 THEN RAISE EXCEPTION 'Historical meters must name the same devices'; END IF;
 IF jsonb_typeof(NEW.heater_energy_limits_w) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Historical attribution limits must be an object'; END IF;
 IF EXISTS(SELECT FROM jsonb_each(NEW.heater_energy_limits_w) e(k,v)
    WHERE NOT NEW.observed_device_statistics ? k OR jsonb_typeof(v)<>'number'
      OR CASE WHEN jsonb_typeof(v)='number' THEN (v::text)::double precision<=0 OR (v::text)::double precision>='Infinity'::double precision ELSE false END)
 THEN RAISE EXCEPTION 'Historical attribution limits must name measured devices with positive finite watts'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.home_id::text||NEW.room_key,0));
 IF EXISTS(SELECT FROM private.energy_heating_history_sources h
   WHERE h.home_id=NEW.home_id AND h.room_key=NEW.room_key
     AND h.target_source_key=NEW.target_source_key AND h.target_device_statistics=NEW.target_device_statistics
     AND h.valid_from<NEW.valid_to AND h.valid_to>NEW.valid_from
     AND (h.observed_source_key,h.observed_device_statistics,h.heater_energy_limits_w)
       IS DISTINCT FROM (NEW.observed_source_key,NEW.observed_device_statistics,NEW.heater_energy_limits_w)
     AND (TG_OP='INSERT' OR (h.home_id,h.room_key,h.observed_source_key,h.valid_from)
       IS DISTINCT FROM (OLD.home_id,OLD.room_key,OLD.observed_source_key,OLD.valid_from)))
 THEN RAISE EXCEPTION 'Conflicting historical heating source assignments'; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.validate_heating_history_source() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER validate_heating_history_source BEFORE INSERT OR UPDATE ON private.energy_heating_history_sources
 FOR EACH ROW EXECUTE FUNCTION private.validate_heating_history_source();

-- A separate clock survives assignment deletion. Content hashes remain stable
-- on identical rereads, while reviewed identity corrections wake every affected
-- room (including household-temperature contributors).
CREATE TABLE private.energy_heating_source_revisions (
 home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 learning_updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE private.energy_heating_source_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_heating_source_revisions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.energy_heating_source_fingerprint(p_home_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT md5(jsonb_build_array(
  (SELECT coalesce(jsonb_agg(jsonb_build_array(room_key,source_key,device_statistics) ORDER BY room_key),'[]'::jsonb)
    FROM private.energy_heating_history_targets(p_home_id)),
  (SELECT coalesce(jsonb_agg(to_jsonb(h)-ARRAY['home_id','basis'] ORDER BY room_key,valid_from,valid_to,observed_source_key),'[]'::jsonb)
    FROM private.energy_heating_history_sources h WHERE home_id=p_home_id)
 )::text);
$$;
REVOKE ALL ON FUNCTION private.energy_heating_source_fingerprint(uuid) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.track_heating_source_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE home uuid; signature text;
BEGIN
 FOR home IN SELECT DISTINCT id FROM unnest(ARRAY[
   CASE WHEN TG_OP<>'INSERT' THEN OLD.home_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.home_id END]) id
   WHERE id IS NOT NULL LOOP
  IF NOT EXISTS(SELECT FROM homes WHERE id=home) THEN CONTINUE; END IF;
  signature:=private.energy_heating_source_fingerprint(home);
  INSERT INTO private.energy_heating_source_revisions AS prior(home_id,fingerprint)
   VALUES(home,signature)
  ON CONFLICT(home_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,learning_updated_at=greatest(prior.learning_updated_at,statement_timestamp())
   WHERE prior.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint;
 END LOOP;
 RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION private.track_heating_source_revision() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER heating_source_revision AFTER INSERT OR UPDATE OR DELETE ON private.energy_heating_history_sources
 FOR EACH ROW EXECUTE FUNCTION private.track_heating_source_revision();
CREATE TRIGGER heating_source_revision AFTER INSERT OR UPDATE OR DELETE ON public.energy_room_profiles
 FOR EACH ROW EXECUTE FUNCTION private.track_heating_source_revision();
CREATE TRIGGER heating_source_revision AFTER INSERT OR UPDATE OR DELETE ON public.energy_optimisation_devices
 FOR EACH ROW EXECUTE FUNCTION private.track_heating_source_revision();

CREATE FUNCTION public.get_energy_heating_history_sources(p_home_id uuid,p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE assignments jsonb;
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'room_key',h.room_key,'target_source_key',h.target_source_key,'target_device_statistics',h.target_device_statistics,
   'observed_source_key',h.observed_source_key,'observed_temperature_entity_id',h.observed_temperature_entity_id,
   'observed_device_statistics',h.observed_device_statistics,'valid_from',h.valid_from,'valid_to',h.valid_to,
   'heater_energy_limits_w',h.heater_energy_limits_w
 ) ORDER BY h.room_key,h.valid_from,h.valid_to,h.observed_source_key),'[]'::jsonb) INTO assignments
 FROM private.energy_heating_history_sources h
 JOIN private.energy_heating_history_targets(p_home_id) s ON s.room_key=h.room_key
   AND s.source_key=h.target_source_key AND s.device_statistics=h.target_device_statistics
 WHERE h.home_id=p_home_id;
 RETURN jsonb_build_object('revision',md5(assignments::text),'assignments',assignments);
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_heating_history_sources(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_heating_history_sources(uuid,uuid) TO service_role;

CREATE FUNCTION private.energy_heating_source_matches(
 p_home uuid,p_room text,p_observed_source text,p_observed_meters jsonb,
 p_target_source text,p_target_meters jsonb,p_start timestamptz,p_duration integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,private AS $$
 -- A reviewed historical assignment is authoritative for its dated interval.
 -- A current-source backfill cannot also inject a second observation there.
 SELECT (p_observed_source=p_target_source AND p_observed_meters=p_target_meters AND NOT EXISTS (
  SELECT FROM private.energy_heating_history_sources h WHERE h.home_id=p_home AND h.room_key=p_room
    AND h.target_source_key=p_target_source AND h.target_device_statistics=p_target_meters
    AND p_start<h.valid_to AND p_start+make_interval(secs=>p_duration)>h.valid_from
 )) OR EXISTS (
  SELECT FROM private.energy_heating_history_sources h WHERE h.home_id=p_home AND h.room_key=p_room
    AND h.observed_source_key=p_observed_source AND h.observed_device_statistics=p_observed_meters
    AND h.target_source_key=p_target_source AND h.target_device_statistics=p_target_meters
    AND p_start>=h.valid_from AND p_start+make_interval(secs=>p_duration)<=h.valid_to
 );
$$;
REVOKE ALL ON FUNCTION private.energy_heating_source_matches(uuid,text,text,jsonb,text,jsonb,timestamptz,integer) FROM PUBLIC,anon,authenticated;

-- Running draw has narrower evidence than the room fit. Only the explicitly
-- heating quarter and reviewed hourly running estimates are admitted. Track the
-- columns that affect that question, so e.g. irradiance backfill does not refit it.
ALTER TABLE public.energy_optimisation_device_slots
 ADD COLUMN weather_heating_updated_at timestamptz NOT NULL DEFAULT statement_timestamp();
ALTER TABLE public.energy_optimisation_outdoor_slots
 ADD COLUMN weather_heating_updated_at timestamptz NOT NULL DEFAULT statement_timestamp();
ALTER TABLE private.energy_weather_heating_hourly_imports
 ADD COLUMN weather_heating_updated_at timestamptz NOT NULL DEFAULT statement_timestamp();

CREATE TABLE private.energy_weather_heating_withdrawals (
 device_id uuid NOT NULL,
 home_id uuid NOT NULL,
 customer_id uuid NOT NULL,
 binding text NOT NULL,
 start_ts timestamptz NOT NULL,
 duration_s integer NOT NULL,
 -- A NULL band withdraws a specific meter reading. Its outdoor reading can
 -- arrive later. A known band records a sample that left that old band.
 band_c integer,
 evidence_updated_at timestamptz NOT NULL,
 UNIQUE NULLS NOT DISTINCT (device_id,binding,start_ts,duration_s,band_c),
 FOREIGN KEY (device_id,home_id,customer_id)
   REFERENCES public.energy_optimisation_devices(id,home_id,customer_id) ON DELETE CASCADE
);
CREATE INDEX energy_weather_heating_withdrawals_retention ON private.energy_weather_heating_withdrawals(home_id,start_ts);
ALTER TABLE private.energy_weather_heating_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_weather_heating_withdrawals FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.track_weather_heating_quarter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE changed timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='INSERT' THEN NEW.weather_heating_updated_at=changed; RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.energy_kwh,NEW.quality->>'weather_heating_binding')
    IS NOT DISTINCT FROM (OLD.energy_kwh,OLD.quality->>'weather_heating_binding') THEN
   NEW.weather_heating_updated_at=OLD.weather_heating_updated_at; RETURN NEW;
  END IF;
  NEW.weather_heating_updated_at=changed;
 END IF;
 -- Actual-slot energy is NOT NULL. Explicitly untrusted readings that leave the
 -- accounting row intact are withdrawn by retract_weather_heating_meter.
 IF OLD.energy_kwh>0 AND OLD.quality->>'weather_heating_binding' IS NOT NULL
   AND OLD.start_ts>=changed-interval '400 days'
   AND (TG_OP='DELETE' OR NEW.energy_kwh<=0 OR
     NEW.quality->>'weather_heating_binding' IS DISTINCT FROM OLD.quality->>'weather_heating_binding') THEN
  INSERT INTO private.energy_weather_heating_withdrawals
  SELECT OLD.device_id,OLD.home_id,OLD.customer_id,OLD.quality->>'weather_heating_binding',
    OLD.start_ts,900,(floor(o.temperature_c/5)*5)::integer,changed
  FROM energy_optimisation_outdoor_slots o JOIN energy_optimisation_devices d
    ON d.id=OLD.device_id AND d.home_id=o.home_id AND d.customer_id=o.customer_id
  WHERE o.home_id=OLD.home_id AND o.customer_id=OLD.customer_id AND o.start_ts=OLD.start_ts
    AND o.temperature_c IS NOT NULL
  ON CONFLICT (device_id,binding,start_ts,duration_s,band_c) DO UPDATE SET
    evidence_updated_at=greatest(energy_weather_heating_withdrawals.evidence_updated_at,EXCLUDED.evidence_updated_at);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

CREATE FUNCTION private.track_weather_heating_outdoor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE changed timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='INSERT' THEN NEW.weather_heating_updated_at=changed; RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.temperature_c IS NOT DISTINCT FROM OLD.temperature_c THEN
   NEW.weather_heating_updated_at=OLD.weather_heating_updated_at; RETURN NEW;
  END IF;
  NEW.weather_heating_updated_at=changed;
 END IF;
 IF OLD.temperature_c IS NOT NULL AND OLD.start_ts>=changed-interval '400 days'
   AND (TG_OP='DELETE' OR floor(NEW.temperature_c/5) IS DISTINCT FROM floor(OLD.temperature_c/5)) THEN
  INSERT INTO private.energy_weather_heating_withdrawals
  SELECT s.device_id,s.home_id,s.customer_id,s.quality->>'weather_heating_binding',
    s.start_ts,900,(floor(OLD.temperature_c/5)*5)::integer,changed
  FROM energy_optimisation_device_slots s JOIN energy_optimisation_devices d
    ON d.id=s.device_id AND d.home_id=s.home_id AND d.customer_id=s.customer_id
  WHERE s.home_id=OLD.home_id AND s.customer_id=OLD.customer_id AND s.start_ts=OLD.start_ts
    AND s.energy_kwh>0 AND s.quality->>'weather_heating_binding' IS NOT NULL
  ON CONFLICT (device_id,binding,start_ts,duration_s,band_c) DO UPDATE SET
    evidence_updated_at=greatest(energy_weather_heating_withdrawals.evidence_updated_at,EXCLUDED.evidence_updated_at);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

CREATE FUNCTION private.track_weather_heating_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE changed timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='INSERT' THEN NEW.weather_heating_updated_at=changed; RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.binding,NEW.outdoor_c,NEW.watts) IS NOT DISTINCT FROM (OLD.binding,OLD.outdoor_c,OLD.watts) THEN
   NEW.weather_heating_updated_at=OLD.weather_heating_updated_at; RETURN NEW;
  END IF;
  NEW.weather_heating_updated_at=changed;
 END IF;
 IF OLD.start_ts>=changed-interval '400 days'
   AND (TG_OP='DELETE' OR NEW.binding IS DISTINCT FROM OLD.binding OR
     floor(NEW.outdoor_c/5) IS DISTINCT FROM floor(OLD.outdoor_c/5)) THEN
  INSERT INTO private.energy_weather_heating_withdrawals
  SELECT OLD.device_id,OLD.home_id,OLD.customer_id,OLD.binding,OLD.start_ts,3600,
    (floor(OLD.outdoor_c/5)*5)::integer,changed
  FROM energy_optimisation_devices d
  WHERE d.id=OLD.device_id AND d.home_id=OLD.home_id AND d.customer_id=OLD.customer_id
  ON CONFLICT (device_id,binding,start_ts,duration_s,band_c) DO UPDATE SET
    evidence_updated_at=greatest(energy_weather_heating_withdrawals.evidence_updated_at,EXCLUDED.evidence_updated_at);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION private.track_weather_heating_quarter(),private.track_weather_heating_outdoor(),
 private.track_weather_heating_import() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER weather_heating_evidence_updated BEFORE INSERT OR UPDATE OR DELETE ON public.energy_optimisation_device_slots
 FOR EACH ROW EXECUTE FUNCTION private.track_weather_heating_quarter();
CREATE TRIGGER weather_heating_evidence_updated BEFORE INSERT OR UPDATE OR DELETE ON public.energy_optimisation_outdoor_slots
 FOR EACH ROW EXECUTE FUNCTION private.track_weather_heating_outdoor();
CREATE TRIGGER weather_heating_evidence_updated BEFORE INSERT OR UPDATE OR DELETE ON private.energy_weather_heating_hourly_imports
 FOR EACH ROW EXECUTE FUNCTION private.track_weather_heating_import();

-- Retracting a native counter removes an older electrical sample only when the
-- device, exact meter and room source agree. Preserve the accounting row.
CREATE FUNCTION private.retract_weather_heating_meter(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS void LANGUAGE sql SET search_path=public,private AS $$
 WITH meters AS MATERIALIZED (
  SELECT DISTINCT d.id,d.statistic_id,r.start AS begins,r.start+make_interval(secs=>r.duration_s) AS ends
  FROM jsonb_to_recordset(p_rows) r(room_key text,source_key text,device_statistics jsonb,start timestamptz,
    duration_s integer,invalidated_device_keys text[])
  CROSS JOIN LATERAL unnest(r.invalidated_device_keys) k(device_key)
  JOIN energy_optimisation_devices d ON d.home_id=p_home_id AND d.customer_id=p_customer_id
    AND d.device_key=k.device_key AND d.statistic_id=r.device_statistics->>k.device_key AND d.retired_at IS NULL
  JOIN private.energy_heating_observation_sources(p_home_id) s ON s.room_key=r.room_key
    AND s.device_statistics->>k.device_key=d.statistic_id
    AND private.energy_heating_source_matches(p_home_id,r.room_key,r.source_key,r.device_statistics,
      s.source_key,s.device_statistics,r.start,r.duration_s)
 ), samples AS (
  SELECT q.device_id,q.quality->>'weather_heating_binding' AS binding,q.start_ts,900 AS duration_s,
    q.weather_heating_updated_at AS sample_updated_at
  FROM meters m JOIN energy_optimisation_device_slots q ON q.device_id=m.id
    AND q.start_ts>=m.begins AND q.start_ts<m.ends
  WHERE q.energy_kwh>0 AND split_part(q.quality->>'weather_heating_binding','|',3)=m.statistic_id
  UNION ALL
  SELECT h.device_id,h.binding,h.start_ts,3600,h.weather_heating_updated_at
  FROM meters m JOIN private.energy_weather_heating_hourly_imports h ON h.device_id=m.id
    AND h.start_ts>=date_trunc('hour',m.begins,'UTC') AND h.start_ts<m.ends
  WHERE split_part(h.binding,'|',3)=m.statistic_id
 )
 INSERT INTO private.energy_weather_heating_withdrawals AS prior
 SELECT DISTINCT s.device_id,p_home_id,p_customer_id,s.binding,s.start_ts,s.duration_s,NULL::integer,statement_timestamp()
 FROM samples s
 WHERE NOT EXISTS(SELECT FROM private.energy_weather_heating_withdrawals w WHERE w.device_id=s.device_id
   AND w.binding=s.binding AND w.start_ts=s.start_ts AND w.duration_s=s.duration_s
   AND w.band_c IS NULL AND w.evidence_updated_at>=s.sample_updated_at)
 ON CONFLICT (device_id,binding,start_ts,duration_s,band_c) DO UPDATE SET
   evidence_updated_at=greatest(prior.evidence_updated_at,EXCLUDED.evidence_updated_at);
$$;
REVOKE ALL ON FUNCTION private.retract_weather_heating_meter(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.record_energy_heating_observations(p_home_id uuid,p_customer_id uuid,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE accepted jsonb;
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 PERFORM private.retract_weather_heating_meter(p_home_id,p_customer_id,p_rows)
 WHERE EXISTS (SELECT FROM jsonb_array_elements(p_rows) r
   WHERE jsonb_array_length(r->'invalidated_device_keys')>0);
 -- An explicit counter retraction invalidates overlapping finer/coarser records
 -- from that same physical source. Missing raw history alone never retracts data.
 WITH retractions AS (
   SELECT n.home_id,n.room_key,n.source_revision,n.start_ts,n.duration_s,
     array_agg(DISTINCT k.device_key) AS invalidated_device_keys
   FROM energy_heating_observations n
   JOIN jsonb_to_recordset(p_rows) AS r(room_key text,source_key text,device_statistics jsonb,
     start timestamptz,duration_s integer,invalidated_device_keys text[])
     ON n.room_key=r.room_key AND n.source_key=r.source_key AND n.device_statistics=r.device_statistics
       AND n.start_ts<r.start+make_interval(secs=>r.duration_s)
       AND n.start_ts+make_interval(secs=>n.duration_s)>r.start
   CROSS JOIN LATERAL unnest(r.invalidated_device_keys) k(device_key)
   WHERE n.home_id=p_home_id AND n.customer_id=p_customer_id
   GROUP BY n.home_id,n.room_key,n.source_revision,n.start_ts,n.duration_s
 )
 UPDATE energy_heating_observations n SET device_energy_kwh=n.device_energy_kwh-r.invalidated_device_keys
 FROM retractions r WHERE (n.home_id,n.room_key,n.source_revision,n.start_ts,n.duration_s)
   =(r.home_id,r.room_key,r.source_revision,r.start_ts,r.duration_s);
 WITH written AS (INSERT INTO energy_heating_observations AS prior (home_id,customer_id,room_key,source_revision,source_key,
   device_statistics,start_ts,duration_s,source,room_temperature_c,outdoor_temperature_c,house_temperature_c,
   solar_w_per_m2,device_energy_kwh,heater_energy_limits_w,cooling)
 SELECT p_home_id,p_customer_id,r.room_key,md5(jsonb_build_array(r.source_key,r.device_statistics)::text),
   r.source_key,r.device_statistics,r.start,r.duration_s,r.source,r.room_temperature_c,
   r.outdoor_temperature_c,r.house_temperature_c,r.solar_w_per_m2,
   jsonb_strip_nulls(r.device_energy_kwh)-coalesce(r.invalidated_device_keys,ARRAY[]::text[]),
   coalesce(r.heater_energy_limits_w,'{}'::jsonb),r.cooling
 FROM jsonb_to_recordset(p_rows) AS r(room_key text,source_key text,device_statistics jsonb,
   start timestamptz,duration_s integer,source text,room_temperature_c double precision,
   outdoor_temperature_c double precision,house_temperature_c double precision,solar_w_per_m2 double precision,
   device_energy_kwh jsonb,heater_energy_limits_w jsonb,cooling boolean,invalidated_device_keys text[])
 JOIN private.energy_heating_observation_sources(p_home_id) s ON s.room_key=r.room_key
   -- Accept current-source raw captures even where a reviewed historic source
   -- owns learning. Their source identity stays intact and the learning read
   -- excludes them; ordinary historical backfill must not retry them forever.
   AND ((r.source_key=s.source_key AND r.device_statistics=s.device_statistics) OR
     private.energy_heating_source_matches(p_home_id,r.room_key,r.source_key,r.device_statistics,
       s.source_key,s.device_statistics,r.start,r.duration_s))
 ON CONFLICT (home_id,room_key,source_revision,start_ts,duration_s) DO UPDATE SET
   room_temperature_c=coalesce(EXCLUDED.room_temperature_c,prior.room_temperature_c),
   outdoor_temperature_c=coalesce(EXCLUDED.outdoor_temperature_c,prior.outdoor_temperature_c),
   house_temperature_c=coalesce(EXCLUDED.house_temperature_c,prior.house_temperature_c),
   solar_w_per_m2=coalesce(EXCLUDED.solar_w_per_m2,prior.solar_w_per_m2),
   -- Unavailable rereads preserve known measurements. Explicit cleaner
   -- retractions above remove untrusted keys, including overlapping resolutions.
   device_energy_kwh=prior.device_energy_kwh||EXCLUDED.device_energy_kwh,
   -- This is the complete selected-source attribution map, not additive facts.
   heater_energy_limits_w=EXCLUDED.heater_energy_limits_w,
   cooling=coalesce(EXCLUDED.cooling,prior.cooling)
 RETURNING room_key,source_key)
 SELECT jsonb_build_object('accepted',coalesce(sum(n),0),'accepted_by_source',
   coalesce(jsonb_agg(jsonb_build_object('room_key',room_key,'source_key',source_key,'accepted',n)),'[]'::jsonb))
 INTO accepted FROM (SELECT room_key,source_key,count(*) AS n FROM written GROUP BY room_key,source_key) counts;
 -- Bounded retention, independent of model revisions and ordinary actuals.
 DELETE FROM energy_heating_observations WHERE ctid IN (
   SELECT ctid FROM energy_heating_observations WHERE home_id=p_home_id
     AND start_ts<now()-interval '400 days' ORDER BY start_ts LIMIT 2000 FOR UPDATE SKIP LOCKED);
 DELETE FROM private.energy_weather_heating_withdrawals WHERE ctid IN (
   SELECT ctid FROM private.energy_weather_heating_withdrawals WHERE home_id=p_home_id
     AND start_ts<now()-interval '400 days' ORDER BY start_ts LIMIT 1000 FOR UPDATE SKIP LOCKED);
 RETURN accepted;
END;
$$;
REVOKE ALL ON FUNCTION public.record_energy_heating_observations(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_energy_heating_observations(uuid,uuid,jsonb) TO service_role;


-- Keep the existing all-room API as a transport wrapper around one canonical
-- query. Heating workers pass their room into that query before any scans.
CREATE FUNCTION private.energy_room_training_quarters(
  p_customer_id uuid,
  p_home_id uuid,
  p_room_key text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  room_key text,
  room_name text,
  active_power_w double precision,
  start_ts timestamptz,
  room_temperature_c double precision,
  cooling boolean,
  outdoor_temperature_c double precision,
  solar_w_per_m2 double precision,
  house_temperature_c double precision,
  heat_w double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
    AND (NOT public.can_access_energy_billing_customer(p_customer_id)
      OR NOT public.energy_home_matches_customer(p_home_id, p_customer_id))
  THEN
    RAISE EXCEPTION 'Home not found or access denied';
  END IF;

  RETURN QUERY
  WITH room_devices AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      max(device.mapping_summary ->> 'room_name') AS room_name,
      sum(COALESCE(device.active_power_w, 0)) AS active_power_w,
      count(*) AS required_device_count
    FROM public.energy_optimisation_devices AS device
    WHERE device.home_id = p_home_id
      AND device.customer_id = p_customer_id
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
      AND (p_room_key IS NULL OR device.mapping_summary ->> 'room_key' = p_room_key)
    GROUP BY device.mapping_summary ->> 'room_key'
  ),
  room_energy AS (
    SELECT
      device.mapping_summary ->> 'room_key' AS room_key,
      energy.start_ts,
      sum(energy.energy_kwh) AS energy_kwh,
      count(DISTINCT device.id) FILTER (WHERE energy.energy_kwh IS NOT NULL) AS observed_device_count
    FROM public.energy_optimisation_device_slots AS energy
    JOIN public.energy_optimisation_devices AS device
      ON device.id = energy.device_id
    WHERE energy.home_id = p_home_id
      AND energy.customer_id = p_customer_id
      AND energy.start_ts >= p_from
      AND energy.start_ts < p_to
      AND device.retired_at IS NULL
      AND device.planning_role_override = 'controllable'
      AND device.control_type_override IN ('setpoint', 'switch_schedule')
      AND device.mapping_status = 'ready'
      AND device.mapped_control_type = device.control_type_override
      AND jsonb_typeof(device.mapping_summary -> 'room_key') = 'string'
      AND jsonb_typeof(device.mapping_summary -> 'room_name') = 'string'
      AND (p_room_key IS NULL OR device.mapping_summary ->> 'room_key' = p_room_key)
    GROUP BY device.mapping_summary ->> 'room_key', energy.start_ts
  )
  SELECT
    slot.room_key,
    room.room_name,
    room.active_power_w::double precision,
    slot.start_ts,
    slot.room_temperature_c::double precision,
    slot.cooling_duty > 0,
    outdoor.temperature_c::double precision,
    outdoor.solar_w_per_m2::double precision,
    house.temperature_c::double precision,
    (CASE WHEN energy.observed_device_count = room.required_device_count
      THEN energy.energy_kwh * 4000.0 ELSE NULL END)::double precision
  FROM public.energy_optimisation_thermal_slots AS slot
  JOIN room_devices AS room ON room.room_key = slot.room_key
  LEFT JOIN public.energy_optimisation_outdoor_slots AS outdoor
    ON outdoor.home_id = slot.home_id AND outdoor.start_ts = slot.start_ts
  LEFT JOIN public.energy_optimisation_house_slots AS house
    ON house.home_id = slot.home_id AND house.start_ts = slot.start_ts
  LEFT JOIN room_energy AS energy
    ON energy.room_key = slot.room_key AND energy.start_ts = slot.start_ts
  WHERE slot.home_id = p_home_id
    AND slot.customer_id = p_customer_id
    AND (p_room_key IS NULL OR slot.room_key = p_room_key)
    AND slot.start_ts >= p_from
    AND slot.start_ts < p_to
  ORDER BY slot.room_key, slot.start_ts;
END;
$$;

REVOKE ALL ON FUNCTION private.energy_room_training_quarters(uuid,uuid,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.get_energy_thermal_training_quarters(
 p_customer_id uuid,p_home_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE (
  room_key text,
  room_name text,
  active_power_w double precision,
  start_ts timestamptz,
  room_temperature_c double precision,
  cooling boolean,
  outdoor_temperature_c double precision,
  solar_w_per_m2 double precision,
  house_temperature_c double precision,
  heat_w double precision
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 SELECT * FROM private.energy_room_training_quarters(p_customer_id,p_home_id,NULL,p_from,p_to);
$$;

CREATE FUNCTION public.get_energy_room_thermal_intervals(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(room_key text,room_name text,active_power_w double precision,start_ts timestamptz,
 room_temperature_c double precision,cooling boolean,outdoor_temperature_c double precision,
 solar_w_per_m2 double precision,house_temperature_c double precision,heat_w double precision,
 duration_s integer,source text,heat_attributed boolean,temperature_source_key text,probe_evidence jsonb)
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
 ), probe_vectors AS MATERIALIZED (
   -- Qualify source epochs at read time. Raw vectors remain intact so a reviewed
   -- correction or a later complete capture can repair every dependent room.
   SELECT p.start_ts,p.duration_s,p.probes AS raw_probes,
     (SELECT coalesce(jsonb_agg(v ORDER BY position),'[]'::jsonb)
      FROM jsonb_array_elements(p.probes) WITH ORDINALITY facts(v,position)
      JOIN peers t ON t.room_key=v->>'area_key'
      WHERE (
       NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=t.room_key
         AND h.valid_from<p.start_ts+make_interval(secs=>p.duration_s) AND h.valid_to>p.start_ts)
       AND (t.source_key IS NULL OR v->>'source_key'=t.source_key)
      ) OR (
       EXISTS(SELECT FROM assignments h WHERE h.room_key=t.room_key AND h.observed_source_key=v->>'source_key'
         AND h.valid_from<=p.start_ts AND h.valid_to>=p.start_ts+make_interval(secs=>p.duration_s))
       AND NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=t.room_key
         AND h.valid_from<p.start_ts+make_interval(secs=>p.duration_s) AND h.valid_to>p.start_ts
         AND (h.valid_from>p.start_ts OR h.valid_to<p.start_ts+make_interval(secs=>p.duration_s)))
      )) AS probes
   FROM energy_heating_probe_observations p
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
     CASE WHEN p.raw_probes IS DISTINCT FROM p.probes OR EXISTS(
       SELECT FROM assignments h WHERE h.observed_source_key<>h.target_source_key
         AND h.valid_from<n.start_ts+make_interval(secs=>n.duration_s) AND h.valid_to>n.start_ts
         AND NOT EXISTS(SELECT FROM jsonb_array_elements(p.probes) v
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
     n.source_key AS temperature_source_key,p.probes AS probe_evidence
   FROM energy_heating_observations n JOIN sources s ON s.room_key=n.room_key
     AND private.energy_heating_source_matches(p_home_id,n.room_key,n.source_key,n.device_statistics,
       s.source_key,s.device_statistics,n.start_ts,n.duration_s)
   LEFT JOIN LATERAL (
     SELECT h.heater_energy_limits_w FROM private.energy_heating_history_sources h
     WHERE h.home_id=n.home_id AND h.room_key=n.room_key
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
 ), fine AS MATERIALIZED (
   SELECT * FROM native WHERE duration_s=900
   UNION ALL
   SELECT q.room_key,q.room_name,q.active_power_w,q.start_ts,q.room_temperature_c,q.cooling,
     q.outdoor_temperature_c,q.solar_w_per_m2,
     CASE WHEN p.raw_probes IS DISTINCT FROM p.probes OR EXISTS(SELECT FROM assignments h WHERE h.observed_source_key<>h.target_source_key
       AND h.valid_from<q.start_ts+interval '15 minutes' AND h.valid_to>q.start_ts)
       THEN NULL::double precision ELSE q.house_temperature_c END,
     q.heat_w,900,'recorder_5minute_mean'::text,false,s.source_key,p.probes
   FROM private.energy_room_training_quarters(p_customer_id,p_home_id,p_room_key,p_from,p_to) q
   JOIN sources s USING(room_key)
   LEFT JOIN probe_vectors p ON p.start_ts=q.start_ts AND p.duration_s=900
   CROSS JOIN legacy_since l
   WHERE public.energy_home_matches_customer(p_home_id,p_customer_id)
     AND (l.at IS NULL OR q.start_ts>=l.at)
     AND NOT EXISTS(SELECT FROM assignments h WHERE h.room_key=q.room_key
       AND h.valid_from<q.start_ts+interval '15 minutes' AND h.valid_to>q.start_ts)
     AND NOT EXISTS (SELECT FROM native n WHERE n.room_key=q.room_key AND q.start_ts>=n.start_ts
     AND q.start_ts<n.start_ts+make_interval(secs=>n.duration_s))
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
REVOKE ALL ON FUNCTION public.get_energy_room_thermal_intervals(uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_thermal_intervals(uuid,uuid,text,timestamptz,timestamptz) TO service_role;

-- Transport one source dictionary per bounded capture chunk. The canonical
-- interval reader remains the sole owner of lineage and resolution selection.
CREATE FUNCTION public.get_energy_room_thermal_interval_capture(
 p_customer_id uuid,p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH raw AS MATERIALIZED (
  SELECT * FROM get_energy_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to)
 ), descriptions AS (
  SELECT DISTINCT jsonb_build_object('source_key',p->'source_key','area_key',p->'area_key','cohort_key',p->'cohort_key') AS value
  FROM raw CROSS JOIN LATERAL jsonb_array_elements(raw.probe_evidence) p
 ), sources AS MATERIALIZED (
  SELECT value,row_number() OVER(ORDER BY value->>'source_key',value->>'area_key',value->>'cohort_key')-1 AS id FROM descriptions
 ), encoded AS (
  SELECT r.start_ts,r.duration_s,(to_jsonb(r)-'probe_evidence') || jsonb_build_object('probe_values',
    CASE WHEN r.probe_evidence IS NULL THEN NULL ELSE (
      SELECT coalesce(jsonb_agg(jsonb_build_array(s.id,p->'mean',
        CASE p->>'unchanged' WHEN 'false' THEN 1 WHEN 'true' THEN 2 ELSE 0 END +
        CASE p->>'joint_unchanged' WHEN 'false' THEN 4 WHEN 'true' THEN 8 ELSE 0 END +
        CASE p->>'reported' WHEN 'false' THEN 16 WHEN 'true' THEN 32 ELSE 0 END +
        CASE p->>'unavailable' WHEN 'false' THEN 64 WHEN 'true' THEN 128 ELSE 0 END
      ) ORDER BY s.id),'[]'::jsonb)
      FROM jsonb_array_elements(r.probe_evidence) p JOIN sources s ON s.value=jsonb_build_object(
        'source_key',p->'source_key','area_key',p->'area_key','cohort_key',p->'cohort_key')
    ) END) AS value FROM raw r
 )
 SELECT jsonb_build_object(
  'sources',(SELECT coalesce(jsonb_agg(value ORDER BY id),'[]'::jsonb) FROM sources),
  'rows',(SELECT coalesce(jsonb_agg(value ORDER BY start_ts,duration_s),'[]'::jsonb) FROM encoded));
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_thermal_interval_capture(uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_thermal_interval_capture(uuid,uuid,text,timestamptz,timestamptz) TO service_role;

DROP FUNCTION public.get_energy_room_planning_history(uuid,uuid,text[],timestamptz,timestamptz);
CREATE FUNCTION public.get_energy_room_planning_history(
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
      CASE WHEN EXISTS(SELECT FROM assignments h WHERE h.room_key=device.room_key
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
REVOKE ALL ON FUNCTION public.get_energy_room_planning_history(uuid,uuid,text[],timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_planning_history(uuid,uuid,text[],timestamptz,timestamptz)
  TO service_role;

DROP FUNCTION public.get_energy_room_heating_band_history(uuid,text,timestamptz,timestamptz);
CREATE FUNCTION public.get_energy_room_heating_band_history(
 p_home_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(band_c integer,last_at timestamptz,end_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 SELECT (floor(q.outdoor_temperature_c/5)*5)::integer,max(q.start_ts),
   max(q.start_ts+make_interval(secs=>q.duration_s))
 FROM homes h CROSS JOIN LATERAL get_energy_room_thermal_intervals(h.customer_id,h.id,p_room_key,p_from,p_to) q
 WHERE h.id=p_home_id AND q.room_key=p_room_key AND q.heat_w>0
   AND q.room_temperature_c IS NOT NULL AND q.outdoor_temperature_c IS NOT NULL AND q.cooling=false
 GROUP BY floor(q.outdoor_temperature_c/5);
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_heating_band_history(uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_heating_band_history(uuid,text,timestamptz,timestamptz) TO service_role;

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
    SELECT min(n.start_ts) AS first_at FROM energy_heating_observations n
    JOIN private.energy_heating_observation_sources(p_home_id) src ON src.room_key=n.room_key
      AND private.energy_heating_source_matches(p_home_id,n.room_key,n.source_key,n.device_statistics,
        src.source_key,src.device_statistics,n.start_ts,n.duration_s)
    WHERE p_history AND n.home_id=p_home_id AND n.room_key=g.room_key
  ) native ON true;
$$;

-- Preserve the reviewed hourly provenance and the measured heating-only
-- quarter. Native room-energy means alone cannot establish running watts.
CREATE OR REPLACE FUNCTION public.get_energy_weather_heating_days(
 p_home_id uuid,p_customer_id uuid,p_device_key text,p_binding text,p_from timestamptz,p_to timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH owner AS (
  SELECT id,home_id,customer_id FROM energy_optimisation_devices
  WHERE home_id=p_home_id AND customer_id=p_customer_id AND device_key=p_device_key AND retired_at IS NULL
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
REVOKE ALL ON FUNCTION public.get_energy_weather_heating_days(uuid,uuid,text,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_weather_heating_days(uuid,uuid,text,text,timestamptz,timestamptz)
 TO service_role;

CREATE OR REPLACE FUNCTION public.request_energy_device_learning(p_home_id uuid,p_customer_id uuid,p_owners jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE o jsonb; v_id uuid; n integer:=0; due boolean; heating_bindings jsonb;
BEGIN
  IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
  IF jsonb_typeof(p_owners) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid learning owners'; END IF;
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
      SELECT coalesce((heating_bands->>'pending_windows')::integer,0)>0
        OR last_attempted_at IS NULL OR last_attempted_at < now()-CASE
          WHEN trained AND (heating_bands IS NULL OR heating_bands->>'reference_revision' IS NOT NULL)
          THEN interval '24 hours' ELSE interval '1 hour' END
        OR (heating_bindings ? (o->>'key') AND heating_bands IS NOT NULL
          AND heating_bands->>'binding' IS DISTINCT FROM heating_bindings->>(o->>'key'))
        OR (trained AND (heating_bands->>'reference_revision' IS NULL OR NOT (heating_bindings ? (o->>'key')))
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
        OR (o->'input'->>'weather_heating_binding' IS NOT NULL AND (
          operating_points->>'binding' IS DISTINCT FROM o->'input'->>'weather_heating_binding'
          OR (o->'input'->'banded_heating'='true'::jsonb
            AND jsonb_typeof(operating_points->'versioned'->'pending_bands')='number'
            AND (operating_points->'versioned'->>'pending_bands')::numeric>0)))
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

-- Pool retained, source-qualified observations independently per weather band.
-- Expiring old rows changes the fingerprint but does not advance evidence time;
-- retention alone must never replace an accepted winter model.
CREATE FUNCTION public.get_energy_room_heating_fit_windows(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(window_key text,band_c integer,from_at timestamptz,to_at timestamptz,
 fingerprint text,evidence_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
 WITH sources AS MATERIALIZED (SELECT * FROM private.energy_heating_observation_sources(p_home_id)
   WHERE room_key=p_room_key),
 observations AS MATERIALIZED (
  SELECT * FROM get_energy_room_thermal_intervals(p_customer_id,p_home_id,p_room_key,p_from,p_to) q
  WHERE q.room_key=p_room_key
 ), revisions AS MATERIALIZED (
  SELECT q.*,identity.fingerprint AS source_fingerprint,
    greatest(coalesce(n.changed, greatest(t.learning_updated_at,o.learning_updated_at,
      h.learning_updated_at,e.changed)),p.learning_updated_at,identity.learning_updated_at) AS changed
  FROM observations q
  LEFT JOIN energy_heating_probe_observations p ON p.home_id=p_home_id AND p.customer_id=p_customer_id
    AND p.start_ts=q.start_ts AND p.duration_s=q.duration_s
  LEFT JOIN private.energy_heating_source_revisions identity ON identity.home_id=p_home_id
  LEFT JOIN LATERAL (SELECT max(n.learning_updated_at) AS changed
   FROM energy_heating_observations n
   JOIN sources s ON s.room_key=n.room_key
   WHERE n.home_id=p_home_id AND n.room_key=q.room_key AND n.start_ts=q.start_ts
     AND n.duration_s=q.duration_s AND private.energy_heating_source_matches(p_home_id,n.room_key,
       n.source_key,n.device_statistics,s.source_key,s.device_statistics,n.start_ts,n.duration_s)) n ON true
  LEFT JOIN energy_optimisation_thermal_slots t ON n.changed IS NULL AND t.home_id=p_home_id
    AND t.room_key=q.room_key AND t.start_ts=q.start_ts
  LEFT JOIN energy_optimisation_outdoor_slots o ON n.changed IS NULL AND o.home_id=p_home_id AND o.start_ts=q.start_ts
  LEFT JOIN energy_optimisation_house_slots h ON n.changed IS NULL AND h.home_id=p_home_id AND h.start_ts=q.start_ts
  LEFT JOIN LATERAL (SELECT max(e.learning_updated_at) AS changed FROM energy_optimisation_device_slots e
    JOIN energy_optimisation_devices d ON d.id=e.device_id
    WHERE n.changed IS NULL AND e.home_id=p_home_id AND e.start_ts=q.start_ts
      AND d.mapping_summary->>'room_key'=p_room_key AND d.retired_at IS NULL) e ON true
 ), bands AS (
  SELECT (floor(outdoor_temperature_c/5)*5)::integer AS band,
    min(start_ts) AS begin_at,max(start_ts+make_interval(secs=>duration_s)) AS finish,
    max(changed) AS changed,
    -- Hash each vector before aggregation: a 400-day window must not build
    -- another in-memory copy of every household probe field.
    md5(jsonb_agg((to_jsonb(r)-ARRAY['changed','probe_evidence','active_power_w','room_name']) ||
      jsonb_build_object('probe_evidence',md5(r.probe_evidence::text)) ORDER BY start_ts,duration_s)::text) AS fingerprint
  FROM revisions r WHERE outdoor_temperature_c IS NOT NULL
  GROUP BY floor(outdoor_temperature_c/5)
 )
 SELECT band::text,band,greatest(p_from,begin_at-interval '1 hour'),finish,
   md5(jsonb_build_array(b.fingerprint,probe_span.fingerprint)::text),greatest(b.changed,probe_span.changed)
 FROM bands b
 -- The read-time freshness detector uses ordinary cadence outside the fitted
 -- band. Track its whole read span, but not unrelated future summer history.
 LEFT JOIN LATERAL (
   SELECT md5(coalesce(jsonb_agg(jsonb_build_array(p.start_ts,p.duration_s,md5(p.probes::text))
     ORDER BY p.start_ts,p.duration_s),'[]'::jsonb)::text) AS fingerprint,
     max(p.learning_updated_at) AS changed
   FROM energy_heating_probe_observations p
   WHERE p.home_id=p_home_id AND p.customer_id=p_customer_id
     AND p.start_ts>=greatest(p_from,b.begin_at-interval '1 hour')
     AND p.start_ts+make_interval(secs=>p.duration_s)<=b.finish
 ) probe_span ON true
 ORDER BY b.finish DESC,b.band;
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_heating_fit_windows(uuid,uuid,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_heating_fit_windows(uuid,uuid,text,timestamptz,timestamptz) TO service_role;

CREATE FUNCTION public.repair_energy_heating_irradiance(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_binding text,
 p_from timestamptz,p_to timestamptz,p_points jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE patched integer;
BEGIN
 IF NOT public.energy_home_matches_customer(p_home_id,p_customer_id) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 IF NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(p_home_id) c
   WHERE c.room_key=p_room_key AND c.binding=p_binding) THEN RAISE EXCEPTION 'Heating source changed'; END IF;
 UPDATE energy_heating_observations n SET solar_w_per_m2=p.v
 FROM jsonb_to_recordset(p_points) AS p(t double precision,v double precision),
   private.energy_heating_observation_sources(p_home_id) s
 WHERE n.home_id=p_home_id AND n.customer_id=p_customer_id AND n.room_key=p_room_key
   AND s.room_key=n.room_key AND n.solar_w_per_m2 IS NULL
   AND private.energy_heating_source_matches(p_home_id,n.room_key,n.source_key,n.device_statistics,
     s.source_key,s.device_statistics,n.start_ts,n.duration_s)
   AND n.start_ts>=p_from AND n.start_ts+make_interval(secs=>n.duration_s)<=p_to
   AND p.v>=0 AND p.v<'Infinity'::double precision AND p.t<'Infinity'::double precision
   AND mod(p.t::numeric,3600000)=0
   AND n.start_ts>=to_timestamp(p.t/1000)-interval '1 hour'
   AND n.start_ts+make_interval(secs=>n.duration_s)<=to_timestamp(p.t/1000);
 GET DIAGNOSTICS patched=ROW_COUNT;
 RETURN patched;
END;
$$;
REVOKE ALL ON FUNCTION public.repair_energy_heating_irradiance(uuid,uuid,text,text,timestamptz,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.repair_energy_heating_irradiance(uuid,uuid,text,text,timestamptz,timestamptz,jsonb) TO service_role;
