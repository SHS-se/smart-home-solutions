-- Keep purchased grid electricity separate from whole-home load so solar
-- production changes cost accounting without corrupting efficiency analysis.

ALTER TABLE public.energy_usage_import_batches
  ADD COLUMN IF NOT EXISTS reading_kind text;

ALTER TABLE public.energy_usage_readings
  ADD COLUMN IF NOT EXISTS reading_kind text;

UPDATE public.energy_usage_import_batches
SET reading_kind = 'grid_import'
WHERE reading_kind IS NULL;

UPDATE public.energy_usage_readings
SET reading_kind = 'grid_import'
WHERE reading_kind IS NULL;

ALTER TABLE public.energy_usage_import_batches
  ALTER COLUMN reading_kind SET NOT NULL;

ALTER TABLE public.energy_usage_readings
  ALTER COLUMN reading_kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'energy_usage_import_batches_reading_kind_check'
      AND conrelid = 'public.energy_usage_import_batches'::regclass
  ) THEN
    ALTER TABLE public.energy_usage_import_batches
      ADD CONSTRAINT energy_usage_import_batches_reading_kind_check
        CHECK (reading_kind IN ('grid_import', 'total_consumption'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'energy_usage_readings_reading_kind_check'
      AND conrelid = 'public.energy_usage_readings'::regclass
  ) THEN
    ALTER TABLE public.energy_usage_readings
      ADD CONSTRAINT energy_usage_readings_reading_kind_check
        CHECK (reading_kind IN ('grid_import', 'total_consumption'));
  END IF;
END;
$$;

ALTER TABLE public.energy_usage_readings
  DROP CONSTRAINT IF EXISTS energy_usage_readings_customer_id_reading_date_key,
  DROP CONSTRAINT IF EXISTS energy_usage_readings_customer_date_kind_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'energy_usage_readings_import_date_key'
      AND conrelid = 'public.energy_usage_readings'::regclass
  ) THEN
    ALTER TABLE public.energy_usage_readings
      ADD CONSTRAINT energy_usage_readings_import_date_key
        UNIQUE (source_import_id, reading_date);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_energy_usage_readings_customer_kind_date
  ON public.energy_usage_readings (customer_id, reading_kind, reading_date, source_import_id);

CREATE OR REPLACE VIEW public.energy_usage_current_readings
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (
  reading.customer_id,
  reading.reading_date,
  reading.reading_kind
)
  reading.id,
  reading.customer_id,
  reading.reading_date,
  reading.reading_kind,
  reading.consumption_kwh,
  reading.source_import_id,
  reading.created_at,
  reading.updated_at
FROM public.energy_usage_readings AS reading
JOIN public.energy_usage_import_batches AS import_batch
  ON import_batch.id = reading.source_import_id
ORDER BY
  reading.customer_id,
  reading.reading_date,
  reading.reading_kind,
  import_batch.created_at DESC,
  import_batch.id DESC,
  reading.id DESC;

REVOKE ALL ON public.energy_usage_current_readings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_usage_current_readings TO authenticated;

DROP FUNCTION IF EXISTS public.import_energy_usage_readings(uuid, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.import_energy_usage_readings(
  p_customer_id uuid,
  p_original_file_name text,
  p_file_sha256 text,
  p_reading_kind text,
  p_readings jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created_import_id uuid;
  reading_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.can_access_energy_billing_customer(p_customer_id) THEN
    RAISE EXCEPTION 'Energy usage access denied'
      USING ERRCODE = '42501';
  END IF;

  IF p_original_file_name IS NULL
    OR char_length(p_original_file_name) NOT BETWEEN 1 AND 255
    OR p_file_sha256 IS NULL
    OR p_file_sha256 !~ '^[0-9a-f]{64}$'
    OR p_reading_kind IS NULL
    OR p_reading_kind NOT IN ('grid_import', 'total_consumption')
  THEN
    RAISE EXCEPTION 'Energy usage import metadata is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_readings IS NULL OR jsonb_typeof(p_readings) <> 'array' THEN
    RAISE EXCEPTION 'Energy usage readings must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  reading_count := jsonb_array_length(p_readings);
  IF reading_count = 0 OR reading_count > 5000 THEN
    RAISE EXCEPTION 'Energy usage readings must contain between 1 and 5000 entries'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_readings) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'object'
      OR item.value->>'reading_date' IS NULL
      OR item.value->>'reading_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR item.value->>'consumption_kwh' IS NULL
      OR item.value->>'consumption_kwh' !~ '^[0-9]+([.][0-9]+)?$'
  )
  THEN
    RAISE EXCEPTION 'Energy usage readings contain an invalid date or value'
      USING ERRCODE = '22023';
  END IF;

  IF reading_count <> (
    SELECT count(DISTINCT item.value->>'reading_date')
    FROM jsonb_array_elements(p_readings) AS item(value)
  )
  THEN
    RAISE EXCEPTION 'Energy usage import contains duplicate dates'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.energy_usage_import_batches (
    customer_id,
    original_file_name,
    file_sha256,
    reading_kind,
    reading_count,
    imported_by
  )
  VALUES (
    p_customer_id,
    p_original_file_name,
    p_file_sha256,
    p_reading_kind,
    reading_count,
    auth.uid()
  )
  RETURNING id INTO created_import_id;

  INSERT INTO public.energy_usage_readings (
    customer_id,
    reading_date,
    reading_kind,
    consumption_kwh,
    source_import_id
  )
  SELECT
    p_customer_id,
    item.reading_date::date,
    p_reading_kind,
    item.consumption_kwh,
    created_import_id
  FROM jsonb_to_recordset(p_readings) AS item(
    reading_date text,
    consumption_kwh numeric
  );

  RETURN created_import_id;
END;
$$;

REVOKE ALL ON FUNCTION public.import_energy_usage_readings(uuid, text, text, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_energy_usage_readings(uuid, text, text, text, jsonb)
  TO authenticated;
