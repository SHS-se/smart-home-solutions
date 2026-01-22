-- Create contacts table for form submissions
CREATE TABLE public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  converted_to_customer_id uuid REFERENCES public.customers(id),
  converted_at timestamptz
);

-- Enable RLS
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

-- Staff can do everything
CREATE POLICY "Staff can manage contacts"
  ON public.contacts FOR ALL
  USING (is_staff(auth.uid()))
  WITH CHECK (is_staff(auth.uid()));