-- Learning admits one room invocation per home and reads native chunks
-- sequentially. Scope working memory to the learning RPCs: their bounded
-- vector spools and sorts must not spill under the small database default.
-- This does not change database-wide memory or planning requests.
ALTER FUNCTION public.get_energy_room_thermal_interval_capture(uuid,uuid,text,timestamptz,timestamptz)
 SET work_mem='32MB';

-- Native intervals carry their own evidence clocks. Read legacy device-slot
-- clocks only at timestamps actually supplied by legacy observations.
-- Preserve all fingerprints, source qualification and publication fences.
CREATE OR REPLACE FUNCTION public.get_energy_room_heating_fit_windows(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(window_key text,band_c integer,from_at timestamptz,to_at timestamptz,
 fingerprint text,evidence_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private
 SET work_mem='32MB' AS $$
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
  JOIN (SELECT DISTINCT start_ts FROM observations WHERE native_updated_at IS NULL) legacy
    ON legacy.start_ts=e.start_ts
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
