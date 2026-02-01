-- Add columns for test/cancel functionality on quotes table
ALTER TABLE public.quotes 
ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS cancelled_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS stripe_status text,
ADD COLUMN IF NOT EXISTS status_reason text;

-- Create index for filtering
CREATE INDEX IF NOT EXISTS idx_quotes_is_test ON public.quotes(is_test);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON public.quotes(status);