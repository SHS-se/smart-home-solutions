-- invoice_computed_totals is security_invoker, so customer-facing totals only
-- include line items the customer can select. Customers may already view their
-- issued invoice rows; allow the matching invoice lines too.

DROP POLICY IF EXISTS "Customers can view own invoice line items" ON public.invoice_line_items;

CREATE POLICY "Customers can view own invoice line items"
  ON public.invoice_line_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.invoices i
      JOIN public.customers c ON c.id = i.customer_id
      WHERE i.id = invoice_line_items.invoice_id
        AND c.user_id = auth.uid()
        AND i.status IN ('open', 'paid', 'void', 'overdue')
    )
  );

-- Stripe subscription invoices are created only after card payment succeeds, so
-- their due date should not stay on the ordinary 30-day manual-payment term.
UPDATE public.invoices i
SET
  due_date = COALESCE(i.paid_at::date, p.payment_date),
  updated_at = now()
FROM (
  SELECT invoice_id, MIN(payment_date) AS payment_date
  FROM public.invoice_payments
  WHERE method = 'stripe'
  GROUP BY invoice_id
) p
WHERE p.invoice_id = i.id
  AND i.status = 'paid'
  AND i.stripe_invoice_id IS NOT NULL
  AND COALESCE(i.paid_at::date, p.payment_date) IS NOT NULL
  AND i.due_date IS DISTINCT FROM COALESCE(i.paid_at::date, p.payment_date);
