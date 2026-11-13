-- One-off, reviewed hourly evidence with inferred heating activity. Keep its
-- resolution and provenance separate from uploaded, confirmed meter quarters.
CREATE TABLE private.energy_weather_heating_hourly_imports (
  device_id uuid NOT NULL,
  home_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  start_ts timestamptz NOT NULL CHECK (mod(extract(epoch FROM start_ts), 3600) = 0),
  binding text NOT NULL CHECK (length(binding) BETWEEN 1 AND 768),
  outdoor_c numeric NOT NULL CHECK (outdoor_c BETWEEN -80 AND 80),
  watts numeric NOT NULL CHECK (watts > 0 AND watts < 'Infinity'::numeric),
  PRIMARY KEY (device_id, start_ts),
  FOREIGN KEY (device_id, home_id, customer_id)
    REFERENCES public.energy_optimisation_devices (id, home_id, customer_id) ON DELETE CASCADE
);
ALTER TABLE private.energy_weather_heating_hourly_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_weather_heating_hourly_imports FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_energy_weather_heating_days(
  p_home_id uuid, p_customer_id uuid, p_device_key text, p_binding text,
  p_from timestamptz, p_to timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH owner AS (
    SELECT id, home_id, customer_id FROM public.energy_optimisation_devices
    WHERE home_id=p_home_id AND customer_id=p_customer_id AND device_key=p_device_key AND retired_at IS NULL
  ), confirmed AS (
    SELECT s.start_ts, o.temperature_c, s.energy_kwh
    FROM owner d
    JOIN public.energy_optimisation_device_slots s
      ON s.device_id=d.id AND s.home_id=d.home_id AND s.customer_id=d.customer_id
    JOIN public.energy_optimisation_outdoor_slots o
      ON o.home_id=s.home_id AND o.customer_id=s.customer_id AND o.start_ts=s.start_ts
    WHERE s.start_ts >= date_trunc('hour', p_from, 'UTC') AND s.start_ts < p_to
      AND s.quality->>'weather_heating_binding'=p_binding
      AND s.energy_kwh > 0 AND o.temperature_c IS NOT NULL
  ), day_bands AS (
    SELECT (start_ts AT TIME ZONE 'UTC')::date AS day,
      avg(temperature_c)::double precision AS outdoor_c,
      avg(energy_kwh * 4000)::double precision AS watts,
      count(*) * 0.25 AS hours
    FROM confirmed
    WHERE start_ts >= p_from
    GROUP BY (start_ts AT TIME ZONE 'UTC')::date, floor(temperature_c)
    UNION ALL
    SELECT (h.start_ts AT TIME ZONE 'UTC')::date, h.outdoor_c::double precision,
      h.watts::double precision, 1::numeric
    FROM owner d
    JOIN private.energy_weather_heating_hourly_imports h ON h.device_id=d.id
    WHERE h.binding=p_binding AND h.start_ts >= p_from AND h.start_ts + interval '1 hour' <= p_to
      AND NOT EXISTS (
        SELECT 1 FROM confirmed c WHERE c.start_ts >= h.start_ts AND c.start_ts < h.start_ts + interval '1 hour'
      )
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(day_bands) ORDER BY day, outdoor_c, watts, hours), '[]'::jsonb)
  FROM day_bands;
$$;
