-- Add RLS policies for rate_limits table (staff-only access for monitoring)
-- Note: Edge functions use service role key which bypasses RLS, so this only affects direct queries

CREATE POLICY "Staff can view rate_limits"
ON public.rate_limits
FOR SELECT
USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete rate_limits"
ON public.rate_limits
FOR DELETE
USING (public.is_staff(auth.uid()));