-- Keep shared SMHI collection out of the customer application. A database-owned
-- token authenticates the daily pg_cron request to the edge function.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.energy_weather_sync_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token text NOT NULL CHECK (token ~ '^[0-9a-f]{64}$'),
  function_url text CHECK (
    function_url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/sync-weather-history$'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.energy_weather_sync_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_weather_sync_credentials
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.energy_weather_sync_credentials (singleton, token)
VALUES (true, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.verify_energy_weather_sync_token(
  p_token text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private
AS $$
  SELECT COALESCE(
    (
      SELECT credentials.token = p_token
      FROM private.energy_weather_sync_credentials AS credentials
      WHERE credentials.singleton
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.verify_energy_weather_sync_token(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_energy_weather_sync_token(text)
  TO service_role;

DROP FUNCTION IF EXISTS public.claim_energy_weather_sync(text, boolean);

CREATE FUNCTION public.claim_energy_weather_sync(
  p_dataset_key text
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
    AND (last_synced_at IS NULL OR last_synced_at < now() - interval '20 hours')
    AND (sync_started_at IS NULL OR sync_started_at < now() - interval '15 minutes')
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_energy_weather_sync(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_energy_weather_sync(text) TO service_role;

-- cron.schedule updates the existing named job. It runs once per day at 04:12 UTC
-- and supplies the token directly from the private schema.
SELECT cron.schedule(
  'sync-energy-weather-history-daily-check',
  '12 4 * * *',
  $job$
    SELECT net.http_post(
      url := (
        SELECT credentials.function_url
        FROM private.energy_weather_sync_credentials AS credentials
        WHERE credentials.singleton
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-weather-sync-token',
        (
          SELECT credentials.token
          FROM private.energy_weather_sync_credentials AS credentials
          WHERE credentials.singleton
        )
      ),
      body := '{}'::jsonb
    )
  $job$
);
