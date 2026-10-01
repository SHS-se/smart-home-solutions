-- Daily wind over a bidding zone, for estimating the price level of days the
-- market has not published (supabase/functions/_shared/market-wind.ts).
--
-- Shared weather, not customer data: written and read by the server only.

CREATE TABLE IF NOT EXISTS public.energy_market_wind_observed (
  zone text NOT NULL CHECK (zone ~ '^[A-Z0-9]{2,8}$'),
  day date NOT NULL,
  mean_speed_m_s numeric(6, 3) NOT NULL CHECK (mean_speed_m_s >= 0 AND mean_speed_m_s <= 75),
  station_count integer NOT NULL CHECK (station_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (zone, day)
);

-- One row per day forecast, per day the forecast was issued on, so a bench case
-- can be told what a plan made that day was told.
CREATE TABLE IF NOT EXISTS public.energy_market_wind_forecast (
  zone text NOT NULL CHECK (zone ~ '^[A-Z0-9]{2,8}$'),
  issued_on date NOT NULL,
  day date NOT NULL,
  mean_speed_m_s numeric(6, 3) NOT NULL CHECK (mean_speed_m_s >= 0 AND mean_speed_m_s <= 75),
  point_count integer NOT NULL CHECK (point_count > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (zone, issued_on, day),
  CHECK (day >= issued_on)
);

ALTER TABLE public.energy_market_wind_observed ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.energy_market_wind_forecast ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.energy_market_wind_observed FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.energy_market_wind_forecast FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.energy_market_wind_observed TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.energy_market_wind_forecast TO service_role;
