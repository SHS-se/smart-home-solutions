-- SMHI's point forecast answers for the model grid point nearest the request,
-- and its grid is 2.5 km apart, so a key rounded to 0.01° can name a
-- neighbour's point. The cache now keys SMHI rows at four decimals (~11 m);
-- two-decimal rows from other providers keep their values.
ALTER TABLE public.energy_outdoor_forecast_cache
  ALTER COLUMN latitude TYPE numeric(7,4),
  ALTER COLUMN longitude TYPE numeric(8,4);
