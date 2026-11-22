-- A nominal five-degree band has one active revision. Its observed coverage
-- remains evidence; superseded accepted revisions belong to the archive.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.energy_optimisation_zone_models,
  public.energy_optimisation_device_operating_points IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION private.archive_energy_heating_row(p_row jsonb,p_owner text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE owner_key text; library jsonb; points jsonb; ref uuid; point jsonb; binding text;
BEGIN
 IF p_owner='room' THEN
  owner_key:=p_row->>'room_key'; library:=p_row->'heating_bands'; points:=library->'active';
  binding:=library->>'binding'; ref:=(library->>'reference_revision')::uuid;
  IF ref IS NOT NULL THEN
   INSERT INTO private.energy_heating_calibration_revisions(home_id,owner_kind,owner_key,revision,calibration)
   VALUES((p_row->>'home_id')::uuid,p_owner,owner_key,ref,
     (p_row-'heating_bands'-'last_fit_attempt'-'last_attempted_at'-'model_revision')
       || COALESCE(library->'reference'->'model','{}'::jsonb) || jsonb_build_object('binding',binding))
   ON CONFLICT DO NOTHING;
  END IF;
 ELSE
  owner_key:=p_row->>'device_key'; library:=p_row->'operating_points'; points:=library->'points';
  binding:=library->>'binding'; ref:=(library->'reference'->>'revision')::uuid;
  IF ref IS NOT NULL THEN
   INSERT INTO private.energy_heating_calibration_revisions(home_id,owner_kind,owner_key,revision,calibration)
   VALUES((p_row->>'home_id')::uuid,p_owner,owner_key,ref,
     library->'reference' || jsonb_build_object('binding',binding))
   ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 IF jsonb_typeof(points)='array' THEN
  FOR point IN SELECT value FROM jsonb_array_elements(points) WHERE value ? 'revision' LOOP
   INSERT INTO private.energy_heating_calibration_revisions(home_id,owner_kind,owner_key,revision,band_c,calibration)
   VALUES((p_row->>'home_id')::uuid,p_owner,owner_key,(point->>'revision')::uuid,
     (point->>'band_c')::integer,point || jsonb_build_object('binding',binding))
   ON CONFLICT DO NOTHING;
  END LOOP;
 END IF;
END; $$;
REVOKE ALL ON FUNCTION private.archive_energy_heating_row(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.archive_energy_heating_calibrations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE owner text:=CASE WHEN TG_TABLE_NAME='energy_optimisation_zone_models' THEN 'room' ELSE 'device' END;
BEGIN
 -- Archive the previously accepted contents too, including rows predating the
 -- archive trigger. A failed publication still rolls its archive writes back.
 IF TG_OP='UPDATE' THEN PERFORM private.archive_energy_heating_row(to_jsonb(OLD),owner); END IF;
 PERFORM private.archive_energy_heating_row(to_jsonb(NEW),owner);
 RETURN NEW;
END; $$;

CREATE FUNCTION private.heating_bands_unique(p_points jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,private AS $$
 SELECT CASE WHEN jsonb_typeof(p_points)='array' THEN NOT EXISTS (
   SELECT FROM jsonb_array_elements(p_points) point WHERE point ? 'band_c'
   GROUP BY point->'band_c' HAVING count(*)>1
 ) ELSE true END;
$$;
REVOKE ALL ON FUNCTION private.heating_bands_unique(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.heating_bands_unique(jsonb) TO service_role;

-- Use the existing preference once to repair stored arrays. Runtime preference
-- remains in TypeScript; SQL subsequently enforces only uniqueness.
CREATE FUNCTION private.canonical_heating_bands_for_migration(p_points jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,private SET timezone='UTC' AS $$
 WITH ranked AS (
  SELECT point,ordinal,row_number() OVER (
   PARTITION BY point->'band_c' ORDER BY
    CASE WHEN jsonb_typeof(point#>'{learning_evidence,run_calibration,fitted_runs}')='number' THEN COALESCE(
      point#>>'{learning_evidence,run_calibration,policy}'='recent_independent_runs_v1'
      AND (point#>>'{learning_evidence,run_calibration,fitted_runs}')::numeric BETWEEN 3 AND 10
      AND trunc((point#>>'{learning_evidence,run_calibration,fitted_runs}')::numeric)
        =(point#>>'{learning_evidence,run_calibration,fitted_runs}')::numeric,false) ELSE false END DESC,
    COALESCE((point->>'fitted_at')::timestamptz,(point->>'training_to')::timestamptz) DESC NULLS LAST,
    (point->>'training_from')::timestamptz DESC NULLS LAST,ordinal
  ) AS preference
  FROM jsonb_array_elements(p_points) WITH ORDINALITY AS entries(point,ordinal)
 )
 SELECT COALESCE(jsonb_agg(point ORDER BY (point->>'band_c')::numeric,ordinal),'[]'::jsonb)
 FROM ranked WHERE preference=1 OR NOT (point ? 'band_c');
$$;

-- Archive before deduplication, even where no model update will be needed.
SELECT private.archive_energy_heating_row(to_jsonb(m),'room')
 FROM public.energy_optimisation_zone_models m WHERE heating_bands IS NOT NULL;
SELECT private.archive_energy_heating_row(to_jsonb(m),'device')
 FROM public.energy_optimisation_device_operating_points m
 WHERE operating_points->>'method'='weather_heating_draw_v1';

-- Existing revision triggers fence captures of changed rows. Other bands,
-- references, attempt clocks, jobs and measured observations are untouched.
UPDATE public.energy_optimisation_zone_models SET heating_bands=jsonb_set(heating_bands,'{active}',
 private.canonical_heating_bands_for_migration(heating_bands->'active'))
 WHERE NOT private.heating_bands_unique(heating_bands->'active');
UPDATE public.energy_optimisation_device_operating_points SET operating_points=jsonb_set(operating_points,'{points}',
 private.canonical_heating_bands_for_migration(operating_points->'points'))
 WHERE operating_points->>'method'='weather_heating_draw_v1'
 AND NOT private.heating_bands_unique(operating_points->'points');
DROP FUNCTION private.canonical_heating_bands_for_migration(jsonb);

ALTER TABLE public.energy_optimisation_zone_models ADD CONSTRAINT room_heating_active_band_unique
 CHECK(private.heating_bands_unique(heating_bands->'active')) NOT VALID;
ALTER TABLE public.energy_optimisation_device_operating_points ADD CONSTRAINT device_heating_active_band_unique
 CHECK(operating_points->>'method' IS DISTINCT FROM 'weather_heating_draw_v1'
   OR private.heating_bands_unique(operating_points->'points')) NOT VALID;
ALTER TABLE public.energy_optimisation_zone_models VALIDATE CONSTRAINT room_heating_active_band_unique;
ALTER TABLE public.energy_optimisation_device_operating_points VALIDATE CONSTRAINT device_heating_active_band_unique;
