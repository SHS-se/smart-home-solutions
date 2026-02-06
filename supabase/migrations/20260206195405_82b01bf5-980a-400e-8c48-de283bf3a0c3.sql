
-- Add revision audit columns to boms
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_reason_type text;
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_reason_note text;
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_created_by uuid;
ALTER TABLE public.boms ADD COLUMN IF NOT EXISTS revision_created_at timestamptz;

-- Create bom_events table
CREATE TABLE IF NOT EXISTS public.bom_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL REFERENCES public.boms(id),
  event_type text NOT NULL,
  actor_email text,
  actor_type text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS for bom_events (staff only)
ALTER TABLE public.bom_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read bom_events"
  ON public.bom_events FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert bom_events"
  ON public.bom_events FOR INSERT
  TO authenticated
  WITH CHECK (public.is_staff(auth.uid()));
