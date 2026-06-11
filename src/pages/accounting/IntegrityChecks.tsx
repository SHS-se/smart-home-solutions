import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEKDecimal } from '@/lib/accounting-utils';
import { AR_ACCOUNT, STRIPE_CLEARING_ACCOUNT, OUTPUT_VAT_BY_RATE, SALES_VERIFICATION_SOURCE_TYPES } from '@/lib/sales-accounting';
import { isInvoicePostable, type PostableInvoice } from '@/lib/sales-posting';
import { Info, CheckCircle, AlertTriangle } from 'lucide-react';

interface IntegrityCheck {
  name: string;
  description: string;
  issueCount: number;
  detail?: string;
  link?: string;
  warningOnly?: boolean;
}

const IntegrityChecks: React.FC = () => {
  const { t } = useLanguage();

  const { data: checks, isLoading } = useQuery({
    queryKey: ['acc-integrity-checks'],
    queryFn: async (): Promise<IntegrityCheck[]> => {
      const [
        { data: verifications },
        { data: journalLines },
        { data: invoices },
        { data: links },
        { data: payments },
        { data: totals },
        { data: filedVatPeriods },
      ] = await Promise.all([
        supabase.from('acc_verifications').select('id, verification_number, source_type, source_id, verification_date').eq('is_posted', true),
        supabase.from('acc_journal_lines').select('verification_id, account, debit, credit'),
        supabase.from('invoices').select('id, invoice_number, status, finalized_at, issued_at, due_date, voided_at, customer_id').not('finalized_at', 'is', null),
        supabase.from('acc_sales_invoice_links').select('invoice_id, verification_id, posting_reason'),
        supabase.from('invoice_payments').select('id, invoice_id, amount'),
        supabase.from('invoice_computed_totals').select('*'),
        supabase.from('acc_vat_periods').select('year, quarter, status, snapshot_data').in('status', ['filed', 'locked']),
      ]);

      const lines = journalLines || [];
      const linkRows = links || [];
      const paymentRows = payments || [];
      const postableInvoices = (invoices || []).filter(inv => isInvoicePostable(inv as PostableInvoice));

      // 1. Every posted verification balances (debit = credit).
      const unbalanced = (verifications || []).filter(v => {
        const vLines = lines.filter(l => l.verification_id === v.id);
        const debit = vLines.reduce((s, l) => s + Number(l.debit), 0);
        const credit = vLines.reduce((s, l) => s + Number(l.credit), 0);
        return Math.abs(debit - credit) >= 0.01;
      });

      // 2. Finalized invoices not posted to accounting.
      const linkedIds = new Set(linkRows.map(l => l.invoice_id));
      const unpostedInvoices = postableInvoices.filter(inv => !linkedIds.has(inv.id));

      // 3. Recorded payments not posted to accounting.
      const postedPaymentIds = new Set((verifications || []).filter(v => v.source_type === 'customer_payment').map(v => v.source_id));
      const unpostedPayments = paymentRows.filter(p => !postedPaymentIds.has(p.id));

      // 4. AR control account (1510) balance vs open customer receivables.
      const accountBalance = (account: string) =>
        lines.filter(l => l.account === account).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
      const arBalance = accountBalance(AR_ACCOUNT);
      const openReceivables = postableInvoices
        .filter(inv => linkedIds.has(inv.id))
        .reduce((sum, inv) => {
          const total = Number((totals || []).find(tt => tt.invoice_id === inv.id)?.total ?? 0);
          const paid = paymentRows.filter(p => p.invoice_id === inv.id && postedPaymentIds.has(p.id)).reduce((s, p) => s + Number(p.amount), 0);
          return sum + Math.max(0, total - paid);
        }, 0);
      const arDiff = Math.abs(arBalance - openReceivables);

      // 5. VAT sales boxes vs posted sales VAT lines: output VAT accounts must
      //    only be touched by sales-type verifications.
      const salesVerificationIds = new Set((verifications || [])
        .filter(v => (SALES_VERIFICATION_SOURCE_TYPES as readonly string[]).includes(v.source_type))
        .map(v => v.id));
      const outputVatAccounts = new Set(Object.values(OUTPUT_VAT_BY_RATE).map(v => v.account));
      const foreignOutputVatLines = lines.filter(l => outputVatAccounts.has(l.account) && !salesVerificationIds.has(l.verification_id));

      // 6. Corrections into open periods for filed quarters are visible, not silently ignored.
      const corrections = (verifications || []).filter(v => v.source_type === 'sales_invoice_correction');

      // 7. Stripe clearing balance (informational): payments received via
      //    Stripe whose fee/payout is not yet booked.
      const stripeBalance = accountBalance(STRIPE_CLEARING_ACCOUNT);

      return [
        {
          name: t('Debet/kredit-balans', 'Debit/credit balance'),
          description: t('Alla bokförda verifikationer måste ha lika debet och kredit', 'All posted verifications must have equal debit and credit'),
          issueCount: unbalanced.length,
          detail: unbalanced.map(v => v.verification_number).join(', ') || undefined,
          link: unbalanced.length > 0 ? '/accounting/journal' : undefined,
        },
        {
          name: t('Obokförda försäljningsfakturor', 'Unposted sales invoices'),
          description: t('Slutförda fakturor som saknar verifikation i redovisningen', 'Finalized invoices without a verification in accounting'),
          issueCount: unpostedInvoices.length,
          detail: unpostedInvoices.map(inv => inv.invoice_number).join(', ') || undefined,
          link: unpostedInvoices.length > 0 ? '/accounting/sales' : undefined,
        },
        {
          name: t('Obokförda betalningar', 'Unposted payments'),
          description: t('Registrerade kundbetalningar som inte är bokförda', 'Recorded customer payments not posted to accounting'),
          issueCount: unpostedPayments.length,
          link: unpostedPayments.length > 0 ? '/accounting/payments' : undefined,
        },
        {
          name: t('Kundfordringar (1510) avstämning', 'AR control (1510) reconciliation'),
          description: t('Saldo på 1510 ska motsvara öppna kundfordringar', 'Balance on 1510 must equal open customer receivables'),
          issueCount: arDiff >= 0.01 ? 1 : 0,
          detail: arDiff >= 0.01
            ? t(`1510: ${formatSEKDecimal(arBalance)} · öppna fordringar: ${formatSEKDecimal(openReceivables)}`, `1510: ${formatSEKDecimal(arBalance)} · open receivables: ${formatSEKDecimal(openReceivables)}`)
            : undefined,
          link: arDiff >= 0.01 ? '/accounting/receivables' : undefined,
        },
        {
          name: t('Momsrutor mot försäljningsmoms', 'VAT boxes vs posted sales VAT'),
          description: t('Utgående moms 2611/2621/2631 får endast bokföras av försäljningsverifikationer', 'Output VAT 2611/2621/2631 may only be posted by sales verifications'),
          issueCount: foreignOutputVatLines.length,
          link: foreignOutputVatLines.length > 0 ? '/accounting/journal' : undefined,
        },
        {
          name: t('Korrigeringar i låsta perioder', 'Locked-period corrections'),
          description: corrections.length > 0
            ? t(`${corrections.length} korrigering(ar) för låsta perioder är bokförda i öppen period och ingår i nästa deklaration`, `${corrections.length} correction(s) for locked periods are posted in an open period and included in the next declaration`)
            : t('Inga korrigeringar för låsta perioder', 'No corrections for locked periods'),
          issueCount: 0,
          detail: corrections.map(v => `${v.verification_number} (${v.verification_date})`).join(', ') || undefined,
        },
        {
          name: t('Stripe clearing (1580)', 'Stripe clearing (1580)'),
          description: t('Saldo som väntar på bokföring av Stripe-avgift och utbetalning — härleds aldrig automatiskt', 'Balance awaiting Stripe fee and payout booking — never inferred automatically'),
          issueCount: Math.abs(stripeBalance) >= 0.01 ? 1 : 0,
          warningOnly: true,
          detail: Math.abs(stripeBalance) >= 0.01 ? formatSEKDecimal(stripeBalance) : undefined,
          link: Math.abs(stripeBalance) >= 0.01 ? '/accounting/payments' : undefined,
        },
        {
          name: t('Inlämnade momsperioder oförändrade', 'Filed VAT periods unchanged'),
          description: t('Inlämnade kvartal har kvar sin ögonblicksbild', 'Filed quarters retain their snapshot'),
          issueCount: (filedVatPeriods || []).filter(vp => !vp.snapshot_data).length,
          detail: (filedVatPeriods || []).filter(vp => !vp.snapshot_data).map(vp => `Q${vp.quarter} ${vp.year}`).join(', ') || undefined,
        },
      ];
    },
  });

  const issues = (checks || []).filter(c => c.issueCount > 0 && !c.warningOnly);
  const warnings = (checks || []).filter(c => c.issueCount > 0 && c.warningOnly);

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            {t('Integritetskontroll', 'Integrity checks')}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-5 h-5 text-primary cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {t(
                  'Kontroller av bokföringens integritet: balanserade verifikationer, obokförda fakturor/betalningar, avstämning av kundfordringar och momsrutor.',
                  'Accounting integrity checks: balanced verifications, unposted invoices/payments, receivables reconciliation and VAT boxes.'
                )}
              </TooltipContent>
            </Tooltip>
          </h1>
          <p className="text-muted-foreground mt-1">{t('Kontroll av bokföringens integritet och kvalitet', 'Verification of accounting integrity and quality')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">OK</p>
              <p className="text-xl font-bold mt-1 text-green-700">{checks ? checks.length - issues.length - warnings.length : '–'}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Varningar', 'Warnings')}</p>
              <p className={`text-xl font-bold mt-1 ${warnings.length > 0 ? 'text-amber-700' : ''}`}>{checks ? warnings.length : '–'}</p>
            </CardContent>
          </Card>
          <Card className="border border-border">
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">{t('Problem', 'Issues')}</p>
              <p className={`text-xl font-bold mt-1 ${issues.length > 0 ? 'text-red-700' : ''}`}>{checks ? issues.length : '–'}</p>
            </CardContent>
          </Card>
        </div>

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Kontroll', 'Check')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Beskrivning', 'Description')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Problem', 'Issues')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Åtgärd', 'Action')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : (checks || []).map(check => (
                  <TableRow key={check.name}>
                    <TableCell className="text-sm font-medium">{check.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {check.description}
                      {check.detail && <p className="text-xs mt-0.5">{check.detail}</p>}
                    </TableCell>
                    <TableCell className="text-sm text-right">{check.issueCount}</TableCell>
                    <TableCell>
                      {check.issueCount === 0 ? (
                        <span className="inline-flex items-center gap-1 text-sm text-green-700"><CheckCircle className="w-4 h-4" /> OK</span>
                      ) : check.warningOnly ? (
                        <span className="inline-flex items-center gap-1 text-sm text-amber-700"><AlertTriangle className="w-4 h-4" /> {t('Varning', 'Warning')}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm text-red-700"><AlertTriangle className="w-4 h-4" /> {t('Problem', 'Issue')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {check.link && check.issueCount > 0 && (
                        <Link to={check.link} className="text-sm text-primary hover:underline">{t('Åtgärda', 'Resolve')} →</Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default IntegrityChecks;
