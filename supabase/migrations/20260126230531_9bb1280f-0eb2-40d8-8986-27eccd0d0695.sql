-- Create SKUs table for product catalog
CREATE TABLE public.skus (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  supplier TEXT,
  supplier_url TEXT,
  cost_ex_vat NUMERIC,
  default_margin NUMERIC,
  notes TEXT,
  image_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create margin_rules table for category-based pricing
CREATE TABLE public.margin_rules (
  category TEXT NOT NULL PRIMARY KEY,
  description TEXT,
  margin_percent NUMERIC NOT NULL DEFAULT 0,
  rounding INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create templates table for reusable BOM bundles
CREATE TABLE public.templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create template_items table for template SKU items
CREATE TABLE public.template_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES public.templates(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(template_id, sku_id)
);

-- Create boms table for Bill of Materials
CREATE TABLE public.boms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  project_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create bom_items table for BOM line items
CREATE TABLE public.bom_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bom_id UUID NOT NULL REFERENCES public.boms(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  cost NUMERIC,
  sell_price NUMERIC,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(bom_id, sku_id)
);

-- Create quotes table for quote preparation
CREATE TABLE public.quotes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_number TEXT NOT NULL UNIQUE,
  bom_id UUID REFERENCES public.boms(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  hardware_total NUMERIC NOT NULL DEFAULT 0,
  labor_total NUMERIC NOT NULL DEFAULT 0,
  travel_total NUMERIC NOT NULL DEFAULT 0,
  stripe_quote_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create quote_lines table for custom quote line items
CREATE TABLE public.quote_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quote_id UUID NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  section TEXT NOT NULL, -- 'hardware', 'labor', 'travel'
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 1,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create sequence for quote numbers
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START WITH 1;

-- Create function to generate quote numbers
CREATE OR REPLACE FUNCTION public.generate_quote_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.quote_number := 'Q-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('quote_number_seq')::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

-- Create trigger for quote number generation
CREATE TRIGGER set_quote_number
  BEFORE INSERT ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_quote_number();

-- Enable RLS on all tables
ALTER TABLE public.skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.margin_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_lines ENABLE ROW LEVEL SECURITY;

-- RLS Policies for skus (staff only)
CREATE POLICY "Staff can view skus" ON public.skus FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert skus" ON public.skus FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update skus" ON public.skus FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete skus" ON public.skus FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for margin_rules (staff only)
CREATE POLICY "Staff can view margin_rules" ON public.margin_rules FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert margin_rules" ON public.margin_rules FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update margin_rules" ON public.margin_rules FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete margin_rules" ON public.margin_rules FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for templates (staff only)
CREATE POLICY "Staff can view templates" ON public.templates FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert templates" ON public.templates FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update templates" ON public.templates FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete templates" ON public.templates FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for template_items (staff only)
CREATE POLICY "Staff can view template_items" ON public.template_items FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert template_items" ON public.template_items FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update template_items" ON public.template_items FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete template_items" ON public.template_items FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for boms (staff only)
CREATE POLICY "Staff can view boms" ON public.boms FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert boms" ON public.boms FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update boms" ON public.boms FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete boms" ON public.boms FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for bom_items (staff only)
CREATE POLICY "Staff can view bom_items" ON public.bom_items FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert bom_items" ON public.bom_items FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update bom_items" ON public.bom_items FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete bom_items" ON public.bom_items FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for quotes (staff only)
CREATE POLICY "Staff can view quotes" ON public.quotes FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert quotes" ON public.quotes FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update quotes" ON public.quotes FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete quotes" ON public.quotes FOR DELETE USING (is_staff(auth.uid()));

-- RLS Policies for quote_lines (staff only)
CREATE POLICY "Staff can view quote_lines" ON public.quote_lines FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert quote_lines" ON public.quote_lines FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update quote_lines" ON public.quote_lines FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete quote_lines" ON public.quote_lines FOR DELETE USING (is_staff(auth.uid()));

-- Insert default margin rules
INSERT INTO public.margin_rules (category, description, margin_percent, rounding) VALUES
  ('Sensorer', 'Temperatur-, rörelse- och kontaktsensorer', 35, 5),
  ('Controllers', 'Hubbar och styrsystem', 25, 5),
  ('Reläer', 'Relämoduler och aktuatorer', 30, 5),
  ('Material', 'Kablar, installationsmaterial', 60, 10),
  ('Tjänst', 'Arbetstid och resa (fast pris)', 0, 10);

-- Create storage bucket for SKU images
INSERT INTO storage.buckets (id, name, public) VALUES ('sku-images', 'sku-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for sku-images bucket
CREATE POLICY "SKU images are publicly accessible" ON storage.objects 
  FOR SELECT USING (bucket_id = 'sku-images');

CREATE POLICY "Staff can upload SKU images" ON storage.objects 
  FOR INSERT WITH CHECK (bucket_id = 'sku-images' AND is_staff(auth.uid()));

CREATE POLICY "Staff can update SKU images" ON storage.objects 
  FOR UPDATE USING (bucket_id = 'sku-images' AND is_staff(auth.uid()));

CREATE POLICY "Staff can delete SKU images" ON storage.objects 
  FOR DELETE USING (bucket_id = 'sku-images' AND is_staff(auth.uid()));