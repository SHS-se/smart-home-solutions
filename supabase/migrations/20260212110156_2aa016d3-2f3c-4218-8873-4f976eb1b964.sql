
-- Create verification_tokens table for branded email verification links
CREATE TABLE public.verification_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code text NOT NULL,
  token_hash text NOT NULL,
  type text NOT NULL,
  redirect_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL
);

-- Unique index on code for fast lookups
CREATE UNIQUE INDEX idx_verification_tokens_code ON public.verification_tokens (code);

-- Index for cleanup of expired tokens
CREATE INDEX idx_verification_tokens_expires_at ON public.verification_tokens (expires_at);

-- Restrict type to allowed values via trigger (not CHECK for safety)
CREATE OR REPLACE FUNCTION public.validate_verification_token_type()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.type NOT IN ('signup', 'recovery', 'magiclink') THEN
    RAISE EXCEPTION 'Invalid verification token type: %. Allowed: signup, recovery, magiclink', NEW.type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_verification_token_type
  BEFORE INSERT OR UPDATE ON public.verification_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_verification_token_type();

-- Restrict redirect_path to internal paths only (must start with /)
CREATE OR REPLACE FUNCTION public.validate_verification_redirect_path()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  -- Must start with / and not contain // (no protocol-relative URLs)
  -- Must not contain : (no absolute URLs like http:)
  IF NEW.redirect_path IS NULL
     OR LEFT(NEW.redirect_path, 1) != '/'
     OR LEFT(NEW.redirect_path, 2) = '//'
     OR position(':' in NEW.redirect_path) > 0
  THEN
    RAISE EXCEPTION 'redirect_path must be an internal path starting with /';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_verification_redirect_path
  BEFORE INSERT OR UPDATE ON public.verification_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_verification_redirect_path();

-- Enable RLS - no public access at all
ALTER TABLE public.verification_tokens ENABLE ROW LEVEL SECURITY;

-- Staff can read for diagnostics (but not token_hash ideally - RLS can't filter columns, 
-- so we allow row access but the edge function controls what's returned)
CREATE POLICY "Staff can read verification tokens"
  ON public.verification_tokens
  FOR SELECT
  USING (public.is_staff(auth.uid()));

-- No insert/update/delete policies for regular users
-- Only service_role (edge functions) can insert and update
