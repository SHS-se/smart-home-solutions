
-- Create contact_intake_events table to log every contact form submission attempt
CREATE TABLE public.contact_intake_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  email text NOT NULL,
  email_normalized text NOT NULL,
  name text NOT NULL,
  phone text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result text NOT NULL,  -- 'saved', 'duplicate', 'save_failed'
  matched_entity_type text,  -- 'contacts' or 'customers'
  matched_entity_id uuid,
  error jsonb,
  source text NOT NULL DEFAULT 'website_contact_form'
);

-- Enable RLS
ALTER TABLE public.contact_intake_events ENABLE ROW LEVEL SECURITY;

-- Staff-only SELECT policy (edge function writes via service role, no INSERT policy needed for anon)
CREATE POLICY "Staff can view intake events"
  ON public.contact_intake_events
  FOR SELECT
  USING (public.is_staff(auth.uid()));
