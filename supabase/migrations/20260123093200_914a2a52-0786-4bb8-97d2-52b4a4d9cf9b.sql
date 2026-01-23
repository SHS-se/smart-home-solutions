-- The rate_limits table is only accessed by edge functions using service_role key
-- which bypasses RLS. Disable RLS since no authenticated users need direct access.
ALTER TABLE public.rate_limits DISABLE ROW LEVEL SECURITY;