-- Create rate_limits table for tracking API rate limiting
CREATE TABLE IF NOT EXISTS public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,  -- IP address or other identifier
  endpoint text NOT NULL,    -- Which endpoint (e.g., 'contact_form')
  request_count integer NOT NULL DEFAULT 1,
  window_start timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create unique index for efficient lookups and upserts
CREATE UNIQUE INDEX idx_rate_limits_identifier_endpoint ON public.rate_limits (identifier, endpoint);

-- Create index on window_start for cleanup queries
CREATE INDEX idx_rate_limits_window_start ON public.rate_limits (window_start);

-- Enable RLS
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- No public access - only service role can access this table
-- (Edge functions use service role key)