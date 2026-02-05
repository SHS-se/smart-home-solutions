-- The customers_with_identity view uses security_invoker=on, which means it checks RLS on underlying tables.
-- The contacts table only allows staff to SELECT, so customers can't see their own contact data through the view.
-- 
-- Solution: Add a policy allowing customers to view contacts linked to their customer record.

-- Allow customers to view the contact record linked to their customer
CREATE POLICY "Customers can view their linked contact"
ON public.contacts
FOR SELECT
USING (
  id IN (
    SELECT contact_id FROM public.customers WHERE user_id = auth.uid()
  )
);