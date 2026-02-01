-- Add invoice-related columns to quotes table
ALTER TABLE public.quotes
ADD COLUMN IF NOT EXISTS stripe_invoice_id text,
ADD COLUMN IF NOT EXISTS invoice_status text DEFAULT 'not_created',
ADD COLUMN IF NOT EXISTS invoice_hosted_url text,
ADD COLUMN IF NOT EXISTS invoice_pdf_url text,
ADD COLUMN IF NOT EXISTS invoice_number text,
ADD COLUMN IF NOT EXISTS invoice_due_date date,
ADD COLUMN IF NOT EXISTS invoice_subtotal numeric,
ADD COLUMN IF NOT EXISTS invoice_vat numeric,
ADD COLUMN IF NOT EXISTS invoice_total numeric;

-- Create index for invoice lookups
CREATE INDEX IF NOT EXISTS idx_quotes_stripe_invoice_id ON public.quotes(stripe_invoice_id);

-- Create billing_events table for audit log
CREATE TABLE IF NOT EXISTS public.billing_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_id uuid REFERENCES public.quotes(id),
  stripe_quote_id text,
  stripe_invoice_id text,
  event_type text NOT NULL,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

-- Create indexes for billing_events
CREATE INDEX IF NOT EXISTS idx_billing_events_quote_id ON public.billing_events(quote_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_event_type ON public.billing_events(event_type);
CREATE INDEX IF NOT EXISTS idx_billing_events_created_at ON public.billing_events(created_at DESC);

-- Enable RLS on billing_events
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

-- Staff can view billing events
CREATE POLICY "Staff can view billing_events"
ON public.billing_events
FOR SELECT
USING (is_staff(auth.uid()));

-- Staff can insert billing events
CREATE POLICY "Staff can insert billing_events"
ON public.billing_events
FOR INSERT
WITH CHECK (is_staff(auth.uid()));

-- Create quote_emails table to track sent emails
CREATE TABLE IF NOT EXISTS public.quote_emails (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES public.quotes(id),
  invoice_id text,
  email_type text NOT NULL, -- 'quote', 'invoice', 'reminder'
  recipient_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  sent_by uuid REFERENCES auth.users(id)
);

-- Create indexes for quote_emails
CREATE INDEX IF NOT EXISTS idx_quote_emails_quote_id ON public.quote_emails(quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_emails_sent_at ON public.quote_emails(sent_at DESC);

-- Enable RLS on quote_emails
ALTER TABLE public.quote_emails ENABLE ROW LEVEL SECURITY;

-- Staff can view quote emails
CREATE POLICY "Staff can view quote_emails"
ON public.quote_emails
FOR SELECT
USING (is_staff(auth.uid()));

-- Staff can insert quote emails
CREATE POLICY "Staff can insert quote_emails"
ON public.quote_emails
FOR INSERT
WITH CHECK (is_staff(auth.uid()));