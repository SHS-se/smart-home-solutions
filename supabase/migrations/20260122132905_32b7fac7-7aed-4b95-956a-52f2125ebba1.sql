-- Fix: Ensure staff_users table denies access to unauthenticated users
-- The existing policies use is_staff(auth.uid()) which returns false for anon users,
-- but we need to ensure RLS is properly enforced. Adding an explicit authenticated check.

-- Drop the existing SELECT policy and recreate with explicit auth check
DROP POLICY IF EXISTS "Staff can view all staff_users" ON public.staff_users;

-- Recreate the policy with explicit authentication requirement
CREATE POLICY "Staff can view all staff_users"
ON public.staff_users
FOR SELECT
TO authenticated
USING (is_staff(auth.uid()));