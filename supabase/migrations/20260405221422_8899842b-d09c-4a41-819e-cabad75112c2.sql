
-- =============================================
-- ACCOUNTING MODULE: Database Schema
-- =============================================

-- 1. Suppliers table
CREATE TABLE public.acc_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  org_number text,
  vat_number text,
  country text NOT NULL DEFAULT 'SE',
  supplier_type text NOT NULL DEFAULT 'domestic' CHECK (supplier_type IN ('domestic', 'eu', 'non_eu')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acc_suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage suppliers" ON public.acc_suppliers
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- 2. Accounting periods
CREATE TABLE public.acc_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year integer NOT NULL,
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'review', 'closed', 'locked')),
  locked_at timestamptz,
  locked_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);

ALTER TABLE public.acc_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage periods" ON public.acc_periods
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- 3. Purchases (purchase documents)
CREATE TABLE public.acc_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid REFERENCES public.acc_suppliers(id),
  document_type text NOT NULL DEFAULT 'supplier_invoice' CHECK (document_type IN ('receipt', 'supplier_invoice', 'other')),
  document_file_path text,
  document_date date NOT NULL,
  posting_date date,
  due_date date,
  currency text NOT NULL DEFAULT 'SEK',
  gross_amount numeric(12,2) NOT NULL DEFAULT 0,
  net_amount numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount numeric(12,2) NOT NULL DEFAULT 0,
  description text,
  payment_source text NOT NULL DEFAULT 'owner_paid' CHECK (payment_source IN ('owner_paid', 'company_bank')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'blocked', 'posted')),
  document_quality_status text NOT NULL DEFAULT 'pending' CHECK (document_quality_status IN ('pending', 'sufficient', 'insufficient', 'not_checked')),
  vat_evidence_status text NOT NULL DEFAULT 'pending' CHECK (vat_evidence_status IN ('pending', 'sufficient', 'insufficient', 'not_applicable')),
  notes text,
  verification_id uuid,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acc_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage purchases" ON public.acc_purchases
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- 4. Purchase lines
CREATE TABLE public.acc_purchase_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.acc_purchases(id) ON DELETE CASCADE,
  description text NOT NULL DEFAULT '',
  expense_account text NOT NULL DEFAULT '4000',
  vat_treatment text NOT NULL DEFAULT 'needs_review' CHECK (vat_treatment IN ('domestic_deductible', 'reverse_charge_eu_goods', 'reverse_charge_eu_services', 'reverse_charge_non_eu_services', 'non_deductible', 'no_vat', 'needs_review')),
  net_amount numeric(12,2) NOT NULL DEFAULT 0,
  vat_amount numeric(12,2) NOT NULL DEFAULT 0,
  gross_amount numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) NOT NULL DEFAULT 25.00,
  sort_order integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acc_purchase_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage purchase lines" ON public.acc_purchase_lines
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- 5. Verifications (posted journal entries)
CREATE TABLE public.acc_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_number text UNIQUE,
  verification_date date NOT NULL,
  description text NOT NULL DEFAULT '',
  period_id uuid REFERENCES public.acc_periods(id),
  source_type text NOT NULL DEFAULT 'purchase' CHECK (source_type IN ('purchase', 'manual', 'vat_adjustment')),
  source_id uuid,
  is_posted boolean NOT NULL DEFAULT false,
  posted_at timestamptz,
  posted_by uuid REFERENCES auth.users(id),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acc_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage verifications" ON public.acc_verifications
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- 6. Journal lines
CREATE TABLE public.acc_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL REFERENCES public.acc_verifications(id) ON DELETE CASCADE,
  account text NOT NULL,
  account_name text,
  description text,
  debit numeric(12,2) NOT NULL DEFAULT 0,
  credit numeric(12,2) NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acc_journal_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage journal lines" ON public.acc_journal_lines
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- 7. VAT periods (quarterly)
CREATE TABLE public.acc_vat_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year integer NOT NULL,
  quarter integer NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'approved', 'filed', 'locked')),
  deadline date,
  snapshot_data jsonb,
  snapshot_created_at timestamptz,
  snapshot_created_by uuid REFERENCES auth.users(id),
  snapshot_hash text,
  filing_confirmation_path text,
  filing_confirmed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, quarter)
);

ALTER TABLE public.acc_vat_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage vat periods" ON public.acc_vat_periods
  FOR ALL TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- Add foreign key from purchases to verifications
ALTER TABLE public.acc_purchases
  ADD CONSTRAINT acc_purchases_verification_id_fkey
  FOREIGN KEY (verification_id) REFERENCES public.acc_verifications(id);

-- Create storage bucket for purchase documents
INSERT INTO storage.buckets (id, name, public) VALUES ('purchase-documents', 'purchase-documents', false);

-- Storage RLS for purchase documents
CREATE POLICY "Staff can upload purchase docs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'purchase-documents' AND public.is_staff(auth.uid()));

CREATE POLICY "Staff can view purchase docs" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'purchase-documents' AND public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete purchase docs" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'purchase-documents' AND public.is_staff(auth.uid()));

-- Seed initial accounting periods
INSERT INTO public.acc_periods (year, month, status) VALUES
  (2026, 1, 'open'),
  (2026, 2, 'open'),
  (2026, 3, 'open'),
  (2026, 4, 'open');

-- Seed Q1 2026 VAT period
INSERT INTO public.acc_vat_periods (year, quarter, status, deadline) VALUES
  (2026, 1, 'open', '2026-05-12');

-- Verification number sequence
CREATE SEQUENCE IF NOT EXISTS acc_verification_number_seq START 1;

-- Function to allocate verification number
CREATE OR REPLACE FUNCTION public.allocate_acc_verification_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_next int;
BEGIN
  v_next := nextval('acc_verification_number_seq');
  RETURN 'V-2026-' || LPAD(v_next::text, 3, '0');
END;
$$;

-- Updated_at trigger for accounting tables
CREATE TRIGGER acc_suppliers_updated_at BEFORE UPDATE ON public.acc_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TRIGGER acc_periods_updated_at BEFORE UPDATE ON public.acc_periods
  FOR EACH ROW EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TRIGGER acc_purchases_updated_at BEFORE UPDATE ON public.acc_purchases
  FOR EACH ROW EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TRIGGER acc_vat_periods_updated_at BEFORE UPDATE ON public.acc_vat_periods
  FOR EACH ROW EXECUTE FUNCTION public.update_simple_updated_at();
