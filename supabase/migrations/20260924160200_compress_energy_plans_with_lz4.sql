-- Plans are large nested JSONB values written while holding the home's row lock.
-- Use PostgreSQL's faster compressor for future writes; existing rows remain
-- readable and are naturally replaced at the next publication. No table rewrite.
ALTER TABLE public.energy_optimisation_current
  ALTER COLUMN plan SET COMPRESSION lz4;
