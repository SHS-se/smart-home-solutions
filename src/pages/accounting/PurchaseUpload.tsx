import React, { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import DocumentPreview from '@/components/accounting/DocumentPreview';
import type { ExchangeRateLookupResult } from '@/lib/accounting-fx';
import { extractDocumentContent } from '@/lib/document-extraction';
import { parseInvoiceText } from '@/lib/invoice-parser';
import { fetchEcbExchangeRates } from '@/lib/ecb-rates';
import { describePurchaseDraftError, toPurchaseDraftError, type PurchaseDraftErrorStage } from '@/lib/purchase-draft-error';
import {
  buildPurchaseImportRateLookupMap,
  buildPurchaseImportRateKey,
  collectUniquePurchaseImportRateRequests,
} from '@/lib/purchase-import-exchange-rates';
import { buildPurchaseDraftDefaults, createPurchaseDraft } from '@/lib/purchase-drafts';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, FileText, Loader2, Upload } from 'lucide-react';

interface UploadResult {
  fileName: string;
  purchaseId?: string;
  supplierName?: string | null;
  invoiceNumber?: string | null;
  parserFingerprintLabel?: string;
  parserReviewRequired?: boolean;
  parserReviewReasons?: string[];
  error?: string;
  errorStage?: PurchaseDraftErrorStage;
  errorDetails?: string[];
  errorCode?: string | null;
}

interface PreparedUploadDraft {
  file: File;
  extractedText: string;
  parsedInvoice: ReturnType<typeof parseInvoiceText>;
  values: ReturnType<typeof buildPurchaseDraftDefaults>;
  documentDate: string;
  exchangeRateKey: string | null;
}

const PurchaseUpload: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState({ message: '', pct: 0 });
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadProcessed, setUploadProcessed] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const getErrorStageLabel = useCallback((stage: PurchaseDraftErrorStage) => {
    switch (stage) {
      case 'supplier_create':
        return t('Leverantör skapades inte', 'Supplier creation failed');
      case 'duplicate_check':
        return t('Dublettkontroll misslyckades', 'Duplicate check failed');
      case 'exchange_rate_lookup':
        return t('ECB-kurs kunde inte hämtas', 'ECB lookup failed');
      case 'document_upload':
        return t('Dokumentet kunde inte laddas upp', 'Document upload failed');
      case 'purchase_insert':
        return t('Utkastposten kunde inte sparas', 'Draft record insert failed');
      case 'line_insert':
        return t('Konteringsraden kunde inte sparas', 'Draft line insert failed');
      default:
        return t('Oväntat fel', 'Unexpected failure');
    }
  }, [t]);

  const { data: suppliers = [] } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_suppliers').select('*').order('name');
      return data || [];
    },
  });

  const processFiles = useCallback(async (selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;

    setUploadResults([]);
    setUploadTotal(selectedFiles.length);
    setUploadProcessed(0);
    setIsUploading(true);
    setProgress({
      message: t('Skapar utkast...', 'Creating drafts...'),
      pct: 0,
    });

    let currentSuppliers = [...suppliers];
    const nextResults: UploadResult[] = [];
    const preparedDrafts: PreparedUploadDraft[] = [];

    for (const [index, file] of selectedFiles.entries()) {
      setProgress({
        message: t(
          `Analyserar ${file.name} (${index + 1}/${selectedFiles.length})...`,
          `Analyzing ${file.name} (${index + 1}/${selectedFiles.length})...`,
        ),
        pct: Math.round((index / selectedFiles.length) * 100),
      });

      try {
        const extraction = await extractDocumentContent(file, (message, pct) => {
          const normalizedPct = Math.min(
            99,
            Math.round((((index + pct / 100) / selectedFiles.length) * 100)),
          );
          setProgress({
            message: `${message} (${index + 1}/${selectedFiles.length})`,
            pct: normalizedPct,
          });
        });
        const parsedInvoice = parseInvoiceText(extraction.rawText);
        const values = buildPurchaseDraftDefaults({
          parsedInvoice,
          extractedText: extraction.rawText,
          suppliers: currentSuppliers,
        });
        const documentDate = values.documentDate || new Date().toISOString().split('T')[0];
        const rateRequests = collectUniquePurchaseImportRateRequests([
          { currency: values.currency, documentDate },
        ]);

        preparedDrafts.push({
          file,
          extractedText: extraction.rawText,
          parsedInvoice,
          values,
          documentDate,
          exchangeRateKey: rateRequests[0]
            ? buildPurchaseImportRateKey(rateRequests[0].currency, rateRequests[0].documentDate)
            : null,
        });
      } catch (error) {
        const described = describePurchaseDraftError(error, t('Kunde inte skapa utkast', 'Could not create draft'));
        nextResults.push({
          fileName: file.name,
          error: described.message,
          errorStage: described.stage,
          errorDetails: described.details,
          errorCode: described.code,
        });
      }

      setUploadResults([...nextResults]);
    }

    setUploadProcessed(nextResults.length);

    const rateRequests = collectUniquePurchaseImportRateRequests(
      preparedDrafts.map((draft) => ({
        currency: draft.values.currency,
        documentDate: draft.documentDate,
      })),
    );
    const duplicateInvoiceMessage = t(
      'Den här leverantörsfakturan finns redan registrerad och kan inte sparas igen.',
      'This supplier invoice is already registered and cannot be saved again.',
    );
    const fullAmountLabel = t('Hela beloppet', 'Full amount');

    let rateLookupMap = new Map<string, ExchangeRateLookupResult>();
    let rateLookupError: unknown = null;

    if (rateRequests.length > 0) {
      setProgress({
        message: t('Hämtar ECB-kurser...', 'Fetching ECB rates...'),
        pct: 72,
      });

      try {
        const rateResults = await fetchEcbExchangeRates(rateRequests);
        rateLookupMap = buildPurchaseImportRateLookupMap(rateRequests, rateResults);
      } catch (error) {
        rateLookupError = toPurchaseDraftError(error, {
          stage: 'exchange_rate_lookup',
          fallbackMessage: t('Kunde inte hämta ECB-kurser', 'Could not fetch ECB rates'),
          extraDetails: [
            `Requests: ${rateRequests.length}`,
          ],
        });
      }
    }

    for (const [index, draft] of preparedDrafts.entries()) {
      setProgress({
        message: t(
          `Sparar ${draft.file.name} (${index + 1}/${preparedDrafts.length})...`,
          `Saving ${draft.file.name} (${index + 1}/${preparedDrafts.length})...`,
        ),
        pct: 75 + Math.round(((index) / Math.max(preparedDrafts.length, 1)) * 24),
      });

      try {
        if (draft.exchangeRateKey && rateLookupError) {
          throw rateLookupError;
        }

        const createdDraft = await createPurchaseDraft({
          supabase,
          suppliers: currentSuppliers,
          userId: user?.id,
          file: draft.file,
          parsedInvoice: draft.parsedInvoice,
          extractedText: draft.extractedText,
          values: draft.values,
          duplicateInvoiceMessage,
          fullAmountLabel,
          exchangeRateLookup: draft.exchangeRateKey
            ? rateLookupMap.get(draft.exchangeRateKey)
            : undefined,
        });
        currentSuppliers = createdDraft.suppliers;

        nextResults.push({
          fileName: draft.file.name,
          purchaseId: createdDraft.purchaseId,
          supplierName: draft.parsedInvoice.fingerprint.recognized ? draft.parsedInvoice.supplierName : null,
          invoiceNumber: draft.parsedInvoice.invoiceNumber,
          parserFingerprintLabel: createdDraft.parserFingerprintLabel,
          parserReviewRequired: createdDraft.parserReviewRequired,
          parserReviewReasons: createdDraft.parserReviewReasons,
        });
      } catch (error) {
        const described = describePurchaseDraftError(error, t('Kunde inte skapa utkast', 'Could not create draft'));
        nextResults.push({
          fileName: draft.file.name,
          error: described.message,
          errorStage: described.stage,
          errorDetails: described.details,
          errorCode: described.code,
        });
      }

      setUploadResults([...nextResults]);
      setUploadProcessed(nextResults.length);
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] }),
      queryClient.invalidateQueries({ queryKey: ['acc-suppliers'] }),
    ]);

    setProgress({
      message: t('Uppladdning klar', 'Upload complete'),
      pct: 100,
    });
    setIsUploading(false);
  }, [queryClient, suppliers, t, user?.id]);

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    await processFiles([selectedFile]);
  }, [processFiles]);

  const handleFilesSelect = useCallback(async (selectedFiles: File[]) => {
    await processFiles(selectedFiles);
  }, [processFiles]);

  const handleClear = useCallback(() => {
    setUploadResults([]);
    setUploadTotal(0);
    setUploadProcessed(0);
    setIsUploading(false);
    setProgress({ message: '', pct: 0 });
  }, []);

  const successfulResults = uploadResults.filter((result) => result.purchaseId);
  const failedResults = uploadResults.filter((result) => result.error);
  const parserReviewResults = uploadResults.filter((result) => result.parserReviewRequired);
  const firstCreatedDraftId = successfulResults[0]?.purchaseId;
  const showingResults = isUploading || uploadResults.length > 0;

  return (
    <AccountingLayout>
      <div className="space-y-6 h-full">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/accounting/purchases')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Ladda upp inköp', 'Upload purchase')}</h1>
            <p className="text-muted-foreground text-sm">
              {t(
                'Ladda upp en eller flera leverantörsfakturor eller kvitton så skapas utkast automatiskt.',
                'Upload one or many supplier invoices or receipts and drafts will be created automatically.',
              )}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5" style={{ minHeight: 'calc(100vh - 240px)' }}>
          <div className="lg:col-span-3 min-h-[400px]">
            {showingResults ? (
              <Card className="h-full border border-border">
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">{t('Uppladdningsresultat', 'Upload results')}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t(
                          `${uploadProcessed} av ${uploadTotal} dokument behandlade`,
                          `${uploadProcessed} of ${uploadTotal} documents processed`,
                        )}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={handleClear}>
                      {t('Rensa', 'Clear')}
                    </Button>
                  </div>
                  <Progress value={uploadTotal > 0 ? (uploadProcessed / uploadTotal) * 100 : 0} className="h-2" />
                  <p className="text-sm text-muted-foreground">{progress.message}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {uploadResults.map((result) => (
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
                            <div className="mt-2 space-y-1">
                              <p className="text-sm text-destructive">{result.error}</p>
                              {result.errorStage && (
                                <p className="text-xs text-muted-foreground">
                                  {t('Steg', 'Stage')}: {getErrorStageLabel(result.errorStage)}
                                </p>
                              )}
                              {result.errorCode && (
                                <p className="text-xs text-muted-foreground">
                                  {t('Kod', 'Code')}: {result.errorCode}
                                </p>
                              )}
                              {result.errorDetails?.map((detail) => (
                                <p key={`${result.fileName}-${detail}`} className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                                  {detail}
                                </p>
                              ))}
                            </div>
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

                  {uploadResults.length === 0 && (
                    <div className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        <span>{t('Förbereder uppladdning...', 'Preparing upload...')}</span>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <DocumentPreview
                onFileSelect={handleFileSelect}
                onFilesSelect={handleFilesSelect}
                allowMultiple
              />
            )}
          </div>

          <div className="lg:col-span-2">
            <Card className="border border-border h-full">
              <CardHeader className="space-y-2">
                <CardTitle className="text-base">{t('Så fungerar uppladdningen', 'How upload works')}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Du kan ladda upp en fil eller många samtidigt. Varje dokument tolkas och sparas direkt som ett utkast.',
                    'You can upload one file or many at once. Each document is parsed and saved immediately as a draft.',
                  )}
                </p>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                  <div className="flex gap-3">
                    <Upload className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                    <p>
                      {t(
                        'Släpp flera PDF-, JPG-, PNG- eller HEIC-filer i samma uppladdning för att skapa en hel bunt utkast.',
                        'Drop multiple PDF, JPG, PNG, or HEIC files in one upload to create a whole batch of drafts.',
                      )}
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600 shrink-0" />
                    <p>
                      {t(
                        'När uppladdningen är klar kan du öppna första utkastet och bläddra vidare med föregående/nästa på granskningssidan.',
                        'When the upload finishes, open the first draft and step through the rest with previous/next on the review page.',
                      )}
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                    <p>
                      {t(
                        'Om parsern inte känner igen layouten markeras dokumentet för parsergranskning så att du ser vilka mallar som behöver stöd.',
                        'If the parser does not recognize the layout, the document is flagged for parser review so you can see which templates need support.',
                      )}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-4 space-y-2">
                  <p className="font-medium text-foreground">{t('Stödda filer', 'Supported files')}</p>
                  <p className="text-muted-foreground">PDF, JPG, PNG, HEIC</p>
                </div>

                {showingResults && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground">{t('Skapade', 'Created')}</p>
                      <p className="text-2xl font-semibold">{successfulResults.length}</p>
                    </div>
                    <div className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground">{t('Misslyckades', 'Failed')}</p>
                      <p className="text-2xl font-semibold">{failedResults.length}</p>
                    </div>
                  </div>
                )}

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
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseUpload;
