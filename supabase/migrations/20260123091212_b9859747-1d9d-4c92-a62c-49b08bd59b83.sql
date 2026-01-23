-- Fix RLS policies to block anonymous/public access on sensitive tables
-- Issue: RESTRICTIVE policies without any PERMISSIVE policy means no access by default,
-- but we need to explicitly ensure authenticated-only access patterns

-- =====================================================
-- CONTACTS TABLE - Staff only access
-- =====================================================
-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Staff can manage contacts" ON public.contacts;

-- Create a PERMISSIVE policy for staff (SELECT, INSERT, UPDATE, DELETE)
CREATE POLICY "Staff can view contacts"
ON public.contacts
FOR SELECT
TO authenticated
USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert contacts"
ON public.contacts
FOR INSERT
TO authenticated
WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update contacts"
ON public.contacts
FOR UPDATE
TO authenticated
USING (is_staff(auth.uid()))
WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can delete contacts"
ON public.contacts
FOR DELETE
TO authenticated
USING (is_staff(auth.uid()));

-- =====================================================
-- CUSTOMERS TABLE - Customer owns record OR staff access
-- =====================================================
-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Customers can view their own customer record" ON public.customers;
DROP POLICY IF EXISTS "Customers can update their own customer record" ON public.customers;
DROP POLICY IF EXISTS "Staff can manage customers" ON public.customers;

-- Create PERMISSIVE policies with proper authenticated role
CREATE POLICY "Customers can view their own record"
ON public.customers
FOR SELECT
TO authenticated
USING ((user_id = auth.uid()) OR is_staff(auth.uid()));

CREATE POLICY "Customers can update their own record"
ON public.customers
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Staff can insert customers"
ON public.customers
FOR INSERT
TO authenticated
WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update customers"
ON public.customers
FOR UPDATE
TO authenticated
USING (is_staff(auth.uid()))
WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can delete customers"
ON public.customers
FOR DELETE
TO authenticated
USING (is_staff(auth.uid()));

-- =====================================================
-- STAFF_USERS TABLE - Staff only access (already has good policies, just need to ensure authenticated role)
-- =====================================================
-- Drop existing policies
DROP POLICY IF EXISTS "Staff can view all staff_users" ON public.staff_users;
DROP POLICY IF EXISTS "Admins can insert staff_users" ON public.staff_users;
DROP POLICY IF EXISTS "Admins can update staff_users" ON public.staff_users;
DROP POLICY IF EXISTS "Admins can delete staff_users" ON public.staff_users;
DROP POLICY IF EXISTS "Bootstrap: first admin insert" ON public.staff_users;

-- Recreate policies with explicit authenticated role
CREATE POLICY "Staff can view all staff_users"
ON public.staff_users
FOR SELECT
TO authenticated
USING (is_staff(auth.uid()));

CREATE POLICY "Admins can insert staff_users"
ON public.staff_users
FOR INSERT
TO authenticated
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update staff_users"
ON public.staff_users
FOR UPDATE
TO authenticated
USING (is_admin(auth.uid()))
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can delete staff_users"
ON public.staff_users
FOR DELETE
TO authenticated
USING (is_admin(auth.uid()));

-- Bootstrap policy for first admin (still needed for initial setup)
CREATE POLICY "Bootstrap: first admin insert"
ON public.staff_users
FOR INSERT
TO authenticated
WITH CHECK (
  is_staff_table_empty() 
  AND ((auth.jwt() ->> 'email'::text) ~~ '%@smarthomesolutions.se'::text) 
  AND (user_id = auth.uid())
);