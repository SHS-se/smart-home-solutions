import React, { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import DocumentPreview from '@/components/accounting/DocumentPreview';
import PurchaseUploadForm from '@/components/accounting/PurchaseUploadForm';
import { extractDocumentContent, type ExtractionResult } from '@/lib/document-extraction';
import { parseInvoiceText, type ParsedInvoice } from '@/lib/invoice-parser';
import { buildPurchaseDraftDefaults, createPurchaseDraft } from '@/lib/purchase-drafts';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ArrowLeft, ArrowRight, AlertTriangle, CheckCircle2, FileText, Loader2 } from 'lucide-react';

interface BulkUploadResult {
  fileName: string;
  purchaseId?: string;
  supplierName?: string | null;
  invoiceNumber?: string | null;
  parserFingerprintLabel?: string;
  parserReviewRequired?: boolean;
  parserReviewReasons?: string[];
  error?: string;
}

const PurchaseUpload: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState({ message: '', pct: 0 });
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [parsedInvoice, setParsedInvoice] = useState<ParsedInvoice | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkUploadResult[]>([]);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkProcessed, setBulkProcessed] = useState(0);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  const { data: suppliers = [] } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_suppliers').select('*').order('name');
      return data || [];
    },
  });

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setBulkResults([]);
    setBulkTotal(0);
    setBulkProcessed(0);
    setIsBulkProcessing(false);
    setFile(selectedFile);
    setIsExtracting(true);
    setExtractionResult(null);
    setParsedInvoice(null);
    setProgress({ message: t('Analyserar dokument...', 'Analyzing document...'), pct: 10 });

    try {
      const result = await extractDocumentContent(selectedFile, (msg, pct) => setProgress({ message: msg, pct }));
      setExtractionResult(result);
      setProgress({ message: t('Tolkar innehåll...', 'Parsing content...'), pct: 90 });
      const parsed = parseInvoiceText(result.rawText);
      setParsedInvoice(parsed);
      setProgress({ message: t('Klar', 'Done'), pct: 100 });
    } catch (err) {
      console.error('Document extraction error:', err);
      setProgress({ message: t('Kunde inte analysera dokumentet', 'Could not analyze document'), pct: 0 });
    } finally {
      setIsExtracting(false);
    }
  }, [t]);

  const handleFilesSelect = useCallback(async (selectedFiles: File[]) => {
    if (selectedFiles.length <= 1) {
      if (selectedFiles[0]) await handleFileSelect(selectedFiles[0]);
      return;
    }

    setFile(null);
    setIsExtracting(false);
    setExtractionResult(null);
    setParsedInvoice(null);
    setBulkResults([]);
    setBulkTotal(selectedFiles.length);
    setBulkProcessed(0);
    setIsBulkProcessing(true);
    setProgress({ message: t('Skapar utkast...', 'Creating drafts...'), pct: 0 });

    let currentSuppliers = [...suppliers];
    const nextResults: BulkUploadResult[] = [];

    for (const [index, currentFile] of selectedFiles.entries()) {
      const basePct = Math.round((index / selectedFiles.length) * 100);
      setProgress({
        message: t(
          `Analyserar ${currentFile.name} (${index + 1}/${selectedFiles.length})...`,
          `Analyzing ${currentFile.name} (${index + 1}/${selectedFiles.length})...`,
        ),
        pct: basePct,
      });

      try {
        const result = await extractDocumentContent(currentFile, (message, pct) => {
          const normalizedPct = Math.min(99, Math.round((((index + pct / 100) / selectedFiles.length) * 100)));
          setProgress({
            message: `${message} (${index + 1}/${selectedFiles.length})`,
            pct: normalizedPct,
          });
        });
        const parsed = parseInvoiceText(result.rawText);
        const values = buildPurchaseDraftDefaults({
          parsedInvoice: parsed,
          extractedText: result.rawText,
          suppliers: currentSuppliers,
        });
        const createdDraft = await createPurchaseDraft({
          supabase,
          suppliers: currentSuppliers,
          userId: user?.id,
          file: currentFile,
          parsedInvoice: parsed,
          extractedText: result.rawText,
          values,
          duplicateInvoiceMessage: t(
            'Den här leverantörsfakturan finns redan registrerad och kan inte sparas igen.',
            'This supplier invoice is already registered and cannot be saved again.',
          ),
          fullAmountLabel: t('Hela beloppet', 'Full amount'),
        });
        currentSuppliers = createdDraft.suppliers;
        nextResults.push({
          fileName: currentFile.name,
          purchaseId: createdDraft.purchaseId,
          supplierName: parsed.supplierName,
          invoiceNumber: parsed.invoiceNumber,
          parserFingerprintLabel: createdDraft.parserFingerprintLabel,
          parserReviewRequired: createdDraft.parserReviewRequired,
          parserReviewReasons: createdDraft.parserReviewReasons,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : t('Kunde inte skapa utkast', 'Could not create draft');
        nextResults.push({
          fileName: currentFile.name,
          error: message,
        });
      }

      setBulkResults([...nextResults]);
      setBulkProcessed(index + 1);
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] }),
      queryClient.invalidateQueries({ queryKey: ['acc-suppliers'] }),
    ]);

    setProgress({
      message: t('Bulkuppladdning klar', 'Bulk upload complete'),
      pct: 100,
    });
    setIsBulkProcessing(false);
  }, [handleFileSelect, queryClient, suppliers, t, user?.id]);

  const handleFileClear = useCallback(() => {
    setFile(null);
    setIsExtracting(false);
    setProgress({ message: '', pct: 0 });
    setExtractionResult(null);
    setParsedInvoice(null);
    setBulkResults([]);
    setBulkTotal(0);
    setBulkProcessed(0);
    setIsBulkProcessing(false);
  }, []);

  const successfulBulkResults = bulkResults.filter((result) => result.purchaseId);
  const failedBulkResults = bulkResults.filter((result) => result.error);
  const parserReviewResults = bulkResults.filter((result) => result.parserReviewRequired);
  const isBulkMode = isBulkProcessing || bulkResults.length > 0;
  const firstCreatedDraftId = successfulBulkResults[0]?.purchaseId;

  return (
    <AccountingLayout>
      <div className="space-y-4 h-full">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/accounting/purchases')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Ladda upp inköp', 'Upload purchase')}</h1>
            <p className="text-muted-foreground text-sm">{t('Registrera leverantörsfaktura eller kvitto', 'Register supplier invoice or receipt')}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6" style={{ minHeight: 'calc(100vh - 240px)' }}>
          <div className="lg:col-span-3 min-h-[400px]">
            {isBulkMode ? (
              <Card className="h-full border border-border">
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">{t('Bulkuppladdning', 'Bulk upload')}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t(
                          `${bulkProcessed} av ${bulkTotal} dokument behandlade`,
                          `${bulkProcessed} of ${bulkTotal} documents processed`,
                        )}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={handleFileClear}>
                      {t('Rensa', 'Clear')}
                    </Button>
                  </div>
                  <Progress value={bulkTotal > 0 ? (bulkProcessed / bulkTotal) * 100 : 0} className="h-2" />
                  <p className="text-sm text-muted-foreground">{progress.message}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {bulkResults.map((result) => (
                    <div key={`${result.fileName}-${result.purchaseId || result.error || 'pending'}`} className="rounded-lg border border-border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{result.fileName}</p>
                          {result.supplierName && (
                            <p className="text-sm text-muted-foreground truncate">{result.supplierName}</p>
                          )}
                          {result.invoiceNumber && (
                            <p className="text-xs text-muted-foreground">{result.invoiceNumber}</p>
                          )}
                          {result.parserFingerprintLabel && (
                            <p className="text-xs text-muted-foreground mt-2">{result.parserFingerprintLabel}</p>
                          )}
                          {result.parserReviewRequired && (
                            <p className="text-sm text-amber-700 mt-2">
                              {result.parserReviewReasons?.[0] || t('Parsern behöver granskas för den här layouten', 'The parser needs review for this layout')}
                            </p>
                          )}
                          {result.error && (
                            <p className="text-sm text-destructive mt-2">{result.error}</p>
                          )}
                        </div>
                        {result.purchaseId && result.parserReviewRequired ? (
                          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                        ) : result.purchaseId ? (
                          <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                        ) : result.error ? (
                          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
                        ) : (
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground shrink-0" />
                        )}
                      </div>
                      {result.purchaseId && (
                        <Link to={`/accounting/purchases/${result.purchaseId}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-3">
                          {t('Granska utkast', 'Review draft')}
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      )}
                    </div>
                  ))}

                  {bulkResults.length === 0 && (
                    <div className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        <span>{t('Förbereder bulkuppladdning...', 'Preparing bulk upload...')}</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <DocumentPreview
                file={file}
                onFileSelect={handleFileSelect}
                onFilesSelect={handleFilesSelect}
                allowMultiple
                onFileClear={handleFileClear}
                ocrWords={extractionResult?.words || []}
                isExtracting={isExtracting}
                extractionProgress={progress}
              />
            )}
          </div>
          <div className="lg:col-span-2">
            {isBulkMode ? (
              <Card className="border border-border">
                <CardHeader>
                  <CardTitle className="text-base">{t('Skapade utkast', 'Created drafts')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground">{t('Skapade', 'Created')}</p>
                      <p className="text-2xl font-semibold">{successfulBulkResults.length}</p>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground">{t('Misslyckades', 'Failed')}</p>
                      <p className="text-2xl font-semibold">{failedBulkResults.length}</p>
                    </div>
                  </div>

                  {parserReviewResults.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      {t(
                        `${parserReviewResults.length} dokument behöver parsergranskning innan du litar på tolkningen fullt ut.`,
                        `${parserReviewResults.length} documents need parser review before you rely on the extraction fully.`,
                      )}
                    </div>
                  )}

                  {firstCreatedDraftId ? (
                    <Button className="w-full" onClick={() => navigate(`/accounting/purchases/${firstCreatedDraftId}`)}>
                      {t('Granska första utkastet', 'Review first draft')}
                    </Button>
                  ) : null}

                  <p className="text-sm text-muted-foreground">
                    {t(
                      'Bulkuppladdning skapar utkast direkt. Granska varje utkast innan bokföring.',
                      'Bulk upload creates drafts immediately. Review each draft before posting.',
                    )}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4 h-full">
                {parsedInvoice?.parserReviewRequired && (
                  <Card className="border border-amber-200 bg-amber-50">
                    <CardContent className="pt-6 space-y-1">
                      <p className="text-sm font-medium text-amber-900">{parsedInvoice.fingerprint.label}</p>
                      <p className="text-sm text-amber-800">
                        {parsedInvoice.parserReviewReasons[0] || t('Parsern behöver granskas för den här layouten', 'The parser needs review for this layout')}
                      </p>
                    </CardContent>
                  </Card>
                )}
                <PurchaseUploadForm
                  file={file}
                  parsedInvoice={parsedInvoice}
                  extractedText={extractionResult?.rawText || null}
                  fillHeight
                  onSaved={(purchaseId) => navigate(`/accounting/purchases/${purchaseId}`)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseUpload;
