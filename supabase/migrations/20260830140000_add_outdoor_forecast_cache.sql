-- Shared cache for provider outdoor temperature forecasts.
--
-- Home Assistant's weather adapter publishes only the slice of a provider's
-- forecast that the provider itself marks hourly, which for met.no is about
-- two days against a three-day planning horizon. The temperature for the rest
-- of the horizon is not missing from met.no, only from the adapter: the same
-- response carries it at six-hourly resolution for ten days. The planner
-- therefore reads met.no directly for homes whose adapter stops short, and
-- this table is what keeps that from becoming one API call per home every
-- fifteen minutes.
--
-- Keyed by coordinate rather than by home, because outdoor air is a property
-- of a place and not of a household: homes in the same square kilometre share
-- one row. Rounding to two decimals is deliberate on both counts — it raises
-- the hit rate, and it keeps an exact house location out of a cache key for
-- data that has no customer scope to protect it.
--
-- `expires_at` carries the provider's own Expires header rather than a TTL we
-- invented. met.no's terms of service require clients to honour it, and it
-- also describes the model run better than any fixed interval could.

CREATE TABLE public.energy_outdoor_forecast_cache (
  provider text NOT NULL,
  latitude numeric(5,2) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(6,2) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  -- [{"at": "2026-08-30T04:00:00Z", "c": 15.4}, ...], provider resolution as
  -- issued: hourly while the provider offers it, six-hourly after.
  points jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider, latitude, longitude)
);

-- Rows are only ever read by coordinate, but a sweep of what has gone stale
-- is the one other question worth asking cheaply.
CREATE INDEX idx_energy_outdoor_forecast_cache_expires
  ON public.energy_outdoor_forecast_cache (expires_at);

ALTER TABLE public.energy_outdoor_forecast_cache ENABLE ROW LEVEL SECURITY;

-- No policies, and no grant to `authenticated`. This is planner
-- infrastructure written and read by the edge functions under the service
-- role, which bypasses RLS; it holds public weather data and belongs to no
-- customer, so there is no row a signed-in user should be reaching directly.
