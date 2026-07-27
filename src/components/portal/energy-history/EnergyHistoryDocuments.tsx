import React, { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyChargeCategory } from '@/lib/energy-billing-parser';
import type { EnergyBillingDocumentRecord } from '@/lib/energy-billing-storage';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface EnergyHistoryDocumentsProps {
  documents: EnergyBillingDocumentRecord[];
}

const EnergyHistoryDocuments: React.FC<EnergyHistoryDocumentsProps> = ({ documents }) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);
  const moneyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), [locale]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
  }), [locale]);

  const categoryLabel = (category: string) => {
    const labels: Record<EnergyChargeCategory, string> = {
      spot_energy: t('Elenergi', 'Electricity energy'),
      variable_fee: t('Rörlig avgift', 'Variable fee'),
      markup: t('Påslag', 'Markup'),
      fixed_fee: t('Fast avgift', 'Fixed fee'),
      energy_transfer: t('Överföringsavgift', 'Transfer fee'),
      peak_demand: t('Effektavgift', 'Peak-demand fee'),
      energy_tax: t('Energiskatt', 'Energy tax'),
      export_credit: t('Exportersättning', 'Export credit'),
      export_fee: t('Exportavgift', 'Export fee'),
      discount: t('Rabatt', 'Discount'),
      vat: t('Moms', 'VAT'),
    };
    return labels[category as EnergyChargeCategory] ?? category;
  };

  const formatDate = (date: string) => dateFormatter.format(new Date(`${date}T00:00:00Z`));
  const sortedDocuments = [...documents].sort(
    (a, b) => b.period_start.localeCompare(a.period_start),
  );

  if (documents.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex min-h-64 flex-col items-center justify-center text-center">
          <FileText className="mb-3 h-9 w-9 text-muted-foreground" />
          <p className="font-medium">{t('Inga importerade dokument', 'No imported documents')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Använd fliken Ladda upp för att börja.', 'Use the Upload tab to get started.')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t('Importerade fakturor', 'Imported invoices')} ({documents.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sortedDocuments.map((document) => (
          <details key={document.id} className="group rounded-lg border border-border">
            <summary className="cursor-pointer list-none p-4">
              <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{document.provider_name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {document.original_file_name}
                  </p>
                </div>
                <div className="text-sm">
                  <p>{formatDate(document.period_start)} - {formatDate(document.period_end)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('Faktura', 'Invoice')} {document.invoice_number}
                  </p>
                </div>
                <Badge variant={document.document_kind === 'grid' ? 'sky' : 'secondary'}>
                  {document.document_kind === 'grid'
                    ? t('Elnät', 'Grid')
                    : t('Elhandel', 'Electricity')}
                </Badge>
                <p className="text-right text-sm font-semibold tabular-nums">
                  {moneyFormatter.format(document.total_amount_sek)}
                </p>
              </div>
            </summary>
            <div className="border-t border-border bg-muted/20 p-4">
              <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                <span>{t('Förbrukning', 'Consumption')}: {numberFormatter.format(document.consumption_kwh)} kWh</span>
                {document.exported_kwh !== null && (
                  <span>{t('Export', 'Export')}: {numberFormatter.format(document.exported_kwh)} kWh</span>
                )}
                {document.peak_demand_kw !== null && (
                  <span>{t('Effekttopp', 'Peak demand')}: {numberFormatter.format(document.peak_demand_kw)} kW</span>
                )}
                <span>{t('Parser', 'Parser')}: {document.parser_id} v{document.parser_version}</span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Post', 'Line item')}</TableHead>
                    <TableHead>{t('Kategori', 'Category')}</TableHead>
                    <TableHead>{t('Antal', 'Quantity')}</TableHead>
                    <TableHead className="text-right">{t('Belopp', 'Amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {document.lineItems.map((lineItem) => (
                    <TableRow key={lineItem.id}>
                      <TableCell className="font-medium">{lineItem.label}</TableCell>
                      <TableCell>{categoryLabel(lineItem.category)}</TableCell>
                      <TableCell>
                        {lineItem.quantity === null
                          ? '-'
                          : `${numberFormatter.format(lineItem.quantity)} ${lineItem.unit ?? ''}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {moneyFormatter.format(lineItem.amount_sek)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
};

export default EnergyHistoryDocuments;
