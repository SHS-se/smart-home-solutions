-- Older derived forecasts cannot identify which published prices fitted their
-- tail. Discard those products; the next telemetry or planning request prepares
-- a complete product with published price inputs. Accepted plans are untouched.
DELETE FROM public.energy_prepared_forecasts
WHERE NOT (forecast ? 'published_import_sek_per_kwh');
