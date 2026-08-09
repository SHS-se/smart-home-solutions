import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Database,
  Download,
  FileText,
  Loader2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import type { EnergyChargeCategory } from '@/lib/energy-billing-parser';
import type { EnergyBillingDocumentRecord } from '@/lib/energy-billing-storage';
import {
  createEnergyParseFailureReviewUrl,
  type EnergyParseFailureRecord,
} from '@/lib/energy-import-file-storage';
import type { EnergyUsageImportBatchRecord } from '@/lib/energy-temperature-storage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type DeletionTarget =
  | { kind: 'document'; record: EnergyBillingDocumentRecord }
  | { kind: 'usage'; record: EnergyUsageImportBatchRecord }
  | { kind: 'failure'; record: EnergyParseFailureRecord };

interface EnergyHistoryDocumentsProps {
  customerId: string;
  documents: EnergyBillingDocumentRecord[];
  usageImports: EnergyUsageImportBatchRecord[];
  parseFailures: EnergyParseFailureRecord[];
  isStaffView: boolean;
  onDeleteDocument: (document: EnergyBillingDocumentRecord) => Promise<void>;
  onDeleteUsageImport: (usageImport: EnergyUsageImportBatchRecord) => Promise<void>;
  onDeleteParseFailure: (failure: EnergyParseFailureRecord) => Promise<void>;
}

const EnergyHistoryDocuments: React.FC<EnergyHistoryDocumentsProps> = ({
  customerId,
  documents,
  usageImports,
  parseFailures,
  isStaffView,
  onDeleteDocument,
  onDeleteUsageImport,
  onDeleteParseFailure,
}) => {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const [deletionTarget, setDeletionTarget] = useState<DeletionTarget | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openingFailureId, setOpeningFailureId] = useState<string | null>(null);
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }), [locale]);
  const dateTimeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
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
  const documentGroups = [
    {
      kind: 'grid' as const,
      label: t('Elnätsfakturor', 'Grid invoices'),
      documents: sortedDocuments.filter((document) => document.document_kind === 'grid'),
    },
    {
      kind: 'electricity' as const,
      label: t('Elhandelsfakturor', 'Electricity invoices'),
      documents: sortedDocuments.filter((document) => document.document_kind === 'electricity'),
    },
  ];

  const handleDelete = async () => {
    if (!deletionTarget) return;
    setIsDeleting(true);
    try {
      if (deletionTarget.kind === 'document') {
        await onDeleteDocument(deletionTarget.record);
      } else if (deletionTarget.kind === 'usage') {
        await onDeleteUsageImport(deletionTarget.record);
      } else {
        await onDeleteParseFailure(deletionTarget.record);
      }
      toast({
        title: t('Data borttagen', 'Data deleted'),
        description: deletionTarget.kind === 'failure'
          ? t(
              'Problemfilen och dess granskningspost har tagits bort.',
              'The problem file and its review record were deleted.',
            )
          : t(
              'Den valda importens strukturerade data har tagits bort.',
              'The selected import’s structured data was deleted.',
            ),
      });
      setDeletionTarget(null);
    } catch (error) {
      toast({
        title: t('Kunde inte ta bort data', 'Could not delete data'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const openFailureForReview = async (failure: EnergyParseFailureRecord) => {
    setOpeningFailureId(failure.id);
    try {
      const url = await createEnergyParseFailureReviewUrl(customerId, failure);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast({
        title: t('Filen kunde inte öppnas', 'The file could not be opened'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setOpeningFailureId(null);
    }
  };

  const deletionDescription = deletionTarget?.kind === 'usage'
    ? t(
        'Alla dagliga mätvärden från den här filen tas bort. Om filen överlappade en äldre import blir den äldre datan synlig igen.',
        'All daily readings from this file will be deleted. If it overlapped an earlier import, the earlier data becomes visible again.',
      )
    : deletionTarget?.kind === 'failure'
      ? t(
          'Den privata problemfilen tas bort permanent och kan inte längre användas för att förbättra parsern.',
          'The private problem file will be permanently deleted and can no longer be used to improve the parser.',
        )
      : t(
          'Fakturan och alla normaliserade kostnadsposter tas bort. Ingen originalfil lagras för lyckade importer.',
          'The invoice and all normalized charge rows will be deleted. No original file is stored for successful imports.',
        );

  return (
    <div className="space-y-5" data-testid="energy-data-management">
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>{t('Källfiler minimeras', 'Source files are minimized')}</AlertTitle>
        <AlertDescription>
          {t(
            'Lyckade importer sparar endast strukturerad energidata och filmetadata. Originalfilen behålls endast när parsningen misslyckas, och kan då tas bort här.',
            'Successful imports retain only structured energy data and file metadata. The original file is kept only when parsing fails, and can then be deleted here.',
          )}
        </AlertDescription>
      </Alert>

      {parseFailures.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800" data-testid="energy-parse-failures">
          <CardHeader className="bg-amber-500/5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                {t('Problemfiler för granskning', 'Problem files for review')} ({parseFailures.length})
              </CardTitle>
              {isStaffView && (
                <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                  {t('Personalåtgärd kan krävas', 'Staff action may be required')}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-border p-0">
            {parseFailures.map((failure) => (
              <div key={failure.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{failure.original_file_name}</p>
                    <Badge variant="secondary">
                      {failure.file_category === 'csv' ? 'CSV' : t('Dokument', 'Document')}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateTimeFormatter.format(new Date(failure.created_at))}
                  </p>
                  <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
                    {t(
                      'Filen kunde inte tolkas automatiskt och har sparats privat för granskning.',
                      'The file could not be parsed automatically and was retained privately for review.',
                    )}
                  </p>
                  {isStaffView && (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium">
                        {t('Teknisk detalj', 'Technical detail')}
                      </summary>
                      <p className="mt-1 break-words font-mono">{failure.parser_error}</p>
                    </details>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {isStaffView && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={openingFailureId === failure.id}
                      onClick={() => void openFailureForReview(failure)}
                    >
                      {openingFailureId === failure.id
                        ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        : <Download className="mr-1.5 h-4 w-4" />}
                      {t('Granska', 'Review')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeletionTarget({ kind: 'failure', record: failure })}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    {t('Ta bort', 'Delete')}
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card data-testid="energy-usage-imports">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-5">
            <Database className="h-4 w-4 text-primary" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium">
                {t('Importerade dagliga mätvärden', 'Imported daily readings')}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {usageImports.length === 0
                  ? t('Inga CSV-importer ännu.', 'No CSV imports yet.')
                  : t(
                      `${usageImports.length} filer med nätuttag eller totalförbrukning`,
                      `${usageImports.length} files with grid import or whole-home consumption`,
                    )}
              </p>
            </div>
            <Badge variant="secondary">{usageImports.length}</Badge>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <CardContent className="border-t border-border/60 pt-5">
            {usageImports.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('Inga CSV-importer ännu.', 'No CSV imports yet.')}
              </p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {usageImports.map((usageImport) => (
                  <div
                    key={usageImport.id}
                    className="flex flex-col gap-3 p-4 md:flex-row md:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{usageImport.original_file_name}</p>
                        <Badge variant={usageImport.reading_kind === 'total_consumption' ? 'sky' : 'secondary'}>
                          {usageImport.reading_kind === 'total_consumption'
                            ? t('Husets totalförbrukning', 'Whole-home consumption')
                            : t('Nätuttag', 'Grid import')}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {usageImport.reading_count} {t('dagar', 'days')}
                        {' · '}
                        {dateTimeFormatter.format(new Date(usageImport.created_at))}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="self-start text-destructive hover:text-destructive md:self-auto"
                      onClick={() => setDeletionTarget({ kind: 'usage', record: usageImport })}
                    >
                      <Trash2 className="mr-1.5 h-4 w-4" />
                      {t('Ta bort import', 'Delete import')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </details>
      </Card>

      <Card data-testid="energy-billing-imports">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4" />
                {t('Importerade fakturor', 'Imported invoices')}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  'Fakturorna är uppdelade efter vad de debiterar. Öppna en grupp och sedan en faktura för radnivån.',
                  'Invoices are separated by what they charge. Open a group and then an invoice to see line items.',
                )}
              </p>
            </div>
            <Badge variant="secondary">{documents.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {sortedDocuments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('Inga importerade fakturor ännu.', 'No imported invoices yet.')}
            </p>
          ) : documentGroups.map((group) => (
            <details key={group.kind} className="group rounded-xl border border-border/70">
              <summary className="flex cursor-pointer list-none items-center gap-3 p-4">
                <div className={group.kind === 'grid'
                  ? 'rounded-lg bg-sky-500/10 p-2 text-sky-700 dark:text-sky-300'
                  : 'rounded-lg bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300'}
                >
                  <FileText className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium">{group.label}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {group.documents.length === 0
                      ? t('Inga fakturor i gruppen', 'No invoices in this group')
                      : t(
                          `Senaste perioden ${formatDate(group.documents[0].period_start)} – ${formatDate(group.documents[0].period_end)}`,
                          `Latest period ${formatDate(group.documents[0].period_start)} – ${formatDate(group.documents[0].period_end)}`,
                        )}
                  </p>
                </div>
                <Badge variant={group.kind === 'grid' ? 'sky' : 'secondary'}>
                  {group.documents.length}
                </Badge>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-2 border-t border-border/60 bg-muted/10 p-3">
                {group.documents.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">
                    {t('Inga importerade fakturor ännu.', 'No imported invoices yet.')}
                  </p>
                ) : group.documents.map((document) => (
                  <details key={document.id} className="group/invoice rounded-lg border border-border bg-background">
                    <summary className="cursor-pointer list-none p-4">
                      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{document.provider_name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {document.original_file_name}
                          </p>
                        </div>
                        <div className="text-sm">
                          <p>{formatDate(document.period_start)} – {formatDate(document.period_end)}</p>
                          <p className="text-xs text-muted-foreground">
                            {t('Faktura', 'Invoice')} {document.invoice_number}
                          </p>
                        </div>
                        <p className="text-right text-sm font-semibold tabular-nums">
                          {moneyFormatter.format(document.total_amount_sek)}
                        </p>
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open/invoice:rotate-180" />
                      </div>
                    </summary>
                    <div className="border-t border-border bg-muted/20 p-4">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                          <span>{t('Förbrukning', 'Consumption')}: {numberFormatter.format(document.consumption_kwh)} kWh</span>
                          {document.exported_kwh !== null && (
                            <span>{t('Export', 'Export')}: {numberFormatter.format(document.exported_kwh)} kWh</span>
                          )}
                          {document.peak_demand_kw !== null && (
                            <span>{t('Effekttopp', 'Peak demand')}: {numberFormatter.format(document.peak_demand_kw)} kW</span>
                          )}
                          <span>{t('Parser', 'Parser')}: {document.parser_id} v{document.parser_version}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeletionTarget({ kind: 'document', record: document })}
                        >
                          <Trash2 className="mr-1.5 h-4 w-4" />
                          {t('Ta bort faktura', 'Delete invoice')}
                        </Button>
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
                                  ? '–'
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
              </div>
            </details>
          ))}
        </CardContent>
      </Card>

      <AlertDialog
        open={deletionTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeletionTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {t('Ta bort energidata?', 'Delete energy data?')}
            </AlertDialogTitle>
            <AlertDialogDescription>{deletionDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('Avbryt', 'Cancel')}
            </AlertDialogCancel>
            <Button variant="destructive" disabled={isDeleting} onClick={() => void handleDelete()}>
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('Ta bort permanent', 'Delete permanently')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default EnergyHistoryDocuments;
