import React, { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Network,
  PlugZap,
  Upload,
  XCircle,
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { extractDocumentContent } from '@/lib/document-extraction';
import {
  parseEnergyBillingDocument,
  type EnergyDocumentKind,
  type EnergyParserIssueCode,
  type ParsedEnergyDocument,
} from '@/lib/energy-billing-parser';
import {
  EnergyBillingImportError,
  MAX_ENERGY_BILL_FILE_BYTES,
  sha256File,
  storeEnergyBillingDocument,
} from '@/lib/energy-billing-storage';
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
  parsed?: ParsedEnergyDocument;
  error?: string;
}

interface EnergyDocumentUploadCardProps {
  customerId: string;
  kind: EnergyDocumentKind;
  onImported: () => void | Promise<void>;
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
      'Dokumentet hör hemma i det andra uppladdningsområdet.',
      'This document belongs in the other upload area.',
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

const statusIcon = (status: UploadStatus) => {
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
};

const EnergyDocumentUploadCard: React.FC<EnergyDocumentUploadCardProps> = ({
  customerId,
  kind,
  onImported,
}) => {
  const { t, language } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [progress, setProgress] = useState({ value: 0, message: '' });
  const isGrid = kind === 'grid';
  const Icon = isGrid ? Network : PlugZap;

  const updateResult = useCallback((id: string, update: Partial<UploadResult>) => {
    setResults((current) => current.map((result) => (
      result.id === id ? { ...result, ...update } : result
    )));
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || isProcessing) return;
    const initialResults = files.map((file) => ({
      id: crypto.randomUUID(),
      fileName: file.name,
      status: 'processing' as const,
    }));
    setResults(initialResults);
    setIsProcessing(true);
    let importedAny = false;

    for (const [index, file] of files.entries()) {
      const resultId = initialResults[index].id;
      const baseProgress = (index / files.length) * 100;
      setProgress({
        value: baseProgress,
        message: t(
          `Analyserar ${file.name} (${index + 1}/${files.length})`,
          `Analyzing ${file.name} (${index + 1}/${files.length})`,
        ),
      });

      if (file.size === 0 || file.size > MAX_ENERGY_BILL_FILE_BYTES) {
        updateResult(resultId, {
          status: 'error',
          error: file.size === 0
            ? t('Filen är tom.', 'The file is empty.')
            : t('Filen är större än 15 MB.', 'The file is larger than 15 MB.'),
        });
        continue;
      }

      try {
        const extraction = await extractDocumentContent(file, (message, fileProgress) => {
          setProgress({
            value: Math.min(
              99,
              baseProgress + (fileProgress / files.length),
            ),
            message,
          });
        });
        const parsed = parseEnergyBillingDocument(extraction.rawText, kind);
        updateResult(resultId, { parsed });

        if (!parsed.importable) {
          updateResult(resultId, { status: 'rejected' });
          continue;
        }

        const documentSha256 = await sha256File(file);
        await storeEnergyBillingDocument({
          customerId,
          file,
          parsed,
          documentSha256,
        });
        importedAny = true;
        updateResult(resultId, { status: 'imported' });
      } catch (error) {
        if (error instanceof EnergyBillingImportError && error.code === 'duplicate') {
          updateResult(resultId, {
            status: 'duplicate',
            error: t('Dokumentet har redan importerats.', 'The document has already been imported.'),
          });
        } else {
          const message = error instanceof Error
            ? error.message
            : t('Dokumentet kunde inte behandlas.', 'The document could not be processed.');
          updateResult(resultId, { status: 'error', error: message });
        }
      }
    }

    setProgress({
      value: 100,
      message: t('Batchen är klar.', 'Batch complete.'),
    });
    setIsProcessing(false);
    if (importedAny) await onImported();
  }, [customerId, isProcessing, kind, onImported, t, updateResult]);

  const chooseFiles = useCallback((selected: FileList | null) => {
    if (!selected) return;
    void processFiles(Array.from(selected));
  }, [processFiles]);

  const formatPeriod = (parsed: ParsedEnergyDocument) => {
    if (!parsed.periodStart || !parsed.periodEnd) return null;
    const formatter = new Intl.DateTimeFormat(language === 'sv' ? 'sv-SE' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return `${formatter.format(new Date(`${parsed.periodStart}T00:00:00Z`))} - ${formatter.format(new Date(`${parsed.periodEnd}T00:00:00Z`))}`;
  };

  return (
    <Card className="h-full">
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">
              {isGrid
                ? t('Elnätsfakturor', 'Grid operator invoices')
                : t('Elhandelsfakturor', 'Electricity provider invoices')}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {isGrid
                ? t('Till exempel Ellevio.', 'For example Ellevio.')
                : t(
                    'Till exempel Karlstads Energi, Varbergsortens eller Tibber.',
                    'For example Karlstads Energi, Varbergsortens, or Tibber.',
                  )}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
          multiple
          onChange={(event) => {
            chooseFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className={cn(
            'flex min-h-44 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-colors',
            isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-muted/30',
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
          <Upload className="mb-3 h-9 w-9 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t('Dra in flera fakturor eller välj filer', 'Drop several invoices or choose files')}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            PDF, JPG, PNG, WebP, HEIC - {t('max 15 MB per fil', 'max 15 MB per file')}
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setResults([])}
                >
                  {t('Rensa', 'Clear')}
                </Button>
              )}
            </div>
            {results.map((result) => (
              <div
                key={result.id}
                className="rounded-lg border border-border p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">{statusIcon(result.status)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{result.fileName}</p>
                      {result.status === 'imported' && (
                        <Badge className="bg-emerald-600 hover:bg-emerald-600">
                          {t('Importerad', 'Imported')}
                        </Badge>
                      )}
                      {result.status === 'duplicate' && (
                        <Badge variant="secondary">{t('Dublett', 'Duplicate')}</Badge>
                      )}
                    </div>
                    {result.parsed?.formatRecognized && (
                      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        <p>
                          {result.parsed.providerName} - {result.parsed.recognitionLabel}
                        </p>
                        {formatPeriod(result.parsed) && <p>{formatPeriod(result.parsed)}</p>}
                      </div>
                    )}
                    {result.parsed?.errors.map((issue) => (
                      <p key={issue} className="mt-1 text-xs text-destructive">
                        {issueLabel(issue, t)}
                      </p>
                    ))}
                    {result.parsed?.warnings.map((issue) => (
                      <p key={issue} className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        {issueLabel(issue, t)}
                      </p>
                    ))}
                    {result.error && (
                      <p className={cn(
                        'mt-1 text-xs',
                        result.status === 'duplicate' ? 'text-amber-700 dark:text-amber-400' : 'text-destructive',
                      )}>
                        {result.error}
                      </p>
                    )}
                    {!result.parsed && result.status === 'processing' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('Identifierar dokumentformat...', 'Identifying document format...')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!isProcessing && results.some((result) => result.status === 'rejected') && (
          <Alert>
            <FileText className="h-4 w-4" />
            <AlertDescription>
              {t(
                'Okända eller ofullständiga format sparas inte. Det gör att en leverantörs layoutändring blir synlig direkt och inte förorenar statistiken.',
                'Unknown or incomplete formats are not saved. That makes provider layout changes visible immediately and keeps them out of the statistics.',
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyDocumentUploadCard;
