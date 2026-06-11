import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, Receipt, ShoppingCart, AlertCircle, ArrowRight, BookOpen, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MONTH_NAMES_SV, MONTH_NAMES_EN, PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN, PURCHASE_STATUS_COLORS, QUARTER_LABELS, formatSEK } from '@/lib/accounting-utils';
import { getActiveVatPeriod } from '@/lib/vat-periods';

const AccountingOverview: React.FC = () => {
  const { t, language } = useLanguage();
  const monthNames = language === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;

  const { data: periods } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('month', { ascending: false });
      return data || [];
    },
  });

  const { data: purchases } = useQuery({
    queryKey: ['acc-purchases-summary'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('id, status, gross_amount, document_date, supplier_id, description');
      return data || [];
    },
  });

  const { data: vatPeriods } = useQuery({
    queryKey: ['acc-vat-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_vat_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('quarter', { ascending: false });
      return data || [];
    },
  });

  const currentPeriod = periods?.[0];
  // Next active VAT declaration: earliest quarter not yet filed/locked —
  // the same derivation as VatPeriodsList and VatDeclarationFlow.
  const activeVatPeriod = getActiveVatPeriod(vatPeriods || []);
  // Finalized non-void sales invoices that are not yet posted to accounting —
  // the same blocker VatDeclarationFlow reports before a declaration can proceed.
  const { data: unpostedInvoiceCount } = useQuery({
    queryKey: ['acc-unposted-sales-invoices-count'],
    queryFn: async () => {
      const [{ data: invoices }, { data: links }] = await Promise.all([
        supabase.from('invoices').select('id, status, voided_at').not('finalized_at', 'is', null),
        supabase.from('acc_sales_invoice_links').select('invoice_id'),
      ]);
      const linkedIds = new Set((links || []).map(l => l.invoice_id));
      return (invoices || []).filter(i => i.status !== 'void' && i.status !== 'draft' && !i.voided_at && !linkedIds.has(i.id)).length;
    },
  });

  const draftPurchases = purchases?.filter(p => p.status === 'draft') || [];
  const blockedPurchases = purchases?.filter(p => p.status === 'blocked') || [];
  const reviewPurchases = purchases?.filter(p => p.status === 'in_review') || [];

  const actionItems: Array<{ title: string; detail: string; href: string }> = [];
  if (draftPurchases.length > 0) {
    actionItems.push({
      title: t(`${draftPurchases.length} utkast att granska`, `${draftPurchases.length} drafts to review`),
      detail: t('Inköp', 'Purchases'),
      href: '/accounting/purchases',
    });
  }
  if (blockedPurchases.length > 0) {
    actionItems.push({
      title: t(`${blockedPurchases.length} blockerade inköp`, `${blockedPurchases.length} blocked purchases`),
      detail: t('Kräver åtgärd', 'Action required'),
      href: '/accounting/purchases',
    });
  }
  if (reviewPurchases.length > 0) {
    actionItems.push({
      title: t(`${reviewPurchases.length} inköp under granskning`, `${reviewPurchases.length} purchases under review`),
      detail: t('Inköp', 'Purchases'),
      href: '/accounting/purchases',
    });
  }
  if ((unpostedInvoiceCount ?? 0) > 0) {
    actionItems.push({
      title: t(
        `${unpostedInvoiceCount} försäljningsfaktur${unpostedInvoiceCount === 1 ? 'a' : 'or'} ej bokförd${unpostedInvoiceCount === 1 ? '' : 'a'}`,
        `${unpostedInvoiceCount} sales invoice${unpostedInvoiceCount === 1 ? '' : 's'} not posted`,
      ),
      detail: t('Försäljning', 'Sales'),
      href: '/accounting/sales',
    });
  }

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            {t('Ekonomiöversikt', 'Financial overview')}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-5 h-5 text-primary cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {t(
                  'Din bokföringsöversikt. Här ser du aktuell period, kommande momsfrist och fakturor som väntar på att bokföras. "Bokföra" innebär att en transaktion officiellt registreras i räkenskaperna.',
                  'Your accounting dashboard. See the current period, upcoming VAT deadline, and invoices waiting to be posted. "Posting" means a transaction is officially recorded in your books.'
                )}
              </TooltipContent>
            </Tooltip>
          </h1>
          <p className="text-muted-foreground mt-1">{t('Översikt över ekonomi och bokföring', 'Overview of finances and accounting')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">{t('Aktuell period', 'Current period')}</p>
                <p className="text-xl font-bold mt-1">
                  {currentPeriod ? `${monthNames[currentPeriod.month]} ${currentPeriod.year}` : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {currentPeriod ? (currentPeriod.status === 'open' ? t('Öppen för bokföring', 'Open for posting') : currentPeriod.status) : ''}
                </p>
              </div>
              <Calendar className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">{t('Nästa momsdeklaration', 'Next VAT declaration')}</p>
                <p className="text-xl font-bold mt-1">
                  {activeVatPeriod?.deadline ? new Date(activeVatPeriod.deadline).toLocaleDateString(language === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {activeVatPeriod ? `${QUARTER_LABELS[activeVatPeriod.quarter]} ${activeVatPeriod.year}` : t('Inga öppna momsperioder', 'No open VAT periods')}
                </p>
              </div>
              <Receipt className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">{t('Inköp att granska', 'Purchases to review')}</p>
                <p className="text-xl font-bold mt-1">{draftPurchases.length + reviewPurchases.length + blockedPurchases.length}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('ej bokförda', 'not posted')}</p>
              </div>
              <ShoppingCart className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">{t('Bokförda inköp', 'Posted purchases')}</p>
                <p className="text-xl font-bold mt-1">
                  {purchases ? formatSEK(purchases.filter(p => p.status === 'posted').reduce((s, p) => s + Number(p.gross_amount), 0)) : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {purchases?.filter(p => p.status === 'posted').length || 0} {t('poster', 'entries')}
                </p>
              </div>
              <Receipt className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>
        </div>

        {actionItems.length > 0 && (
          <Card className="border border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-500" />
                <CardTitle className="text-lg">{t('Kräver åtgärd', 'Action required')}</CardTitle>
                <span className="text-sm text-muted-foreground ml-auto">{actionItems.length} {t('poster', 'items')}</span>
              </div>
            </CardHeader>
            <CardContent className="pt-0 divide-y divide-border">
              {actionItems.map((item, i) => (
                <Link key={i} to={item.href} className="flex items-center justify-between py-3 hover:bg-muted/30 -mx-6 px-6 transition-colors">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{item.detail}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                </Link>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link to="/accounting/purchases/upload">
            <Card className="border border-border hover:shadow-soft transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <ShoppingCart className="w-8 h-8 text-primary mb-3" />
                <h3 className="font-semibold">{t('Ladda upp inköp', 'Upload purchase')}</h3>
                <p className="text-sm text-muted-foreground mt-1">{t('Registrera nya leverantörsfakturor', 'Register new supplier invoices')}</p>
              </CardContent>
            </Card>
          </Link>

          <Link to="/accounting/vat-periods">
            <Card className="border border-border hover:shadow-soft transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <Receipt className="w-8 h-8 text-primary mb-3" />
                <h3 className="font-semibold">{t('Momsdeklaration', 'VAT declaration')}</h3>
                <p className="text-sm text-muted-foreground mt-1">{t('Granska och lämna in moms', 'Review and submit VAT')}</p>
              </CardContent>
            </Card>
          </Link>

          <Link to="/accounting/journal">
            <Card className="border border-border hover:shadow-soft transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <BookOpen className="w-8 h-8 text-primary mb-3" />
                <h3 className="font-semibold">Journal</h3>
                <p className="text-sm text-muted-foreground mt-1">{t('Visa bokförda transaktioner', 'View posted transactions')}</p>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default AccountingOverview;
