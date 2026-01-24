-- Enable RLS on rate_limits table
-- No policies are created because:
-- 1. Edge functions use service_role key which bypasses RLS
-- 2. No authenticated users should be able to access this table directly
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;