import React, { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Files,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { extractDocumentContent } from '@/lib/document-extraction';
import {
  parseEnergyBillingDocument,
  type EnergyParserIssueCode,
  type ParsedEnergyDocument,
} from '@/lib/energy-billing-parser';
import {
  EnergyBillingImportError,
  storeEnergyBillingDocument,
} from '@/lib/energy-billing-storage';
import {
  deleteEnergyParseFailure,
  MAX_ENERGY_DATA_FILE_BYTES,
  removeEnergyParseFailureByHash,
  retainEnergyParseFailure,
  sha256File,
  type EnergyParseFailureRecord,
} from '@/lib/energy-import-file-storage';
import {
  EnergyUsageCsvParseError,
  parseEnergyUsageCsv,
  type ParsedEnergyUsageCsv,
} from '@/lib/energy-usage-parser';
import {
  EnergyUsageImportError,
  importEnergyUsageCsv,
} from '@/lib/energy-temperature-storage';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

type UploadStatus = 'processing' | 'imported' | 'rejected' | 'duplicate' | 'error';

interface UploadResult {
  id: string;
  fileName: string;
  status: UploadStatus;
  documentParsed?: ParsedEnergyDocument;
  usageParsed?: ParsedEnergyUsageCsv;
  error?: string;
  warning?: string;
  retainedFailure?: EnergyParseFailureRecord;
  retainedSourceDeleted?: boolean;
}

interface EnergyDataUploadCardProps {
  customerId: string;
  onDataChanged: () => void | Promise<void>;
}

function issueLabel(
  issue: EnergyParserIssueCode,
  t: (sv: string, en: string) => string,
): string {
  const labels: Record<EnergyParserIssueCode, string> = {
    unknown_format: t(
      'Dokumentformatet känns inte igen. Ingen data sparades.',
      'The document format is not recognized. No data was saved.',
    ),
    wrong_document_kind: t(
      'Dokumenttypen stämmer inte med importen.',
      'The document kind does not match the import.',
    ),
    missing_invoice_number: t('Fakturanummer saknas.', 'Invoice number is missing.'),
    missing_invoice_date: t('Fakturadatum saknas.', 'Invoice date is missing.'),
    missing_service_period: t('Fakturaperioden kunde inte läsas.', 'The billing period could not be read.'),
    missing_consumption: t('Förbrukningen kunde inte läsas.', 'Consumption could not be read.'),
    missing_total: t('Fakturans totalbelopp kunde inte läsas.', 'The invoice total could not be read.'),
    missing_required_charges: t(
      'En eller flera obligatoriska avgifter kunde inte läsas.',
      'One or more required charges could not be read.',
    ),
    invalid_service_period: t('Fakturaperioden är ogiltig.', 'The billing period is invalid.'),
    partial_service_period: t(
      'Dokumentet täcker bara en del av månaden.',
      'The document covers only part of the month.',
    ),
  };
  return labels[issue];
}

function statusIcon(status: UploadStatus) {
  switch (status) {
    case 'processing':
      return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
    case 'imported':
      return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
    case 'duplicate':
      return <AlertTriangle className="h-5 w-5 text-amber-600" />;
    case 'rejected':
    case 'error':
      return <XCircle className="h-5 w-5 text-destructive" />;
  }
}

const EnergyDataUploadCard: React.FC<EnergyDataUploadCardProps> = ({
  customerId,
  onDataChanged,
}) => {
  const { t, language } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [deletingFailureId, setDeletingFailureId] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [progress, setProgress] = useState({ value: 0, message: '' });

  const updateResult = useCallback((id: string, update: Partial<UploadResult>) => {
    setResults((current) => current.map((result) => (
      result.id === id ? { ...result, ...update } : result
    )));
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);
    const initialResults = files.map((file) => ({
      id: crypto.randomUUID(),
      fileName: file.name,
      status: 'processing' as const,
    }));
    setResults(initialResults);
    let dataChanged = false;

    for (const [index, file] of files.entries()) {
      const resultId = initialResults[index].id;
      const baseProgress = (index / files.length) * 100;
      let fileSha256: string | null = null;
      let retainOnFailure = false;
      let rejectedByParser = false;
      let fileCategory: 'document' | 'csv' = 'document';
      setProgress({
        value: baseProgress,
        message: t(
          `Identifierar ${file.name} (${index + 1}/${files.length})`,
          `Identifying ${file.name} (${index + 1}/${files.length})`,
        ),
      });

      try {
        if (file.size === 0 || file.size > MAX_ENERGY_DATA_FILE_BYTES) {
          throw new Error(file.size === 0
            ? t('Filen är tom.', 'The file is empty.')
            : t('Filen är större än 15 MB.', 'The file is larger than 15 MB.'));
        }

        fileSha256 = await sha256File(file);
        const isCsv = file.name.toLocaleLowerCase().endsWith('.csv')
          || file.type === 'text/csv';
        fileCategory = isCsv ? 'csv' : 'document';
        retainOnFailure = true;
        if (isCsv) {
          const usageParsed = parseEnergyUsageCsv(await file.text(), file.name);
          updateResult(resultId, { usageParsed });
          retainOnFailure = false;
          await importEnergyUsageCsv({
            customerId,
            file,
            parsed: usageParsed,
            fileSha256,
          });
        } else {
          const extraction = await extractDocumentContent(file, (message, fileProgress) => {
            setProgress({
              value: Math.min(99, baseProgress + (fileProgress / files.length)),
              message,
            });
          });
          const documentParsed = parseEnergyBillingDocument(extraction.rawText);
          updateResult(resultId, { documentParsed });
          if (!documentParsed.importable) {
            rejectedByParser = true;
            throw new Error(
              `Billing parser rejected the file: ${
                documentParsed.errors.join(', ') || 'unknown_format'
              }`,
            );
          }
          retainOnFailure = false;
          await storeEnergyBillingDocument({
            customerId,
            file,
            parsed: documentParsed,
            documentSha256: fileSha256,
          });
        }

        dataChanged = true;
        let cleanupWarning: string | undefined;
        try {
          await removeEnergyParseFailureByHash(customerId, fileSha256);
        } catch (cleanupError) {
          const message = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
          cleanupWarning = t(
            `Data importerades, men den tidigare problemfilen kunde inte tas bort: ${message}`,
            `Data was imported, but the earlier problem file could not be removed: ${message}`,
          );
        }
        updateResult(resultId, { status: 'imported', warning: cleanupWarning });
      } catch (error) {
        if (
          (error instanceof EnergyBillingImportError || error instanceof EnergyUsageImportError)
          && error.code === 'duplicate'
        ) {
          let cleanupWarning: string | undefined;
          if (fileSha256) {
            try {
              if (await removeEnergyParseFailureByHash(customerId, fileSha256)) {
                dataChanged = true;
              }
            } catch (cleanupError) {
              cleanupWarning = cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            }
          }
          updateResult(resultId, {
            status: 'duplicate',
            error: t('Filen har redan importerats.', 'The file has already been imported.'),
            warning: cleanupWarning,
          });
        } else {
          const message = error instanceof EnergyUsageCsvParseError
            ? error.message
            : error instanceof Error
              ? error.message
              : t('Filen kunde inte behandlas.', 'The file could not be processed.');
          let retainedFailure: EnergyParseFailureRecord | undefined;
          let retentionError: string | undefined;
          if (retainOnFailure && fileSha256) {
            try {
              retainedFailure = await retainEnergyParseFailure({
                customerId,
                file,
                fileCategory,
                parserError: message,
                fileSha256,
              });
              dataChanged = true;
            } catch (retentionFailure) {
              retentionError = retentionFailure instanceof Error
                ? retentionFailure.message
                : String(retentionFailure);
            }
          }
          const retentionMessage = retentionError
            ? t(
                `Problemfilen kunde inte sparas för granskning: ${retentionError}`,
                `The problem file could not be retained for review: ${retentionError}`,
              )
            : undefined;
          updateResult(resultId, {
            status: rejectedByParser ? 'rejected' : 'error',
            error: rejectedByParser
              ? retentionMessage
              : [message, retentionMessage].filter(Boolean).join(' '),
            retainedFailure,
          });
        }
      } finally {
        setProgress({
          value: ((index + 1) / files.length) * 100,
          message: t('Bearbetar batchen...', 'Processing batch...'),
        });
      }
    }

    setProgress({ value: 100, message: t('Batchen är klar.', 'Batch complete.') });
    setIsProcessing(false);
    processingRef.current = false;
    if (dataChanged) await onDataChanged();
  }, [customerId, onDataChanged, t, updateResult]);

  const deleteRetainedSource = useCallback(async (result: UploadResult) => {
    if (!result.retainedFailure) return;
    const confirmed = window.confirm(t(
      `Ta bort den sparade problemfilen "${result.fileName}"?`,
      `Delete the retained problem file "${result.fileName}"?`,
    ));
    if (!confirmed) return;

    setDeletingFailureId(result.retainedFailure.id);
    try {
      await deleteEnergyParseFailure(customerId, result.retainedFailure);
      updateResult(result.id, {
        retainedFailure: undefined,
        retainedSourceDeleted: true,
      });
      await onDataChanged();
    } catch (error) {
      updateResult(result.id, {
        warning: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeletingFailureId(null);
    }
  }, [customerId, onDataChanged, t, updateResult]);

  const chooseFiles = useCallback((selected: FileList | null) => {
    if (!selected) return;
    void processFiles(Array.from(selected));
  }, [processFiles]);

  const formatDate = (date: string) => new Intl.DateTimeFormat(
    language === 'sv' ? 'sv-SE' : 'en-GB',
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  ).format(new Date(`${date}T00:00:00Z`));

  const formatDocumentPeriod = (parsed: ParsedEnergyDocument) => (
    parsed.periodStart && parsed.periodEnd
      ? `${formatDate(parsed.periodStart)} – ${formatDate(parsed.periodEnd)}`
      : null
  );
  const detectedKindLabel = (result: UploadResult) => {
    if (result.documentParsed?.documentKind === 'grid') {
      return t('Elnätsfaktura', 'Grid invoice');
    }
    if (result.documentParsed?.documentKind === 'electricity') {
      return t('Elhandelsfaktura', 'Electricity invoice');
    }
    if (result.usageParsed?.readingKind === 'grid_import') {
      return t('Nätuttag', 'Grid import');
    }
    if (result.usageParsed?.readingKind === 'total_consumption') {
      return t('Husets totalförbrukning', 'Whole-home consumption');
    }
    return null;
  };
  const usageSourceLabel = (parsed: ParsedEnergyUsageCsv) => (
    parsed.sourceFormat === 'home_assistant_sigenergy_total_load'
      ? t(
          'Sigenergy-data för husets totalförbrukning från Home Assistant',
          'Sigenergy whole-home consumption from Home Assistant',
        )
      : t(
          'Daglig el importerad från nätet',
          'Daily electricity imported from the grid',
        )
  );

  return (
    <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="energy-data-upload">
      <CardHeader className="border-b border-border/60 bg-gradient-to-r from-blue-500/5 via-background to-teal-500/5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
            <Files className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">
              {t('Ladda upp energidata', 'Upload energy data')}
            </CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {t(
                'Lägg alla filer i samma ruta. Systemet skiljer automatiskt på elnätsfakturor, elhandelsfakturor, dagligt nätuttag och Sigenergy-data för husets verkliga totalförbrukning.',
                'Put every file in the same box. The system automatically distinguishes grid invoices, electricity invoices, daily grid import, and Sigenergy whole-home consumption data.',
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                t('Elnätsfaktura', 'Grid invoice'),
                t('Elhandelsfaktura', 'Electricity invoice'),
                t('Nätuttag', 'Grid import'),
                t('Totalförbrukning', 'Whole-home consumption'),
              ].map((label) => (
                <Badge key={label} variant="secondary" className="font-normal">
                  <Sparkles className="mr-1 h-3 w-3" />
                  {label}
                </Badge>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t(
                'När importen lyckas sparas bara den strukturerade energidatan – originalfilen lagras inte. Endast filer som inte kan tolkas sparas privat för felsökning tills de importeras på nytt eller tas bort.',
                'After a successful import, only structured energy data is saved—the original file is not stored. A file is retained privately only when it cannot be parsed, until it is re-imported or deleted.',
              )}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.csv,text/csv"
          multiple
          onChange={(event) => {
            chooseFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className={cn(
            'flex min-h-52 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border hover:border-primary/40 hover:bg-muted/30',
            isProcessing && 'cursor-not-allowed opacity-60',
          )}
          disabled={isProcessing}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            void processFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Upload className="mb-3 h-10 w-10 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t('Dra in flera filer eller välj filer', 'Drop several files or choose files')}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            PDF, JPG, PNG, WebP, HEIC, CSV · {t('max 15 MB per fil', 'max 15 MB per file')}
          </span>
        </button>

        {isProcessing && (
          <div className="space-y-2">
            <Progress value={progress.value} className="h-2" />
            <p className="text-xs text-muted-foreground">{progress.message}</p>
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t('Resultat', 'Results')}</h3>
              {!isProcessing && (
                <Button size="sm" variant="ghost" onClick={() => setResults([])}>
                  {t('Rensa', 'Clear')}
                </Button>
              )}
            </div>
            {results.map((result) => {
              const kindLabel = detectedKindLabel(result);
              return (
                <div key={result.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">{statusIcon(result.status)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{result.fileName}</p>
                        {kindLabel && <Badge variant="outline">{kindLabel}</Badge>}
                        {result.status === 'imported' && (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">
                            {t('Importerad', 'Imported')}
                          </Badge>
                        )}
                        {result.status === 'duplicate' && (
                          <Badge variant="secondary">{t('Dublett', 'Duplicate')}</Badge>
                        )}
                        {result.retainedFailure && (
                          <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                            {t('Problemfil sparad', 'Problem file retained')}
                          </Badge>
                        )}
                        {result.retainedSourceDeleted && (
                          <Badge variant="secondary">
                            {t('Problemfil borttagen', 'Problem file deleted')}
                          </Badge>
                        )}
                      </div>

                      {result.documentParsed?.formatRecognized && (
                        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          <p>
                            {result.documentParsed.providerName}
                            {' · '}
                            {result.documentParsed.recognitionLabel}
                          </p>
                          {formatDocumentPeriod(result.documentParsed) && (
                            <p>{formatDocumentPeriod(result.documentParsed)}</p>
                          )}
                        </div>
                      )}
                      {result.usageParsed && (
                        <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                          <p>{usageSourceLabel(result.usageParsed)}</p>
                          <p>
                            {result.usageParsed.readings.length} {t('kompletta dagar', 'complete days')}
                            {' · '}
                            {formatDate(result.usageParsed.dateRange.start)}
                            {' – '}
                            {formatDate(result.usageParsed.dateRange.end)}
                          </p>
                          {result.usageParsed.ignoredSourceRows > 0 && (
                            <p>
                              {result.usageParsed.ignoredSourceRows}{' '}
                              {t('otillgängliga mätvärden ignorerades', 'unavailable meter states were ignored')}
                            </p>
                          )}
                        </div>
                      )}
                      {result.documentParsed?.errors.map((issue) => (
                        <p key={issue} className="mt-1 text-xs text-destructive">
                          {issueLabel(issue, t)}
                        </p>
                      ))}
                      {result.documentParsed?.warnings.map((issue) => (
                        <p key={issue} className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                          {issueLabel(issue, t)}
                        </p>
                      ))}
                      {result.error && (
                        <p className={cn(
                          'mt-1 text-xs',
                          result.status === 'duplicate'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-destructive',
                        )}>
                          {result.error}
                        </p>
                      )}
                      {result.warning && (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                          {result.warning}
                        </p>
                      )}
                      {result.retainedFailure && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-2 h-8 px-2 text-destructive hover:text-destructive"
                          disabled={deletingFailureId === result.retainedFailure.id}
                          onClick={() => void deleteRetainedSource(result)}
                        >
                          {deletingFailureId === result.retainedFailure.id
                            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                          {t('Ta bort problemfil', 'Delete problem file')}
                        </Button>
                      )}
                      {!result.documentParsed
                        && !result.usageParsed
                        && result.status === 'processing'
                        && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('Identifierar filformat...', 'Identifying file format...')}
                          </p>
                        )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!isProcessing && results.some((result) => result.retainedFailure) && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t(
                'Problemfiler visas även under fliken Data. Där kan de tas bort, eller granskas av personal så att parsern kan rättas.',
                'Problem files also appear on the Data tab. They can be deleted there or reviewed by staff so the parser can be fixed.',
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyDataUploadCard;
