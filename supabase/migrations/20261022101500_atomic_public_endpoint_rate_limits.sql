-- Row locking in ON CONFLICT makes one request consume one allowance, even
-- when many requests arrive together. Only the edge functions may call this.
CREATE FUNCTION public.consume_rate_limit(
  p_identifier text, p_endpoint text, p_limit integer, p_window_seconds integer
) RETURNS TABLE(allowed boolean, remaining integer)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  sampled_at timestamptz := clock_timestamp();
  consumed integer;
BEGIN
  IF p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'Invalid rate limit configuration' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rate_limits AS limits (identifier, endpoint, request_count, window_start)
  VALUES (p_identifier, p_endpoint, 1, sampled_at)
  ON CONFLICT (identifier, endpoint) DO UPDATE SET
    request_count = CASE
      WHEN limits.window_start <= sampled_at - make_interval(secs => p_window_seconds) THEN 1
      ELSE LEAST(limits.request_count, p_limit) + 1 END,
    window_start = CASE
      WHEN limits.window_start <= sampled_at - make_interval(secs => p_window_seconds) THEN sampled_at
      ELSE limits.window_start END
  RETURNING request_count INTO consumed;
  RETURN QUERY SELECT consumed <= p_limit, GREATEST(0, p_limit - consumed);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, text, integer, integer) TO service_role;
