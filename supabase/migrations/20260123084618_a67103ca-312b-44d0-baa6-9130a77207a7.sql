-- Phase 1.1: Add user_id column to customers table
ALTER TABLE public.customers
ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL UNIQUE;

-- Phase 1.2: Migrate existing data from customer_users
UPDATE public.customers c
SET user_id = cu.user_id
FROM public.customer_users cu
WHERE cu.customer_id = c.id;

-- Phase 1.3: Update get_customer_id_for_user() function to query customers directly
CREATE OR REPLACE FUNCTION public.get_customer_id_for_user(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.customers WHERE user_id = _user_id LIMIT 1
$$;

-- Phase 1.4: Update RLS policies on customers table
DROP POLICY IF EXISTS "Customers can view their own customer record" ON public.customers;
CREATE POLICY "Customers can view their own customer record"
ON public.customers FOR SELECT
USING ((user_id = auth.uid()) OR is_staff(auth.uid()));

DROP POLICY IF EXISTS "Customers can update their own customer record" ON public.customers;
CREATE POLICY "Customers can update their own customer record"
ON public.customers FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Phase 1.5: Drop customer_users table
DROP TABLE IF EXISTS public.customer_users;