import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSEK, formatSEKDecimal } from '@/lib/accounting-utils';
import { getInvoiceEconomicDate } from '@/lib/sales-posting';
import { useSalesInvoices } from '@/hooks/use-sales-invoices';
import { Info, AlertCircle } from 'lucide-react';

const DAY_MS = 24 * 60 * 60 * 1000;

type DueStatus = 'overdue' | 'due_soon' | 'current';

function getDueStatus(dueDate: string | null, today: Date): DueStatus {
  if (!dueDate) return 'current';
  const days = Math.floor((new Date(dueDate).getTime() - today.getTime()) / DAY_MS);
  if (days < 0) return 'overdue';
  if (days <= 14) return 'due_soon';
  return 'current';
}

const ReceivablesList: React.FC = () => {
  const { t, language } = useLanguage();
  const { data: invoices, isLoading } = useSalesInvoices();
  const today = new Date();

  // A receivable exists once the invoice is posted to 1510 and not fully settled.
  const receivables = (invoices || [])
    .filter(inv => inv.link)
    .map(inv => ({ ...inv, openAmount: Math.max(0, (inv.totals?.total ?? 0) - inv.paidAmount) }))
    .filter(inv => inv.openAmount > 0.005);

  const byStatus = (status: DueStatus) => receivables.filter(inv => getDueStatus(inv.due_date, today) === status);
  const sum = (list: typeof receivables) => list.reduce((s, inv) => s + inv.openAmount, 0);
  const overdue = byStatus('overdue');
  const dueSoon = byStatus('due_soon');
  const current = byStatus('current');

  const agingBuckets = [
    { label: t('Aktuella (0–30 dagar)', 'Current (0–30 days)'), min: -30, max: 0 },
    { label: t('1–30 dagar försenade', '1–30 days overdue'), min: 1, max: 30 },
    { label: t('31–60 dagar', '31–60 days'), min: 31, max: 60 },
    { label: t('61–90 dagar', '61–90 days'), min: 61, max: 90 },
    { label: t('90+ dagar', '90+ days'), min: 91, max: Infinity },
  ].map(bucket => ({
    ...bucket,
    amount: sum(receivables.filter(inv => {
      const overdueDays = inv.due_date ? Math.floor((today.getTime() - new Date(inv.due_date).getTime()) / DAY_MS) : 0;
      return overdueDays >= bucket.min && overdueDays <= bucket.max;
    })),
  }));

  const statusBadge = (status: DueStatus) => status === 'overdue'
    ? <Badge className="bg-red-100 text-red-800 border-0 text-xs">{t('Förfallen', 'Overdue')}</Badge>
    : status === 'due_soon'
      ? <Badge className="bg-amber-100 text-amber-800 border-0 text-xs">{t('Förfaller snart', 'Due soon')}</Badge>
      : <Badge className="bg-green-100 text-green-800 border-0 text-xs">{t('Aktuell', 'Current')}</Badge>;

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB') : '–';

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            {t('Kundfordringar', 'Accounts receivable')}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-5 h-5 text-primary cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {t(
                  'Bokförda kundfakturor som ännu inte är fullt betalda. Saldot motsvarar konto 1510 Kundfordringar minus bokförda betalningar.',
                  'Posted customer invoices not yet fully paid. The balance corresponds to account 1510 Accounts receivable minus posted payments.'
                )}
              </TooltipContent>
            </Tooltip>
          </h1>
          <p className="text-muted-foreground mt-1">{t('Öppna kundfakturor och förfallodatum', 'Open customer invoices and due dates')}</p>
        </div>

        {overdue.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-800">
                {t(`${overdue.length} förfall${overdue.length > 1 ? 'na' : 'en'} faktur${overdue.length > 1 ? 'or' : 'a'}`, `${overdue.length} overdue invoice${overdue.length > 1 ? 's' : ''}`)}
              </p>
              <p className="text-sm text-red-700 mt-0.5">
                {t(`Totalt ${formatSEK(sum(overdue))} i försenade betalningar.`, `Total ${formatSEK(sum(overdue))} in late payments.`)}
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { label: t('Totalt utestått', 'Total outstanding'), value: sum(receivables), detail: `${receivables.length} ${t('fakturor', 'invoices')}`, className: '' },
            { label: t('Förfallet', 'Overdue'), value: sum(overdue), detail: `${overdue.length} ${t('fakturor', 'invoices')}`, className: 'text-red-700' },
            { label: t('Förfaller snart', 'Due soon'), value: sum(dueSoon), detail: `${dueSoon.length} ${t('fakturor', 'invoices')}`, className: 'text-amber-700' },
            { label: t('Aktuella', 'Current'), value: sum(current), detail: `${current.length} ${t('fakturor', 'invoices')}`, className: '' },
          ].map((card) => (
            <Card key={card.label} className="border border-border">
              <CardContent className="p-5">
                <p className="text-xs text-muted-foreground">{card.label}</p>
                <p className={`text-xl font-bold mt-1 ${card.className}`}>{formatSEK(card.value)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.detail}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Kund', 'Customer')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Faktura', 'Invoice')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Fakturadatum', 'Invoice date')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Förfallodatum', 'Due date')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp', 'Amount')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Verifikation', 'Verification')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : receivables.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">{t('Inga öppna kundfordringar', 'No open receivables')}</TableCell></TableRow>
                ) : receivables.map(inv => (
                  <TableRow key={inv.id}>
                    <TableCell className="text-sm">{inv.customer?.name || '–'}</TableCell>
                    <TableCell className="text-sm font-medium">{inv.invoice_number}</TableCell>
                    <TableCell className="text-sm">{formatDate(getInvoiceEconomicDate(inv))}</TableCell>
                    <TableCell className="text-sm">{formatDate(inv.due_date)}</TableCell>
                    <TableCell className="text-sm text-right">{formatSEKDecimal(inv.openAmount)}</TableCell>
                    <TableCell>{statusBadge(getDueStatus(inv.due_date, today))}</TableCell>
                    <TableCell className="text-sm text-primary">
                      {inv.link?.verification?.verification_number ? (
                        <Link to={`/accounting/journal?verification=${inv.link.verification_id}`} className="hover:underline">
                          {inv.link.verification.verification_number}
                        </Link>
                      ) : '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border border-border">
          <CardContent className="p-6">
            <h3 className="font-semibold mb-4">{t('Åldersanalys', 'Aging analysis')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {agingBuckets.map(bucket => (
                <div key={bucket.label} className="bg-muted/30 rounded-lg p-4">
                  <p className="text-xs text-muted-foreground">{bucket.label}</p>
                  <p className={`text-lg font-bold mt-1 ${bucket.min > 0 && bucket.amount > 0 ? 'text-red-700' : ''}`}>{formatSEK(bucket.amount)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default ReceivablesList;
