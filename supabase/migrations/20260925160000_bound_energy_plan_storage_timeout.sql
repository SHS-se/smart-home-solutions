-- Publishing a plan is one multi-megabyte JSONB write that takes about 0.2 s
-- on an idle database but needs roughly 20 times the body size in backend
-- memory. Under load it has exceeded the inherited 8-second authenticator
-- timeout (57014), failing a replan whose solve had already succeeded.
-- PostgREST hoists a function's own statement_timeout into the transaction, so
-- only this service-role write gets more time; every other API call keeps 8 s.
-- Still bounded: the Home Assistant exchange allows 150 seconds in total.
ALTER FUNCTION public.store_energy_optimisation_current(jsonb) SET statement_timeout = '30s';

-- The planning snapshot and battery projection are written beside the plan in
-- the same statement. Use the plan's faster compressor for them too; existing
-- values stay readable and are replaced at the next publication.
ALTER TABLE public.energy_optimisation_current
  ALTER COLUMN snapshot SET COMPRESSION lz4,
  ALTER COLUMN battery_projection SET COMPRESSION lz4;
