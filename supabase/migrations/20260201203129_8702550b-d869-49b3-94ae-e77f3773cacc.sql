-- Add new columns to existing invoices table
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_number TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_quote_id TEXT,
  ADD COLUMN IF NOT EXISTS bom_id UUID REFERENCES public.boms(id),
  ADD COLUMN IF NOT EXISTS bom_version INTEGER,
  ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES public.quotes(id),
  ADD COLUMN IF NOT EXISTS quote_number TEXT,
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS tax NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS hosted_invoice_url TEXT,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_emailed_to TEXT,
  ADD COLUMN IF NOT EXISTS last_emailed_type TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID;

-- Update status column to use new constraint
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices 
  ALTER COLUMN status SET DEFAULT 'draft';

-- Create invoice number sequence
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- Create invoice line items table if not exists
CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  line_type TEXT NOT NULL CHECK (line_type IN ('hardware', 'labor', 'travel_other')),
  description TEXT NOT NULL,
  sku TEXT,
  sku_id UUID REFERENCES public.skus(id),
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit TEXT,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 25,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create invoice events table if not exists
CREATE TABLE IF NOT EXISTS public.invoice_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

-- Update timestamp trigger
DROP TRIGGER IF EXISTS update_invoices_updated_at ON public.invoices;
CREATE TRIGGER update_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

-- Enable RLS on new tables
ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_events ENABLE ROW LEVEL SECURITY;

-- Drop old policies if they exist
DROP POLICY IF EXISTS "Customers can view their own invoices" ON public.invoices;
DROP POLICY IF EXISTS "Staff can manage invoices" ON public.invoices;

-- Create new RLS policies for invoices
CREATE POLICY "Staff can view all invoices"
  ON public.invoices FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert invoices"
  ON public.invoices FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update invoices"
  ON public.invoices FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete draft invoices"
  ON public.invoices FOR DELETE
  USING (public.is_staff(auth.uid()) AND status = 'draft');

-- RLS Policies for invoice_line_items
CREATE POLICY "Staff can view all invoice line items"
  ON public.invoice_line_items FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert invoice line items"
  ON public.invoice_line_items FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update invoice line items"
  ON public.invoice_line_items FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete invoice line items"
  ON public.invoice_line_items FOR DELETE
  USING (public.is_staff(auth.uid()));

-- RLS Policies for invoice_events
CREATE POLICY "Staff can view all invoice events"
  ON public.invoice_events FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert invoice events"
  ON public.invoice_events FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id ON public.invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_events_invoice_id ON public.invoice_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON public.invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_invoice_id ON public.invoices(stripe_invoice_id);