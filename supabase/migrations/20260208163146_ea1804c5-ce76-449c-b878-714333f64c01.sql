
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_quote_id uuid
    REFERENCES public.quotes(id);

CREATE INDEX IF NOT EXISTS idx_quotes_superseded_by
  ON public.quotes(superseded_by_quote_id)
  WHERE superseded_by_quote_id IS NOT NULL;
