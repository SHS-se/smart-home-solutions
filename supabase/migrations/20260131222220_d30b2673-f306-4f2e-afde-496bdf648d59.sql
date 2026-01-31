-- Create bom_price_revisions table to track pricing revisions per BOM
CREATE TABLE public.bom_price_revisions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bom_id uuid NOT NULL REFERENCES public.boms(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  UNIQUE(bom_id, revision)
);

-- Create bom_price_revision_items table to snapshot prices at revision time
CREATE TABLE public.bom_price_revision_items (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bom_price_revision_id uuid NOT NULL REFERENCES public.bom_price_revisions(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.skus(id),
  quantity integer NOT NULL DEFAULT 1,
  cost_ex_vat numeric NOT NULL,
  sell_ex_vat numeric NOT NULL,
  vat_rate numeric NOT NULL DEFAULT 0.25,
  margin_pct numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Add version tracking to quotes table
ALTER TABLE public.quotes 
ADD COLUMN IF NOT EXISTS bom_version integer,
ADD COLUMN IF NOT EXISTS bom_price_revision_id uuid REFERENCES public.bom_price_revisions(id);

-- Enable RLS on new tables
ALTER TABLE public.bom_price_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_price_revision_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for bom_price_revisions (staff only)
CREATE POLICY "Staff can view bom_price_revisions" ON public.bom_price_revisions
  FOR SELECT USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert bom_price_revisions" ON public.bom_price_revisions
  FOR INSERT WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update bom_price_revisions" ON public.bom_price_revisions
  FOR UPDATE USING (is_staff(auth.uid()));

CREATE POLICY "Staff can delete bom_price_revisions" ON public.bom_price_revisions
  FOR DELETE USING (is_staff(auth.uid()));

-- RLS policies for bom_price_revision_items (staff only)
CREATE POLICY "Staff can view bom_price_revision_items" ON public.bom_price_revision_items
  FOR SELECT USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert bom_price_revision_items" ON public.bom_price_revision_items
  FOR INSERT WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update bom_price_revision_items" ON public.bom_price_revision_items
  FOR UPDATE USING (is_staff(auth.uid()));

CREATE POLICY "Staff can delete bom_price_revision_items" ON public.bom_price_revision_items
  FOR DELETE USING (is_staff(auth.uid()));

-- Create index for faster lookups
CREATE INDEX idx_bom_price_revisions_bom_id ON public.bom_price_revisions(bom_id);
CREATE INDEX idx_bom_price_revision_items_revision_id ON public.bom_price_revision_items(bom_price_revision_id);