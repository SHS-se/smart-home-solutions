-- Add quote versioning columns to quotes table
ALTER TABLE public.quotes
ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS parent_quote_id uuid REFERENCES public.quotes(id),
ADD COLUMN IF NOT EXISTS supersedes_quote_id uuid REFERENCES public.quotes(id),
ADD COLUMN IF NOT EXISTS is_latest boolean NOT NULL DEFAULT true;

-- Create index for quick family lookups
CREATE INDEX IF NOT EXISTS idx_quotes_parent_quote_id ON public.quotes(parent_quote_id);
CREATE INDEX IF NOT EXISTS idx_quotes_is_latest ON public.quotes(is_latest) WHERE is_latest = true;

-- Add comment for clarity
COMMENT ON COLUMN public.quotes.version IS 'Version number within the quote family (starts at 1)';
COMMENT ON COLUMN public.quotes.parent_quote_id IS 'Points to the original v1 quote in the family (null for v1)';
COMMENT ON COLUMN public.quotes.supersedes_quote_id IS 'Points to the previous version this quote replaces';
COMMENT ON COLUMN public.quotes.is_latest IS 'True if this is the latest version in the quote family';