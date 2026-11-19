-- Reviewed power statistics qualify the matching historical energy counter.
-- An empty map records that the assignment makes no claim about power.
ALTER TABLE private.energy_heating_history_sources
 ADD COLUMN observed_device_power_statistics jsonb NOT NULL DEFAULT '{}'::jsonb
 CHECK(jsonb_typeof(observed_device_power_statistics)='object');

CREATE OR REPLACE FUNCTION private.validate_heating_history_source() RETURNS trigger
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
 IF jsonb_typeof(NEW.observed_device_power_statistics) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'Historical power statistic identities must be an object'; END IF;
 IF EXISTS(SELECT FROM jsonb_each(NEW.observed_device_power_statistics) e(k,v)
    WHERE NOT NEW.observed_device_statistics ? k OR jsonb_typeof(v)<>'string' OR (v#>>'{}')!~'[^[:space:]]')
 THEN RAISE EXCEPTION 'Historical power statistics must give a nonempty statistic ID for an observed device'; END IF;
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
     AND (h.observed_source_key,h.observed_device_statistics,h.heater_energy_limits_w,h.observed_device_power_statistics)
       IS DISTINCT FROM (NEW.observed_source_key,NEW.observed_device_statistics,NEW.heater_energy_limits_w,NEW.observed_device_power_statistics)
     AND (TG_OP='INSERT' OR (h.home_id,h.room_key,h.observed_source_key,h.valid_from)
       IS DISTINCT FROM (OLD.home_id,OLD.room_key,OLD.observed_source_key,OLD.valid_from)))
 THEN RAISE EXCEPTION 'Conflicting historical heating source assignments'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.get_energy_heating_history_sources(p_home_id uuid,p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
DECLARE assignments jsonb;
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN RAISE EXCEPTION 'Home mismatch'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'room_key',h.room_key,'target_source_key',h.target_source_key,'target_device_statistics',h.target_device_statistics,
   'observed_source_key',h.observed_source_key,'observed_temperature_entity_id',h.observed_temperature_entity_id,
   'observed_device_statistics',h.observed_device_statistics,
   'observed_device_power_statistics',h.observed_device_power_statistics,
   'valid_from',h.valid_from,'valid_to',h.valid_to,
   'heater_energy_limits_w',h.heater_energy_limits_w
 ) ORDER BY h.room_key,h.valid_from,h.valid_to,h.observed_source_key),'[]'::jsonb) INTO assignments
 FROM private.energy_heating_history_sources h
 JOIN private.energy_heating_history_targets(p_home_id) s ON s.room_key=h.room_key
   AND s.source_key=h.target_source_key AND s.device_statistics=h.target_device_statistics
 WHERE h.home_id=p_home_id;
 RETURN jsonb_build_object('revision',md5(assignments::text),'assignments',assignments);
END; $$;

-- The source fingerprint includes the entire reviewed identity. Advance its
-- existing material clock once for assignments stored before the new field.
INSERT INTO private.energy_heating_source_revisions AS prior(home_id,fingerprint)
SELECT h.home_id,private.energy_heating_source_fingerprint(h.home_id)
FROM (SELECT DISTINCT home_id FROM private.energy_heating_history_sources) h
ON CONFLICT(home_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,
 learning_updated_at=greatest(prior.learning_updated_at,statement_timestamp())
WHERE prior.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint;
