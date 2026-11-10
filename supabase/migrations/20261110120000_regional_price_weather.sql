-- Public-source regional weather, kept independently per feed. The scheduled
-- collector writes one complete row at a time; household requests only read it.
CREATE TABLE public.energy_price_weather_feeds (
  source text PRIMARY KEY CHECK (source IN ('ecmwf', 'gfs')),
  forecast_cycle timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  history jsonb NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  forecast jsonb NOT NULL CHECK (jsonb_typeof(forecast) = 'array' AND jsonb_array_length(forecast) > 0)
);

ALTER TABLE public.energy_price_weather_feeds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_price_weather_feeds FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.energy_price_weather_feeds TO service_role;
