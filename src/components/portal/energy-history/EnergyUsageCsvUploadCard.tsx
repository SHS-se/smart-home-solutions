import React, { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Upload,
  XCircle,
} from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  EnergyUsageCsvParseError,
  parseEnergyUsageCsv,
  type ParsedEnergyUsageCsv,
} from '@/lib/energy-usage-parser';
import {
  EnergyUsageImportError,
  importEnergyUsageCsv,
  MAX_ENERGY_USAGE_CSV_FILE_BYTES,
} from '@/lib/energy-temperature-storage';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

type UploadStatus = 'processing' | 'imported' | 'duplicate' | 'error';

interface UploadResult {
  id: string;
  fileName: string;
  status: UploadStatus;
  parsed?: ParsedEnergyUsageCsv;
  error?: string;
}

interface EnergyUsageCsvUploadCardProps {
  customerId: string;
  onImported: () => void | Promise<void>;
}

const statusIcon = (status: UploadStatus) => {
  switch (status) {
    case 'processing':
      return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
    case 'imported':
      return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
    case 'duplicate':
      return <AlertTriangle className="h-5 w-5 text-amber-600" />;
    case 'error':
      return <XCircle className="h-5 w-5 text-destructive" />;
  }
};

const EnergyUsageCsvUploadCard: React.FC<EnergyUsageCsvUploadCardProps> = ({
  customerId,
  onImported,
}) => {
  const { t, language } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [progress, setProgress] = useState({ value: 0, message: '' });

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
      setProgress({
        value: (index / files.length) * 100,
        message: t(
          `Läser ${file.name} (${index + 1}/${files.length})`,
          `Reading ${file.name} (${index + 1}/${files.length})`,
        ),
      });

      if (!file.name.toLocaleLowerCase().endsWith('.csv')) {
        updateResult(resultId, {
          status: 'error',
          error: t('Välj en CSV-fil.', 'Please choose a CSV file.'),
        });
        continue;
      }
      if (file.size === 0 || file.size > MAX_ENERGY_USAGE_CSV_FILE_BYTES) {
        updateResult(resultId, {
          status: 'error',
          error: file.size === 0
            ? t('Filen är tom.', 'The file is empty.')
            : t('Filen är större än 5 MB.', 'The file is larger than 5 MB.'),
        });
        continue;
      }

      try {
        const parsed = parseEnergyUsageCsv(await file.text(), file.name);
        updateResult(resultId, { parsed });
        await importEnergyUsageCsv({ customerId, file, parsed });
        importedAny = true;
        updateResult(resultId, { status: 'imported' });
      } catch (error) {
        if (error instanceof EnergyUsageImportError && error.code === 'duplicate') {
          updateResult(resultId, {
            status: 'duplicate',
            error: t('Filen har redan importerats.', 'The file has already been imported.'),
          });
        } else {
          const message = error instanceof EnergyUsageCsvParseError
            ? error.message
            : error instanceof Error
              ? error.message
              : t('CSV-filen kunde inte importeras.', 'The CSV file could not be imported.');
          updateResult(resultId, { status: 'error', error: message });
        }
      }
      setProgress({
        value: ((index + 1) / files.length) * 100,
        message: t('Bearbetar batchen...', 'Processing batch...'),
      });
    }

    setProgress({ value: 100, message: t('Batchen är klar.', 'Batch complete.') });
    setIsProcessing(false);
    if (importedAny) await onImported();
  }, [customerId, isProcessing, onImported, t, updateResult]);

  const chooseFiles = useCallback((selected: FileList | null) => {
    if (!selected) return;
    void processFiles(Array.from(selected));
  }, [processFiles]);

  const formatDate = (date: string) => new Intl.DateTimeFormat(
    language === 'sv' ? 'sv-SE' : 'en-GB',
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
  ).format(new Date(`${date}T00:00:00Z`));

  return (
    <Card className="h-full xl:col-span-2">
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">
              {t('Daglig förbrukning från CSV', 'Daily consumption CSV')}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                'Importera flera månadsfiler samtidigt. Formatet date;förbrukning stöds, inklusive decimalcomma.',
                'Import several monthly files at once. The date;consumption format is supported, including decimal commas.',
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
          accept=".csv,text/csv"
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
            {t('Dra in flera CSV-filer eller välj filer', 'Drop several CSV files or choose files')}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            {t('Daglig energi i kWh - max 5 MB per fil', 'Daily energy in kWh - max 5 MB per file')}
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
            {results.map((result) => (
              <div key={result.id} className="rounded-lg border border-border p-3">
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
                    {result.parsed && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {result.parsed.readings.length} {t('dagar', 'days')} · {formatDate(result.parsed.dateRange.start)} - {formatDate(result.parsed.dateRange.end)}
                      </p>
                    )}
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
                        {t('Läser CSV-formatet...', 'Reading CSV format...')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!isProcessing && results.some((result) => result.status === 'error') && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t(
                'Kontrollera att varje fil innehåller en date-kolumn och en förbrukningskolumn i kWh per dag.',
                'Check that each file contains a date column and a daily-consumption column in kWh.',
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyUsageCsvUploadCard;
