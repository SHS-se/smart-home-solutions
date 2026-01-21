-- =============================================
-- Customer Portal Database Schema
-- =============================================

-- 1) Staff users table for admin/staff access
CREATE TABLE public.staff_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('staff', 'admin')) DEFAULT 'staff',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;

-- 2) Customers table
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name text,
  billing_email text,
  phone text,
  address text,
  site_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 3) Customer users (maps auth users to customers)
CREATE TABLE public.customer_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('customer_admin', 'customer_user')) DEFAULT 'customer_user',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id, user_id)
);

CREATE INDEX idx_customer_users_user_id ON public.customer_users(user_id);
CREATE INDEX idx_customer_users_customer_id ON public.customer_users(customer_id);

ALTER TABLE public.customer_users ENABLE ROW LEVEL SECURITY;

-- 4) Tickets table
CREATE TABLE public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted', 'awaiting_response', 'awaiting_customer', 'closed')) DEFAULT 'submitted',
  email_token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_customer_id ON public.tickets(customer_id);
CREATE INDEX idx_tickets_email_token ON public.tickets(email_token);

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

-- 5) Ticket comments table
CREATE TABLE public.ticket_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_email text,
  author_type text NOT NULL CHECK (author_type IN ('customer', 'staff', 'system')),
  source text NOT NULL CHECK (source IN ('portal', 'email')) DEFAULT 'portal',
  body_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_comments_ticket_id ON public.ticket_comments(ticket_id);

ALTER TABLE public.ticket_comments ENABLE ROW LEVEL SECURITY;

-- 6) Ticket attachments table
CREATE TABLE public.ticket_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES public.ticket_comments(id) ON DELETE SET NULL,
  storage_path text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_attachments_ticket_id ON public.ticket_attachments(ticket_id);

ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

-- 7) Invoices table (read-only for v1)
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  external_id text,
  date date,
  amount numeric,
  currency text DEFAULT 'SEK',
  status text,
  pdf_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_customer_id ON public.invoices(customer_id);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- =============================================
-- Helper Functions (SECURITY DEFINER)
-- =============================================

-- Check if user is staff/admin
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_users WHERE user_id = _user_id
  )
$$;

-- Check if user is admin
CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_users WHERE user_id = _user_id AND role = 'admin'
  )
$$;

-- Get customer ID for a user
CREATE OR REPLACE FUNCTION public.get_customer_id_for_user(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT customer_id FROM public.customer_users WHERE user_id = _user_id LIMIT 1
$$;

-- Check if staff_users table is empty (for bootstrap)
CREATE OR REPLACE FUNCTION public.is_staff_table_empty()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.staff_users LIMIT 1)
$$;

-- =============================================
-- RLS Policies
-- =============================================

-- Staff Users Policies
CREATE POLICY "Staff can view all staff_users"
  ON public.staff_users FOR SELECT
  TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Bootstrap: first admin insert"
  ON public.staff_users FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff_table_empty() 
    AND auth.jwt() ->> 'email' LIKE '%@smarthomesolutions.se'
    AND user_id = auth.uid()
  );

CREATE POLICY "Admins can insert staff_users"
  ON public.staff_users FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin(auth.uid())
  );

CREATE POLICY "Admins can update staff_users"
  ON public.staff_users FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can delete staff_users"
  ON public.staff_users FOR DELETE
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Customers Policies
CREATE POLICY "Customers can view their own customer record"
  ON public.customers FOR SELECT
  TO authenticated
  USING (
    id = public.get_customer_id_for_user(auth.uid())
    OR public.is_staff(auth.uid())
  );

CREATE POLICY "Staff can manage customers"
  ON public.customers FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- Customer Users Policies
CREATE POLICY "Users can view their customer_users record"
  ON public.customer_users FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_staff(auth.uid())
  );

CREATE POLICY "Staff can manage customer_users"
  ON public.customer_users FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- Tickets Policies
CREATE POLICY "Customers can view their own tickets"
  ON public.tickets FOR SELECT
  TO authenticated
  USING (
    customer_id = public.get_customer_id_for_user(auth.uid())
    OR public.is_staff(auth.uid())
  );

CREATE POLICY "Customers can create tickets for their customer"
  ON public.tickets FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id = public.get_customer_id_for_user(auth.uid())
    OR public.is_staff(auth.uid())
  );

CREATE POLICY "Customers can update their own tickets"
  ON public.tickets FOR UPDATE
  TO authenticated
  USING (
    customer_id = public.get_customer_id_for_user(auth.uid())
    OR public.is_staff(auth.uid())
  );

CREATE POLICY "Staff can delete tickets"
  ON public.tickets FOR DELETE
  TO authenticated
  USING (public.is_staff(auth.uid()));

-- Ticket Comments Policies
CREATE POLICY "Users can view comments on accessible tickets"
  ON public.ticket_comments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_id
      AND (t.customer_id = public.get_customer_id_for_user(auth.uid()) OR public.is_staff(auth.uid()))
    )
  );

CREATE POLICY "Users can add comments to accessible tickets"
  ON public.ticket_comments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_id
      AND (t.customer_id = public.get_customer_id_for_user(auth.uid()) OR public.is_staff(auth.uid()))
    )
  );

-- Ticket Attachments Policies
CREATE POLICY "Users can view attachments on accessible tickets"
  ON public.ticket_attachments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_id
      AND (t.customer_id = public.get_customer_id_for_user(auth.uid()) OR public.is_staff(auth.uid()))
    )
  );

CREATE POLICY "Users can add attachments to accessible tickets"
  ON public.ticket_attachments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_id
      AND (t.customer_id = public.get_customer_id_for_user(auth.uid()) OR public.is_staff(auth.uid()))
    )
  );

-- Invoices Policies
CREATE POLICY "Customers can view their own invoices"
  ON public.invoices FOR SELECT
  TO authenticated
  USING (
    customer_id = public.get_customer_id_for_user(auth.uid())
    OR public.is_staff(auth.uid())
  );

CREATE POLICY "Staff can manage invoices"
  ON public.invoices FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- =============================================
-- Trigger for updated_at
-- =============================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  NEW.last_activity_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_tickets_updated_at
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();