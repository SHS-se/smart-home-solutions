-- Shared daily weather observations, customer daily usage imports, and
-- customer-authored timeline notes for energy-history analysis.

CREATE OR REPLACE FUNCTION public.can_access_shared_energy_history()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND (
      public.is_staff(auth.uid())
      OR EXISTS (
        SELECT 1
        FROM public.customers AS customer
        WHERE customer.id = public.get_customer_id_for_user(auth.uid())
          AND customer.subscription_active
          AND (
            customer.subscription_expires_at IS NULL
            OR customer.subscription_expires_at > now()
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.can_access_shared_energy_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_shared_energy_history() TO authenticated;

CREATE TABLE public.energy_weather_datasets (
  dataset_key text PRIMARY KEY CHECK (dataset_key ~ '^[a-z0-9_-]+$'),
  display_name text NOT NULL,
  source_name text NOT NULL,
  source_url text NOT NULL,
  station_id text NOT NULL,
  latitude numeric NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  unit text NOT NULL DEFAULT '°C',
  last_synced_at timestamptz,
  last_observation_date date,
  sync_started_at timestamptz,
  sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.energy_weather_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key text NOT NULL REFERENCES public.energy_weather_datasets(dataset_key) ON DELETE CASCADE,
  observed_on date NOT NULL,
  temperature_c numeric NOT NULL CHECK (temperature_c BETWEEN -80 AND 80),
  quality_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_key, observed_on)
);

ALTER TABLE public.energy_weather_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_weather_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read shared weather datasets"
  ON public.energy_weather_datasets
  FOR SELECT
  TO authenticated
  USING (public.can_access_shared_energy_history());

CREATE POLICY "Energy subscribers read shared weather observations"
  ON public.energy_weather_observations
  FOR SELECT
  TO authenticated
  USING (public.can_access_shared_energy_history());

REVOKE ALL ON public.energy_weather_datasets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_weather_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_weather_datasets TO authenticated;
GRANT SELECT ON public.energy_weather_observations TO authenticated;

INSERT INTO public.energy_weather_datasets (
  dataset_key,
  display_name,
  source_name,
  source_url,
  station_id,
  latitude,
  longitude
)
VALUES (
  'stockholm-taby',
  'Stockholm / Täby reference temperature',
  'SMHI daily mean air temperature, Stockholm-Observatoriekullen A',
  'https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/2/station/98230/period/corrected-archive/data.csv',
  '98230',
  59.3417,
  18.0549
)
ON CONFLICT (dataset_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_energy_weather_sync(
  p_dataset_key text,
  p_force boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed boolean;
BEGIN
  IF COALESCE(auth.jwt()->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Weather sync is service-only'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.energy_weather_datasets
  SET
    sync_started_at = now(),
    sync_error = NULL
  WHERE dataset_key = p_dataset_key
    AND (p_force OR last_synced_at IS NULL OR last_synced_at < now() - interval '7 days')
    AND (sync_started_at IS NULL OR sync_started_at < now() - interval '15 minutes')
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_energy_weather_sync(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_energy_weather_sync(text, boolean) TO service_role;

CREATE TRIGGER energy_weather_datasets_updated_at
  BEFORE UPDATE ON public.energy_weather_datasets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TRIGGER energy_weather_observations_updated_at
  BEFORE UPDATE ON public.energy_weather_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TABLE public.energy_usage_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  original_file_name text NOT NULL CHECK (char_length(original_file_name) BETWEEN 1 AND 255),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  reading_count integer NOT NULL CHECK (reading_count > 0),
  imported_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, file_sha256)
);

CREATE TABLE public.energy_usage_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reading_date date NOT NULL,
  consumption_kwh numeric NOT NULL CHECK (consumption_kwh >= 0),
  source_import_id uuid NOT NULL REFERENCES public.energy_usage_import_batches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, reading_date)
);

CREATE INDEX idx_energy_usage_import_batches_customer_created
  ON public.energy_usage_import_batches (customer_id, created_at DESC);

ALTER TABLE public.energy_usage_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_usage_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own usage import batches"
  ON public.energy_usage_import_batches
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers read own daily usage"
  ON public.energy_usage_readings
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_usage_import_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_usage_readings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_usage_import_batches TO authenticated;
GRANT SELECT ON public.energy_usage_readings TO authenticated;

CREATE TRIGGER energy_usage_readings_updated_at
  BEFORE UPDATE ON public.energy_usage_readings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

CREATE OR REPLACE FUNCTION public.import_energy_usage_readings(
  p_customer_id uuid,
  p_original_file_name text,
  p_file_sha256 text,
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
    reading_count,
    imported_by
  )
  VALUES (
    p_customer_id,
    p_original_file_name,
    p_file_sha256,
    reading_count,
    auth.uid()
  )
  RETURNING id INTO created_import_id;

  INSERT INTO public.energy_usage_readings (
    customer_id,
    reading_date,
    consumption_kwh,
    source_import_id
  )
  SELECT
    p_customer_id,
    item.reading_date::date,
    item.consumption_kwh,
    created_import_id
  FROM jsonb_to_recordset(p_readings) AS item(
    reading_date text,
    consumption_kwh numeric
  )
  ON CONFLICT (customer_id, reading_date)
  DO UPDATE SET
    consumption_kwh = EXCLUDED.consumption_kwh,
    source_import_id = EXCLUDED.source_import_id,
    updated_at = now();

  RETURN created_import_id;
END;
$$;

REVOKE ALL ON FUNCTION public.import_energy_usage_readings(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_energy_usage_readings(uuid, text, text, jsonb) TO authenticated;

CREATE TABLE public.energy_history_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  note_date date NOT NULL,
  title text NOT NULL CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 200
  ),
  details text NOT NULL CHECK (
    details = btrim(details)
    AND char_length(details) BETWEEN 1 AND 4000
  ),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_energy_history_notes_customer_date
  ON public.energy_history_notes (customer_id, note_date);

ALTER TABLE public.energy_history_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own timeline notes"
  ON public.energy_history_notes
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

CREATE POLICY "Energy subscribers create own timeline notes"
  ON public.energy_history_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_access_energy_billing_customer(customer_id)
    AND created_by = auth.uid()
    AND updated_by = auth.uid()
  );

CREATE POLICY "Energy subscribers update timeline notes"
  ON public.energy_history_notes
  FOR UPDATE
  TO authenticated
  USING (
    public.can_access_energy_billing_customer(customer_id)
    AND (created_by = auth.uid() OR public.is_staff(auth.uid()))
  )
  WITH CHECK (
    public.can_access_energy_billing_customer(customer_id)
    AND updated_by = auth.uid()
  );

CREATE POLICY "Energy subscribers delete timeline notes"
  ON public.energy_history_notes
  FOR DELETE
  TO authenticated
  USING (
    public.can_access_energy_billing_customer(customer_id)
    AND (created_by = auth.uid() OR public.is_staff(auth.uid()))
  );

REVOKE ALL ON public.energy_history_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.energy_history_notes TO authenticated;

CREATE OR REPLACE FUNCTION public.energy_history_notes_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Energy history note identity fields are immutable'
      USING ERRCODE = '22023';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER energy_history_notes_before_update
  BEFORE UPDATE ON public.energy_history_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.energy_history_notes_before_update();

-- Refresh the shared weather data without requiring a customer-specific job.
-- The daily job only fetches when the atomic claim finds data at least 7 days old.
SELECT cron.schedule(
  'sync-energy-weather-history-daily-check',
  '12 4 * * *',
  $$SELECT net.http_post(
    url := 'https://oosxndduqzhvrorgogaw.supabase.co/functions/v1/sync-weather-history',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"force":false}'::jsonb
  )$$
);
