import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  PURCHASE_STATUS_LABELS,
  PURCHASE_STATUS_LABELS_EN,
  PURCHASE_STATUS_COLORS,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENT_LABELS_EN,
  formatSEK,
  formatSEKDecimal,
} from '@/lib/accounting-utils';
import { formatCurrencyAmount, isForeignCurrency, normalizeCurrency } from '@/lib/accounting-fx';
import {
  calculateDeclarationBoxAmount,
  isDeclarationBoxFilter,
  purchaseMatchesDeclarationBox,
  summarizeDeclarationBoxLines,
  type DeclarationBoxFilter,
} from '@/lib/vat-declaration';
import { Plus, Filter, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type SortKey = 'supplier' | 'invoiceNumber' | 'vatTreatment' | 'documentDate' | 'amount' | 'status';
type SortDirection = 'asc' | 'desc';

const PurchasesList: React.FC = () => {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const statusLabels = language === 'sv' ? PURCHASE_STATUS_LABELS : PURCHASE_STATUS_LABELS_EN;
  const vatLabels = language === 'sv' ? VAT_TREATMENT_LABELS : VAT_TREATMENT_LABELS_EN;
  const [sortKey, setSortKey] = useState<SortKey>('documentDate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = searchParams.get('status') || 'all';
  const supplierFilter = searchParams.get('supplier') || 'all';
  const declarationBoxParam = searchParams.get('declarationBox');
  const declarationBoxFilter: DeclarationBoxFilter | 'all' = isDeclarationBoxFilter(declarationBoxParam)
    ? declarationBoxParam
    : 'all';
  const dateFrom = searchParams.get('dateFrom') || '';
  const dateTo = searchParams.get('dateTo') || '';
  const declarationBoxLabels: Record<DeclarationBoxFilter, string> = {
    '20': t('Ruta 20', 'Box 20'),
    '21': t('Ruta 21', 'Box 21'),
    '22': t('Ruta 22', 'Box 22'),
    '30': t('Ruta 30', 'Box 30'),
    '48': t('Ruta 48', 'Box 48'),
  };
  const declarationBoxTooltips: Record<DeclarationBoxFilter, string> = {
    '20': t(
      'Rutbeloppet för ruta 20 är summan av nettobeloppen för matchande inköp av varor från andra EU-länder. Tabellen visar exakta ören, medan deklarationsrutan avrundas till hela kronor.',
      'The box amount for box 20 is the sum of net amounts for matching purchases of goods from other EU countries. This table shows exact cents, while the declaration box is rounded to whole kronor.',
    ),
    '21': t(
      'Rutbeloppet för ruta 21 är summan av nettobeloppen för matchande inköp av tjänster från andra EU-länder. Tabellen visar exakta ören, medan deklarationsrutan avrundas till hela kronor.',
      'The box amount for box 21 is the sum of net amounts for matching purchases of services from other EU countries. This table shows exact cents, while the declaration box is rounded to whole kronor.',
    ),
    '22': t(
      'Rutbeloppet för ruta 22 är summan av nettobeloppen för matchande inköp av tjänster från länder utanför EU. Tabellen visar exakta ören, medan deklarationsrutan avrundas till hela kronor.',
      'The box amount for box 22 is the sum of net amounts for matching purchases of services from outside the EU. This table shows exact cents, while the declaration box is rounded to whole kronor.',
    ),
    '30': t(
      'Rutbeloppet för ruta 30 är 25 % av nettobeloppet för varje matchande rad med omvänd skattskyldighet, summerat över urvalet. Tabellen visar exakta ören, medan deklarationsrutan avrundas till hela kronor.',
      'The box amount for box 30 is 25% of the net amount for each matching reverse-charge line, summed across the filtered result. This table shows exact cents, while the declaration box is rounded to whole kronor.',
    ),
    '48': t(
      'Rutbeloppet för ruta 48 är summan av ingående moms på avdragsgilla svenska inköp plus 25 % av nettobeloppet för matchande rader med omvänd skattskyldighet. Tabellen visar exakta ören, medan deklarationsrutan avrundas till hela kronor.',
      'The box amount for box 48 is the sum of input VAT on deductible domestic purchases plus 25% of the net amount for matching reverse-charge lines. This table shows exact cents, while the declaration box is rounded to whole kronor.',
    ),
  };

  const { data: suppliers } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_suppliers').select('id, name').order('name');
      return data || [];
    },
  });

  const selectedSupplierName = supplierFilter !== 'all'
    ? suppliers?.find((supplier) => supplier.id === supplierFilter)?.name || null
    : null;

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['acc-purchases', statusFilter, supplierFilter, declarationBoxFilter, dateFrom, dateTo],
    queryFn: async () => {
      let query = supabase
        .from('acc_purchases')
        .select('*, supplier:acc_suppliers(name), lines:acc_purchase_lines(vat_treatment, gross_amount, net_amount, vat_amount)')
        .order('document_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (statusFilter !== 'all') query = query.eq('status', statusFilter);
      if (supplierFilter !== 'all') query = query.eq('supplier_id', supplierFilter);
      if (dateFrom) query = query.gte('document_date', dateFrom);
      if (dateTo) query = query.lte('document_date', dateTo);
      const { data } = await query;
      const items = data || [];
      if (declarationBoxFilter === 'all') return items;
      return items.filter((purchase) =>
        purchaseMatchesDeclarationBox(
          { lines: ((purchase.lines as Array<{ vat_treatment: string; gross_amount: number; net_amount: number; vat_amount: number }> | null) || []) },
          declarationBoxFilter,
        ),
      );
    },
  });

  const collator = useMemo(() => new Intl.Collator(language === 'sv' ? 'sv-SE' : 'en-US', {
    numeric: true,
    sensitivity: 'base',
  }), [language]);

  const sortedPurchases = useMemo(() => {
    const items = [...(purchases || [])];
    items.sort((leftPurchase, rightPurchase) => {
      const leftVatTreatment = (leftPurchase.lines as Array<{ vat_treatment: string }> | null)?.[0]?.vat_treatment || '';
      const rightVatTreatment = (rightPurchase.lines as Array<{ vat_treatment: string }> | null)?.[0]?.vat_treatment || '';

      let comparison = 0;
      switch (sortKey) {
        case 'supplier':
          comparison = collator.compare((leftPurchase.supplier as { name?: string } | null)?.name || '', (rightPurchase.supplier as { name?: string } | null)?.name || '');
          break;
        case 'invoiceNumber':
          comparison = collator.compare(leftPurchase.supplier_invoice_number || '', rightPurchase.supplier_invoice_number || '');
          break;
        case 'vatTreatment':
          comparison = collator.compare(
            vatLabels[leftVatTreatment as keyof typeof vatLabels] || '',
            vatLabels[rightVatTreatment as keyof typeof vatLabels] || '',
          );
          break;
        case 'amount':
          comparison = Number(leftPurchase.converted_gross_amount_sek ?? leftPurchase.gross_amount) - Number(rightPurchase.converted_gross_amount_sek ?? rightPurchase.gross_amount);
          break;
        case 'status':
          comparison = collator.compare(
            statusLabels[leftPurchase.status as keyof typeof statusLabels] || '',
            statusLabels[rightPurchase.status as keyof typeof statusLabels] || '',
          );
          break;
        case 'documentDate':
        default:
          comparison = collator.compare(leftPurchase.document_date || '', rightPurchase.document_date || '');
          break;
      }

      if (comparison === 0) {
        comparison = collator.compare(rightPurchase.created_at || '', leftPurchase.created_at || '');
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return items;
  }, [collator, purchases, sortDirection, sortKey, statusLabels, vatLabels]);

  const summary = useMemo(() => {
    if (declarationBoxFilter === 'all') {
      return (purchases || []).reduce((totals, purchase) => ({
        count: totals.count + 1,
        gross: totals.gross + Number(purchase.converted_gross_amount_sek ?? purchase.gross_amount ?? 0),
        net: totals.net + Number(purchase.converted_net_amount_sek ?? purchase.net_amount ?? 0),
        vat: totals.vat + Number(purchase.converted_vat_amount_sek ?? purchase.vat_amount ?? 0),
        declarationAmount: null as number | null,
      }), {
        count: 0,
        gross: 0,
        net: 0,
        vat: 0,
        declarationAmount: null as number | null,
      });
    }

    return (purchases || []).reduce((totals, purchase) => {
      const lines = ((purchase.lines as Array<{
        vat_treatment: string;
        gross_amount?: number | null;
        net_amount?: number | null;
        vat_amount?: number | null;
      }> | null) || []);
      const lineTotals = summarizeDeclarationBoxLines(lines, declarationBoxFilter);

      return {
        count: totals.count + 1,
        gross: totals.gross + lineTotals.gross,
        net: totals.net + lineTotals.net,
        vat: totals.vat + lineTotals.vat,
        declarationAmount: (totals.declarationAmount ?? 0) + calculateDeclarationBoxAmount(lines, declarationBoxFilter),
      };
    }, {
      count: 0,
      gross: 0,
      net: 0,
      vat: 0,
      declarationAmount: 0 as number | null,
    });
  }, [declarationBoxFilter, purchases]);

  const summaryTitle = declarationBoxFilter === 'all'
    ? t('Sammanfattning för urvalet', 'Selection summary')
    : t(`Sammanfattning för ${declarationBoxLabels[declarationBoxFilter]}`, `Summary for ${declarationBoxLabels[declarationBoxFilter]}`);

  const updateParam = (key: string, value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value === 'all' || value === '') nextParams.delete(key);
    else nextParams.set(key, value);
    setSearchParams(nextParams);
  };

  const updateSupplierFilter = (value: string) => updateParam('supplier', value);
  const updateStatusFilter = (value: string) => updateParam('status', value);
  const updateDeclarationBoxFilter = (value: string) => updateParam('declarationBox', value);

  const toggleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((currentDirection) => currentDirection === 'asc' ? 'desc' : 'asc');
      return;
    }

    setSortKey(nextKey);
    setSortDirection(nextKey === 'documentDate' ? 'desc' : 'asc');
  };

  const renderSortableHeader = (label: string, key: SortKey, align: 'left' | 'right' = 'left') => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className={`inline-flex items-center gap-1 text-xs uppercase text-muted-foreground hover:text-foreground ${align === 'right' ? 'ml-auto' : ''}`}
    >
      <span>{label}</span>
      {sortKey === key ? (
        sortDirection === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />
      ) : (
        <span className="w-3.5" />
      )}
    </button>
  );

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              {t('Inköp', 'Purchases')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-5 h-5 text-primary cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  {t(
                    'Inköp är fakturor du fått från leverantörer. Varje faktura granskas och "bokförs" — det vill säga registreras officiellt i journalen. Statusarna: Utkast (ej granskat) → Granskning → Bokförd (klar). Blockerad innebär att något måste åtgärdas först.',
                    'Purchases are invoices you have received from suppliers. Each invoice is reviewed and "posted" — officially recorded in the journal. Statuses: Draft (not reviewed) → In review → Posted (done). Blocked means something needs fixing first.'
                  )}
                </TooltipContent>
              </Tooltip>
            </h1>
            <p className="text-muted-foreground mt-1">{t('Leverantörsfakturor och kvitton', 'Supplier invoices and receipts')}</p>
          </div>
          <Link to="/accounting/purchases/upload">
            <Button><Plus className="w-4 h-4 mr-2" />{t('Ladda upp faktura', 'Upload invoice')}</Button>
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t('Filtrera:', 'Filter:')}</span>
          <Select value={statusFilter} onValueChange={updateStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla', 'All')}</SelectItem>
              <SelectItem value="draft">{t('Utkast', 'Draft')}</SelectItem>
              <SelectItem value="in_review">{t('Granskning', 'Review')}</SelectItem>
              <SelectItem value="blocked">{t('Blockerad', 'Blocked')}</SelectItem>
              <SelectItem value="posted">{t('Bokförd', 'Posted')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={supplierFilter} onValueChange={updateSupplierFilter}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder={t('Alla leverantörer', 'All suppliers')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla leverantörer', 'All suppliers')}</SelectItem>
              {suppliers?.map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id}>{supplier.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={declarationBoxFilter} onValueChange={updateDeclarationBoxFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={t('Alla rutor', 'All boxes')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla rutor', 'All boxes')}</SelectItem>
              {(['20', '21', '22', '30', '48'] as DeclarationBoxFilter[]).map((box) => (
                <SelectItem key={box} value={box}>{declarationBoxLabels[box]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedSupplierName && (
            <button
              type="button"
              onClick={() => updateSupplierFilter('all')}
              className="text-sm text-primary hover:underline"
            >
              {t('Rensa leverantör', 'Clear supplier')}: {selectedSupplierName}
            </button>
          )}
          {declarationBoxFilter !== 'all' && (
            <button
              type="button"
              onClick={() => updateDeclarationBoxFilter('all')}
              className="text-sm text-primary hover:underline"
            >
              {t('Rensa ruta', 'Clear box')}: {declarationBoxLabels[declarationBoxFilter]}
            </button>
          )}
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                const nextParams = new URLSearchParams(searchParams);
                nextParams.delete('dateFrom');
                nextParams.delete('dateTo');
                setSearchParams(nextParams);
              }}
              className="text-sm text-primary hover:underline"
            >
              {t('Rensa period', 'Clear period')}: {dateFrom || '…'}{dateTo ? ` – ${dateTo}` : ''}
            </button>
          )}
        </div>

        <Card className="border border-border">
          <div className="border-b border-border bg-muted/10 px-6 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-foreground">{summaryTitle}</p>
                  {declarationBoxFilter !== 'all' && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 cursor-help text-primary" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-sm text-xs">
                        {declarationBoxTooltips[declarationBoxFilter]}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {dateFrom || dateTo
                    ? `${dateFrom || '…'}${dateTo ? ` – ${dateTo}` : ''}`
                    : t('Alla datum i nuvarande filter', 'All dates in the current filter')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
                <span>{t('Transaktioner', 'Transactions')}: <span className="font-medium text-foreground">{summary.count}</span></span>
                <span>{t('Brutto', 'Gross')}: <span className="font-medium text-foreground">{formatSEKDecimal(summary.gross)}</span></span>
                <span>{t('Netto', 'Net')}: <span className="font-medium text-foreground">{formatSEKDecimal(summary.net)}</span></span>
                <span>{t('Moms', 'VAT')}: <span className="font-medium text-foreground">{formatSEKDecimal(summary.vat)}</span></span>
                {summary.declarationAmount !== null && (
                  <span>{t('Rutbelopp', 'Box amount')}: <span className="font-medium text-foreground">{formatSEKDecimal(summary.declarationAmount)}</span></span>
                )}
              </div>
            </div>
          </div>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{renderSortableHeader(t('Leverantör', 'Supplier'), 'supplier')}</TableHead>
                  <TableHead>{renderSortableHeader(t('Fakturanummer', 'Invoice number'), 'invoiceNumber')}</TableHead>
                  <TableHead>{renderSortableHeader(t('Momsbehandling', 'VAT treatment'), 'vatTreatment')}</TableHead>
                  <TableHead>{renderSortableHeader(t('Datum', 'Date'), 'documentDate')}</TableHead>
                  <TableHead className="text-right">{renderSortableHeader(t('Belopp', 'Amount'), 'amount', 'right')}</TableHead>
                  <TableHead>{renderSortableHeader('Status', 'status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : sortedPurchases.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                      <p>{t('Inga inköp registrerade', 'No purchases registered')}</p>
                      <Link to="/accounting/purchases/upload" className="text-primary text-sm hover:underline mt-2 inline-block">
                        {t('Ladda upp ditt första inköp →', 'Upload your first purchase →')}
                      </Link>
                    </TableCell>
                  </TableRow>
                ) : sortedPurchases.map((purchase) => {
                  const primaryVatTreatment = (purchase.lines as Array<{ vat_treatment: string }> | null)?.[0]?.vat_treatment || '';
                  const vatTreatmentLabel = vatLabels[primaryVatTreatment as keyof typeof vatLabels] || '—';

                  return (
                  <TableRow
                    key={purchase.id}
                    className="cursor-pointer hover:bg-muted/30 focus-within:bg-muted/30"
                    role="link"
                    tabIndex={0}
                    onClick={() => navigate(`/accounting/purchases/${purchase.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/accounting/purchases/${purchase.id}`);
                      }
                    }}
                  >
                    <TableCell><span className="text-sm font-medium">{(purchase.supplier as { name?: string } | null)?.name || '—'}</span></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{purchase.supplier_invoice_number || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{vatTreatmentLabel}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{purchase.document_date}</TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      <div>{formatSEK(Number(purchase.converted_gross_amount_sek ?? purchase.gross_amount))}</div>
                      {isForeignCurrency(purchase.original_currency || purchase.currency) && (
                        <div className="text-xs font-normal text-muted-foreground">
                          {formatCurrencyAmount(Number(purchase.original_gross_amount ?? purchase.gross_amount), normalizeCurrency(purchase.original_currency || purchase.currency))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${PURCHASE_STATUS_COLORS[purchase.status as keyof typeof PURCHASE_STATUS_COLORS]} border-0 text-xs`}>
                        {statusLabels[purchase.status as keyof typeof statusLabels]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                )})}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default PurchasesList;
