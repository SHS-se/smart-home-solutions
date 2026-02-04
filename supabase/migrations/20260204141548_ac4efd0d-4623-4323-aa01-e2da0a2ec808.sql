-- Add policy for customers to view their own invoices
CREATE POLICY "Customers can view their own invoices"
ON public.invoices
FOR SELECT
USING (
  customer_id IN (
    SELECT id FROM public.customers WHERE user_id = auth.uid()
  )
);