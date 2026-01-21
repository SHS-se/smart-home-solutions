-- Allow customers to update their own customer record
CREATE POLICY "Customers can update their own customer record"
ON public.customers
FOR UPDATE
USING (id = get_customer_id_for_user(auth.uid()))
WITH CHECK (id = get_customer_id_for_user(auth.uid()));