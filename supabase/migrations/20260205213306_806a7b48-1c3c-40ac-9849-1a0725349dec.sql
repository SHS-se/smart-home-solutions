
-- =====================================================
-- Phase 1: Own the Quote Lifecycle - Schema Migration
-- =====================================================

-- A) Alter quotes table: add lifecycle columns
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by_name text,
  ADD COLUMN IF NOT EXISTS accepted_by_email text,
  ADD COLUMN IF NOT EXISTS accepted_ip text,
  ADD COLUMN IF NOT EXISTS accepted_user_agent text,
  ADD COLUMN IF NOT EXISTS accept_token_hash text,
  ADD COLUMN IF NOT EXISTS accept_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz;

-- B) Create quote_events table
CREATE TABLE IF NOT EXISTS public.quote_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_type text,
  actor_email text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_events_quote_id ON public.quote_events(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_events_event_type ON public.quote_events(event_type);

ALTER TABLE public.quote_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read quote_events"
  ON public.quote_events FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert quote_events"
  ON public.quote_events FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

-- C) Create quote_messages table
CREATE TABLE IF NOT EXISTS public.quote_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('customer', 'staff')),
  author_name text,
  author_email text,
  body_markdown text NOT NULL,
  source text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'email')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_messages_quote_id ON public.quote_messages(quote_id);

ALTER TABLE public.quote_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read quote_messages"
  ON public.quote_messages FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert quote_messages"
  ON public.quote_messages FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update quote_messages"
  ON public.quote_messages FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete quote_messages"
  ON public.quote_messages FOR DELETE
  USING (public.is_staff(auth.uid()));

-- D) Create document_sequences table
CREATE TABLE IF NOT EXISTS public.document_sequences (
  key text PRIMARY KEY,
  next_value integer NOT NULL DEFAULT 1
);

ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;
-- No direct RLS policies - only accessible via SECURITY DEFINER function

-- Initialize quote sequence
INSERT INTO public.document_sequences (key, next_value) VALUES ('quote', 1)
ON CONFLICT (key) DO NOTHING;

-- E) Create generate_next_quote_number() function
CREATE OR REPLACE FUNCTION public.generate_next_quote_number()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_next int;
  v_prefix text;
  v_env text;
BEGIN
  v_env := current_setting('app.environment', true);
  IF v_env = 'live' THEN
    v_prefix := 'Q-';
  ELSE
    v_prefix := 'TQ-';
  END IF;

  UPDATE public.document_sequences
    SET next_value = next_value + 1
    WHERE key = 'quote'
    RETURNING next_value - 1 INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Quote sequence not found in document_sequences';
  END IF;

  RETURN v_prefix || LPAD(v_next::text, 8, '0');
END;
$$;
