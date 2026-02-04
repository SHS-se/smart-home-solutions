-- Drop existing policy and recreate with status filter
DROP POLICY IF EXISTS "Customers can view their own invoices" ON public.invoices;

CREATE POLICY "Customers can view their own invoices"
ON public.invoices
FOR SELECT
USING (
  customer_id IN (
    SELECT id FROM public.customers WHERE user_id = auth.uid()
  )
  AND status IN ('open', 'paid', 'void', 'overdue')
);