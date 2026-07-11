import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isInvoicePostable, type PostableInvoice } from '@/lib/sales-posting';
import { fetchAllRows } from '@/lib/fetch-all-rows';

export interface SalesInvoiceRow extends PostableInvoice {
  customer: { name: string | null } | null;
  line_items: Array<{ description: string; quantity: number; unit_price: number; tax_rate: number; line_type: string | null }>;
  totals: { subtotal: number; tax: number; total: number } | null;
  link: { verification_id: string; posting_reason: string; verification: { verification_number: string | null } | null } | null;
  paidAmount: number;
}

/** Finalized non-void invoices joined with accounting links and payments. */
export function useSalesInvoices() {
  return useQuery({
    queryKey: ['acc-sales-invoices'],
    queryFn: async (): Promise<SalesInvoiceRow[]> => {
      const [invoices, totals, links, payments] = await Promise.all([
        fetchAllRows((from, to) =>
          supabase
            .from('invoices')
            .select('id, invoice_number, customer_id, status, finalized_at, issued_at, due_date, voided_at, customer:customers_with_identity!invoices_customer_id_fkey(name), line_items:invoice_line_items(description, quantity, unit_price, tax_rate, line_type)')
            .not('finalized_at', 'is', null)
            .order('invoice_number')
            .order('id')
            .range(from, to)),
        fetchAllRows((from, to) =>
          supabase.from('invoice_computed_totals').select('*').order('invoice_id').range(from, to)),
        fetchAllRows((from, to) =>
          supabase.from('acc_sales_invoice_links').select('invoice_id, verification_id, posting_reason, verification:acc_verifications(verification_number)').order('invoice_id').range(from, to)),
        fetchAllRows((from, to) =>
          // invoice_id is not unique across payments — the id tiebreaker keeps
          // page boundaries deterministic so no payment is dropped or doubled.
          supabase.from('invoice_payments').select('id, invoice_id, amount').order('invoice_id').order('id').range(from, to)),
      ]);
      return (invoices || [])
        .filter((inv) => isInvoicePostable(inv as PostableInvoice))
        .map((inv) => ({
          ...(inv as unknown as SalesInvoiceRow),
          customer: (inv as { customer?: { name: string | null } | null }).customer ?? null,
          line_items: ((inv as { line_items?: SalesInvoiceRow['line_items'] }).line_items || []).map(li => ({
            ...li,
            quantity: Number(li.quantity),
            unit_price: Number(li.unit_price),
            tax_rate: Number(li.tax_rate),
          })),
          totals: (() => {
            const row = (totals || []).find(tt => tt.invoice_id === inv.id);
            return row ? { subtotal: Number(row.subtotal), tax: Number(row.tax), total: Number(row.total) } : null;
          })(),
          link: (links || []).find(l => l.invoice_id === inv.id) as SalesInvoiceRow['link'] ?? null,
          paidAmount: (payments || []).filter(p => p.invoice_id === inv.id).reduce((s, p) => s + Number(p.amount), 0),
        }));
    },
  });
}
