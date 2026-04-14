import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import DocumentPreview from '@/components/accounting/DocumentPreview';
import PurchaseUploadForm from '@/components/accounting/PurchaseUploadForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN, PURCHASE_STATUS_COLORS,
  PAYMENT_SOURCE_LABELS, PAYMENT_SOURCE_LABELS_EN,
  VAT_TREATMENT_LABELS, VAT_TREATMENT_LABELS_EN,
  isReverseChargeTreatment,
  formatExchangeRate, formatSEK, formatSEKDecimal, buildJournalPreview,
  getPurchaseBlockers,
} from '@/lib/accounting-utils';
import type { PaymentSource, VatTreatment } from '@/lib/accounting-utils';
import {
  buildPurchaseVatSummary,
  describeJournalOriginalAmount,
  formatCurrencyAmount,
  getPurchaseExchangeSnapshot,
  isForeignCurrency,
} from '@/lib/accounting-fx';
import { allocateNextVerificationNumber } from '@/lib/verification-number';
import { toast } from 'sonner';
import { ArrowLeft, AlertTriangle, Eye, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';

const PURCHASE_DOCUMENT_BUCKET = 'purchase-documents';

function safeDecodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePurchaseDocumentPath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;

  let normalizedPath = rawPath.trim();
  if (!normalizedPath) return null;

  normalizedPath = safeDecodePath(normalizedPath);

  if (/^https?:\/\//i.test(normalizedPath)) {
    try {
      const url = new URL(normalizedPath);
      normalizedPath = safeDecodePath(url.pathname);
    } catch {
      return normalizedPath;
    }
  }

  normalizedPath = normalizedPath.replace(/^\/+/, '');

  const knownPrefixes = [
    `storage/v1/object/sign/${PURCHASE_DOCUMENT_BUCKET}/`,
    `storage/v1/object/public/${PURCHASE_DOCUMENT_BUCKET}/`,
    `storage/v1/object/authenticated/${PURCHASE_DOCUMENT_BUCKET}/`,
    `${PURCHASE_DOCUMENT_BUCKET}/`,
  ];

  for (const prefix of knownPrefixes) {
    if (normalizedPath.startsWith(prefix)) {
      normalizedPath = normalizedPath.slice(prefix.length);
      break;
    }
  }

  return normalizedPath.replace(/^\/+/, '') || null;
}

const PurchaseDetail: React.FC = () => {
  const { purchaseId } = useParams<{ purchaseId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  const [saveState, setSaveState] = useState({
    isDirty: false,
    isPending: false,
    isBlocked: false,
  });

  const statusLabels = language === 'sv' ? PURCHASE_STATUS_LABELS : PURCHASE_STATUS_LABELS_EN;
  const paymentLabels = language === 'sv' ? PAYMENT_SOURCE_LABELS : PAYMENT_SOURCE_LABELS_EN;
  const vatLabels = language === 'sv' ? VAT_TREATMENT_LABELS : VAT_TREATMENT_LABELS_EN;

  const { data: purchase, isLoading } = useQuery({
    queryKey: ['acc-purchase', purchaseId],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('*, supplier:acc_suppliers(*), verification:acc_verifications(id, verification_number)')
        .eq('id', purchaseId!)
        .single();
      return data;
    },
    enabled: !!purchaseId,
  });

  const { data: lines } = useQuery({
    queryKey: ['acc-purchase-lines', purchaseId],
    queryFn: async () => {
      const { data } = await supabase.from('acc_purchase_lines').select('*').eq('purchase_id', purchaseId!).order('sort_order');
      return data || [];
    },
    enabled: !!purchaseId,
  });
  const { data: purchaseIds = [] } = useQuery({
    queryKey: ['acc-purchase-nav'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('id')
        .order('document_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      return (data || []).map((row) => row.id);
    },
  });
  const supplier = purchase?.supplier as Tables<'acc_suppliers'> | null;
  const verification = (purchase as typeof purchase & {
    verification?: { id: string; verification_number: string | null } | null;
  })?.verification || null;
  const supplierName = supplier?.name || '';
  const supplierType = supplier?.supplier_type as 'domestic' | 'eu' | 'non_eu' | undefined;

  const targetPeriodMonth = purchase?.document_date ? new Date(purchase.document_date).getMonth() + 1 : null;
  const targetPeriodYear = purchase?.document_date ? new Date(purchase.document_date).getFullYear() : null;

  const { data: targetPeriod } = useQuery({
    queryKey: ['acc-period-for-date', targetPeriodYear, targetPeriodMonth],
    queryFn: async () => {
      const { data } = await supabase.from('acc_periods').select('id, status').eq('year', targetPeriodYear!).eq('month', targetPeriodMonth!).single();
      return data;
    },
    enabled: !!targetPeriodYear && !!targetPeriodMonth,
  });

  const purchaseFx = getPurchaseExchangeSnapshot(purchase);
  const isForeignDocument = isForeignCurrency(purchaseFx.originalCurrency);

  const normalizedDocumentPath = normalizePurchaseDocumentPath(purchase?.document_file_path);

  const { data: documentUrl, isLoading: isDocumentLoading, error: documentLoadError } = useQuery({
    queryKey: ['acc-purchase-document', purchaseId, purchase?.document_file_path],
    queryFn: async () => {
      if (!purchase?.document_file_path || !normalizedDocumentPath) return null;
      const { data, error } = await supabase.storage
        .from(PURCHASE_DOCUMENT_BUCKET)
        .createSignedUrl(normalizedDocumentPath, 3600);
      if (error) {
        console.error('Failed to sign purchase document', {
          purchaseId,
          storedPath: purchase.document_file_path,
          normalizedPath: normalizedDocumentPath,
          error,
        });
        throw error;
      }

      if (normalizedDocumentPath !== purchase.document_file_path) {
        const { error: updatePathError } = await supabase
          .from('acc_purchases')
          .update({ document_file_path: normalizedDocumentPath })
          .eq('id', purchase.id);
        if (updatePathError) {
          console.error('Failed to normalize purchase document path', {
            purchaseId,
            storedPath: purchase.document_file_path,
            normalizedPath: normalizedDocumentPath,
            error: updatePathError,
          });
        }
      }

      return data?.signedUrl || null;
    },
    enabled: !!purchase?.document_file_path && !!normalizedDocumentPath,
  });

  const updateLine = useMutation({
    mutationFn: async ({ lineId, updates }: { lineId: string; updates: Record<string, unknown> }) => {
      const { error } = await supabase.from('acc_purchase_lines').update(updates).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['acc-purchase-lines', purchaseId] }),
  });

  const deleteDraft = useMutation({
    mutationFn: async () => {
      if (!purchase) throw new Error('Purchase missing');
      if (purchase.status === 'posted') {
        throw new Error(t('Bokförda inköp kan inte raderas', 'Posted purchases cannot be deleted'));
      }

      if (normalizedDocumentPath) {
        const { error: storageError } = await supabase.storage
          .from(PURCHASE_DOCUMENT_BUCKET)
          .remove([normalizedDocumentPath]);
        if (storageError) {
          console.warn('Failed to remove purchase document during draft deletion', {
            purchaseId: purchase.id,
            normalizedPath: normalizedDocumentPath,
            error: storageError,
          });
        }
      }

      const { error } = await supabase
        .from('acc_purchases')
        .delete()
        .eq('id', purchase.id)
        .eq('status', 'draft');
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] });
      queryClient.invalidateQueries({ queryKey: ['acc-purchase-nav'] });
      toast.success(t('Utkast raderat', 'Draft deleted'));
      navigate('/accounting/purchases');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const postPurchase = useMutation({
    mutationFn: async () => {
      if (!purchase || !lines) throw new Error('Data missing');
      if (isForeignDocument && (
        purchaseFx.exchangeRateSource === 'LEGACY_UNCONVERTED' ||
        !purchaseFx.exchangeRate ||
        !purchaseFx.exchangeRateDate
      )) {
        throw new Error(t(
          'Utkastet saknar giltig ECB-konvertering till SEK. Kör FX-backfill innan bokföring.',
          'This draft is missing a valid ECB conversion to SEK. Run the FX backfill before posting.',
        ));
      }
      const blockers = getPurchaseBlockers({
        ...purchase, supplier_id: purchase.supplier_id,
        lines: lines.map(l => ({ vat_treatment: l.vat_treatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount) })),
        gross_amount: Number(purchase.gross_amount), net_amount: Number(purchase.net_amount), vat_amount: Number(purchase.vat_amount),
      });
      const errors = blockers.filter(b => b.type === 'error');
      if (errors.length > 0) throw new Error(errors[0].message);

      const docDate = new Date(purchase.document_date);
      const { data: period } = await supabase.from('acc_periods').select('id').eq('year', docDate.getFullYear()).eq('month', docDate.getMonth() + 1).single();
      if (!period) throw new Error(t('Ingen bokföringsperiod hittades för dokumentdatum', 'No accounting period found for document date'));

      const verificationDate = purchase.posting_date || purchase.document_date;

      // Guard: prevent duplicate verification for the same purchase
      const { data: existingVerification } = await supabase
        .from('acc_verifications')
        .select('id')
        .eq('source_type', 'purchase')
        .eq('source_id', purchase.id)
        .maybeSingle();
      if (existingVerification) {
        throw new Error(t(
          'Det finns redan en verifikation för detta inköp.',
          'A verification already exists for this purchase.',
        ));
      }

      const verificationNumber = await allocateNextVerificationNumber(supabase, verificationDate);

      const { data: verification, error: vErr } = await supabase.from('acc_verifications').insert({
        verification_number: verificationNumber,
        verification_date: verificationDate,
        description: purchase.description || `${t('Inköp', 'Purchase')} ${supplierName}`.trim(),
        period_id: period.id, source_type: 'purchase', source_id: purchase.id,
        is_posted: true, posted_at: new Date().toISOString(), posted_by: user?.id, created_by: user?.id,
      }).select().single();
      if (vErr) throw vErr;

      const journalPreview = buildJournalPreview(
        lines.map(l => ({ expense_account: l.expense_account, vat_treatment: l.vat_treatment as VatTreatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount), description: l.description })),
        purchase.payment_source as PaymentSource, purchase.description || '',
      );
      const primaryVatTreatment = (lines[0]?.vat_treatment as VatTreatment | undefined) || 'needs_review';
      const journalInserts = journalPreview.map((jl, i) => {
        let originalAmount: number | null = null;
        if (jl.account === '2641') {
          originalAmount = describeJournalOriginalAmount('input_vat', primaryVatTreatment, purchaseFx);
        } else if (jl.account === '2614' || jl.account === '2645') {
          originalAmount = describeJournalOriginalAmount('reverse_charge_vat', primaryVatTreatment, purchaseFx);
        } else if (jl.account === '2018' || jl.account === '1930') {
          originalAmount = describeJournalOriginalAmount('payment', primaryVatTreatment, purchaseFx);
        } else if (jl.debit > 0) {
          originalAmount = describeJournalOriginalAmount('expense', primaryVatTreatment, purchaseFx);
        }

        return {
          verification_id: verification.id,
          account: jl.account,
          account_name: jl.accountName,
          description: jl.description,
          debit: jl.debit,
          credit: jl.credit,
          sort_order: i,
          original_currency: purchaseFx.originalCurrency,
          original_amount: originalAmount,
          exchange_rate_source: purchaseFx.exchangeRateSource,
          exchange_rate_date: purchaseFx.exchangeRateDate,
          exchange_rate: purchaseFx.exchangeRate,
          exchange_rate_overridden: purchaseFx.exchangeRateOverridden,
          converted_amount_sek: jl.debit > 0 ? jl.debit : jl.credit,
        };
      });
      const { error: jErr } = await supabase.from('acc_journal_lines').insert(journalInserts);
      if (jErr) throw jErr;

      const { error: pErr } = await supabase.from('acc_purchases').update({
        status: 'posted', verification_id: verification.id, posting_date: purchase.posting_date || purchase.document_date,
      }).eq('id', purchase.id);
      if (pErr) throw pErr;
      return verification.verification_number || verificationNumber;
    },
    onSuccess: (vNum) => {
      queryClient.invalidateQueries({ queryKey: ['acc-purchase', purchaseId] });
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] });
      toast.success(
        vNum
          ? t(`Bokförd som ${vNum}`, `Posted as ${vNum}`)
          : t('Fakturan bokfördes', 'Invoice posted'),
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !purchase) {
    return <AccountingLayout><div className="py-12 text-center text-muted-foreground">{t('Laddar...', 'Loading...')}</div></AccountingLayout>;
  }

  const blockers = getPurchaseBlockers({
    ...purchase, supplier_id: purchase.supplier_id,
    lines: (lines || []).map(l => ({ vat_treatment: l.vat_treatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount) })),
    gross_amount: Number(purchase.gross_amount), net_amount: Number(purchase.net_amount), vat_amount: Number(purchase.vat_amount),
  });
  const errors = blockers.filter(b => b.type === 'error');
  const warnings = blockers.filter(b => b.type === 'warning');
  const fxPostingBlocked = isForeignDocument && (
    purchaseFx.exchangeRateSource === 'LEGACY_UNCONVERTED' ||
    !purchaseFx.exchangeRate ||
    !purchaseFx.exchangeRateDate
  );
  if (fxPostingBlocked) {
    errors.push({
      type: 'error',
      message: t(
        'Utkastet saknar giltig ECB-konvertering till SEK. Kör FX-backfill innan bokföring.',
        'This draft is missing a valid ECB conversion to SEK. Run the FX backfill before posting.',
      ),
    });
  }

  // Supplier type vs VAT treatment consistency
  if (supplierType && lines && lines.length > 0) {
    for (const line of lines) {
      if (line.vat_treatment === 'needs_review') continue;
      if ((supplierType === 'eu' || supplierType === 'non_eu') && line.vat_treatment === 'domestic_deductible') {
        warnings.push({
          type: 'warning',
          message: t(
            `Leverantören är ${supplierType === 'eu' ? 'EU' : 'utom-EU'} men momsbehandlingen är "Ingående moms 25%". Bör den vara "Omvänd skattskyldighet"?`,
            `Supplier is ${supplierType === 'eu' ? 'EU' : 'non-EU'} but VAT treatment is "Input VAT 25%". Should it be "Reverse charge"?`,
          ),
        });
        break;
      }
      if (supplierType === 'domestic' && isReverseChargeTreatment(line.vat_treatment)) {
        warnings.push({
          type: 'warning',
          message: t(
            'Leverantören är inhemsk men momsbehandlingen är "Omvänd skattskyldighet". Bör den vara "Ingående moms 25%"?',
            'Supplier is domestic but VAT treatment is "Reverse charge". Should it be "Input VAT 25%"?',
          ),
        });
        break;
      }
    }
  }

  // Period status warning
  if (targetPeriod && (targetPeriod.status === 'closed' || targetPeriod.status === 'locked')) {
    errors.push({
      type: 'error',
      message: t(
        `Bokföringsperioden för ${purchase.document_date} är ${targetPeriod.status === 'locked' ? 'låst' : 'stängd'}. Öppna perioden innan bokföring.`,
        `The accounting period for ${purchase.document_date} is ${targetPeriod.status}. Reopen the period before posting.`,
      ),
    });
  }

  const canPost = errors.length === 0 && purchase.status !== 'posted';
  const primaryLine = lines?.[0] || null;
  const isDraftPurchase = purchase.status === 'draft';
  const currentPurchaseIndex = purchaseIds.indexOf(purchase.id);
  const previousPurchaseId = currentPurchaseIndex > 0 ? purchaseIds[currentPurchaseIndex - 1] : null;
  const nextPurchaseId = currentPurchaseIndex >= 0 && currentPurchaseIndex < purchaseIds.length - 1 ? purchaseIds[currentPurchaseIndex + 1] : null;
  const canSave = purchase.status !== 'posted' && saveState.isDirty && !saveState.isPending && !saveState.isBlocked;
  const canDelete = isDraftPurchase && !deleteDraft.isPending;
  const deleteButtonContent = (
    <>
      <Trash2 className="w-4 h-4 mr-2" />
      {deleteDraft.isPending ? t('Raderar...', 'Deleting...') : t('Radera', 'Delete')}
    </>
  );

  const journalPreview = lines && lines.length > 0
    ? buildJournalPreview(
        lines.map(l => ({ expense_account: l.expense_account, vat_treatment: l.vat_treatment as VatTreatment, net_amount: Number(l.net_amount), vat_amount: Number(l.vat_amount), gross_amount: Number(l.gross_amount), description: l.description })),
        purchase.payment_source as PaymentSource, purchase.description || '',
      )
    : [];
  const vatSummary = buildPurchaseVatSummary(
    (lines || []).map((line) => ({
      expense_account: line.expense_account,
      vat_treatment: line.vat_treatment as VatTreatment,
      net_amount: Number(line.net_amount),
      vat_amount: Number(line.vat_amount),
      gross_amount: Number(line.gross_amount),
      description: line.description,
    })),
    purchaseFx,
  );
  const isReverseCharge = primaryLine ? isReverseChargeTreatment(primaryLine.vat_treatment) : false;
  const convertedInvoiceAmountSek = isReverseCharge ? vatSummary.reverseChargeBaseSek : vatSummary.paymentAccountAmountSek;
  const netVatEffectSek = vatSummary.reverseChargeOutputVatSek - vatSummary.reverseChargeInputVatSek;
  const declarationBoxBadges: Array<{ text: string; className: string }> = [];
  if (lines && lines.length > 0 && !lines.some((line) => line.vat_treatment === 'needs_review')) {
    if (lines.some((line) => line.vat_treatment === 'domestic_deductible')) {
      declarationBoxBadges.push({
        text: t('Ruta 48 – Avdragsgill ingående moms', 'Box 48 – Deductible input VAT'),
        className: 'bg-primary/10 text-primary',
      });
    }
    if (lines.some((line) => line.vat_treatment === 'reverse_charge_eu_goods')) {
      declarationBoxBadges.push({
        text: t('Ruta 20 – Inköp av varor från annat EU-land', 'Box 20 – EU goods purchases'),
        className: 'bg-amber-100 text-amber-800',
      });
    }
    if (lines.some((line) => line.vat_treatment === 'reverse_charge_eu_services')) {
      declarationBoxBadges.push({
        text: t('Ruta 21 – Inköp av tjänster från annat EU-land', 'Box 21 – EU services purchases'),
        className: 'bg-amber-100 text-amber-800',
      });
    }
    if (lines.some((line) => line.vat_treatment === 'reverse_charge_non_eu_services')) {
      declarationBoxBadges.push({
        text: t('Ruta 22 – Inköp av tjänster utom EU', 'Box 22 – Non-EU services purchases'),
        className: 'bg-amber-100 text-amber-800',
      });
    }
    if (lines.some((line) => isReverseChargeTreatment(line.vat_treatment))) {
      declarationBoxBadges.push({
        text: t('Ruta 30 – Utgående moms 25 % på inköp', 'Box 30 – Output VAT 25% on purchases'),
        className: 'bg-amber-100 text-amber-800',
      });
      declarationBoxBadges.push({
        text: t('Ruta 48 – Avdragsgill ingående moms (omvänd)', 'Box 48 – Deductible input VAT (reverse charge)'),
        className: 'bg-primary/10 text-primary',
      });
    }
    if (lines.every((line) => line.vat_treatment === 'non_deductible' || line.vat_treatment === 'no_vat')) {
      declarationBoxBadges.push({
        text: t('Ingen deklarationsruta – ej avdragsgill', 'No declaration box – non-deductible'),
        className: 'bg-muted text-muted-foreground',
      });
    }
  }
  const verificationLink = purchase.verification_id ? `/accounting/journal?verification=${purchase.verification_id}` : null;
  const verificationLabel = verification?.verification_number || purchase.verification_id || null;

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <Link to="/accounting/purchases" className="inline-flex w-fit items-center gap-1 text-primary text-sm hover:underline">
          <ArrowLeft className="w-4 h-4" /> {t('Tillbaka till lista', 'Back to list')}
        </Link>

        <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-start">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{t('Granska inköp', 'Review purchase')}</h1>
              <Badge className={`${PURCHASE_STATUS_COLORS[purchase.status as keyof typeof PURCHASE_STATUS_COLORS]} border-0`}>
                {statusLabels[purchase.status as keyof typeof statusLabels]}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm mt-1">
              {supplierName || t('Okänd leverantör', 'Unknown supplier')} · {purchase.document_date}
            </p>
          </div>
          <div className="flex flex-col items-center justify-center gap-2 lg:-mt-1">
            {currentPurchaseIndex >= 0 && (
              <>
                <div className="flex items-center justify-center gap-2">
                  {previousPurchaseId ? (
                    <Button variant="outline" size="sm" className="w-32 justify-center" asChild>
                      <Link to={`/accounting/purchases/${previousPurchaseId}`}>
                        <ChevronLeft className="w-4 h-4 mr-1" />
                        {t('Föregående', 'Previous')}
                      </Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="w-32 justify-center" disabled>
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      {t('Föregående', 'Previous')}
                    </Button>
                  )}
                  {nextPurchaseId ? (
                    <Button variant="outline" size="sm" className="w-32 justify-center" asChild>
                      <Link to={`/accounting/purchases/${nextPurchaseId}`}>
                        {t('Nästa', 'Next')}
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="w-32 justify-center" disabled>
                      {t('Nästa', 'Next')}
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  )}
                </div>
                <span className="text-sm text-center text-muted-foreground">
                  {t(
                    `Inköp ${currentPurchaseIndex + 1} av ${purchaseIds.length}`,
                    `Purchase ${currentPurchaseIndex + 1} of ${purchaseIds.length}`,
                  )}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-start gap-3 lg:-mt-1 lg:justify-end">
            <Button
              variant={saveState.isDirty ? 'default' : 'outline'}
              className={saveState.isDirty
                ? 'min-w-24 border border-warning/60 bg-warning text-warning-foreground hover:bg-warning/90'
                : 'min-w-24'}
              disabled={!canSave}
              onClick={() => {
                const submitEvent = new CustomEvent('purchase-detail-save');
                window.dispatchEvent(submitEvent);
              }}
            >
              {saveState.isPending ? t('Sparar...', 'Saving...') : t('Spara', 'Save')}
            </Button>
            <Button className="min-w-24" disabled={!canPost || postPurchase.isPending} onClick={() => postPurchase.mutate()}>
              {postPurchase.isPending ? t('Bokför...', 'Posting...') : t('Bokför', 'Post')}
            </Button>
            {isDraftPurchase ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" className="min-w-24" disabled={!canDelete}>
                    {deleteButtonContent}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('Radera utkast?', 'Delete draft?')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        'Det här tar bort utkastet och det uppladdade dokumentet. Bokförda inköp påverkas inte.',
                        'This removes the draft and the uploaded document. Posted purchases are not affected.',
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteDraft.mutate()}>
                      {t('Radera', 'Delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button variant="destructive" className="min-w-24" disabled>
                {deleteButtonContent}
              </Button>
            )}
          </div>
        </div>

        {errors.length > 0 && purchase.status !== 'posted' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-800">{t('Blockerad för bokföring', 'Blocked for posting')}</p>
              <ul className="text-sm text-red-700 mt-1 space-y-0.5">{errors.map((b, i) => <li key={i}>• {b.message}</li>)}</ul>
            </div>
          </div>
        )}

        {warnings.length > 0 && purchase.status !== 'posted' && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div>{warnings.map((b, i) => <p key={i} className="text-sm text-amber-800">{b.message}</p>)}</div>
          </div>
        )}

        {isForeignDocument && purchaseFx.exchangeRateSource === 'LEGACY_UNCONVERTED' && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-4">
            <div>
              <p className="font-medium text-primary">{t('Valutaomräkning saknas', 'Foreign-currency conversion is missing')}</p>
              <p className="text-sm text-blue-900/80 mt-1">
                {t('Det här köpet saknar sparad ECB-konvertering. Kör backfill-skriptet innan bokföring eller momsgranskning.', 'This purchase is missing a persisted ECB conversion. Run the FX backfill script before posting or VAT review.')}
              </p>
            </div>
          </div>
        )}

        {(declarationBoxBadges.length > 0 || verificationLink) && (
          <Card className="border border-border">
            <CardContent className="p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('Deklarationsrutor', 'Declaration boxes')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {declarationBoxBadges.map((badge) => (
                      <span
                        key={badge.text}
                        className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${badge.className}`}
                      >
                        {badge.text}
                      </span>
                    ))}
                  </div>
                </div>
                {verificationLink && verificationLabel && (
                  <div className="space-y-2 lg:text-right">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('Verifikation', 'Verification')}
                    </p>
                    <Link to={verificationLink} className="text-sm font-medium text-primary hover:underline">
                      {verificationLabel}
                    </Link>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
          <div className="flex h-full flex-col gap-6 lg:col-span-2">
            <Card className="flex flex-1 flex-col border border-border">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">{t('Underlag', 'Document')}</CardTitle>
                {documentUrl && (
                  <Button variant="ghost" size="sm" onClick={() => window.open(documentUrl, '_blank', 'noopener,noreferrer')}>
                    <Eye className="w-4 h-4 mr-1" /> {t('Fullskärm', 'Full screen')}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                {isDocumentLoading ? (
                  <div className="flex flex-1 items-center justify-center rounded-lg bg-muted p-8 text-center">
                    <p className="text-sm text-muted-foreground">{t('Laddar dokument...', 'Loading document...')}</p>
                  </div>
                ) : documentUrl ? (
                  <div className="min-h-[28rem] flex-1">
                    <DocumentPreview fileUrl={documentUrl} fileName={purchase.document_file_path} />
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center rounded-lg bg-muted p-8 text-center">
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        {purchase.document_file_path
                          ? t('Dokumentet kunde inte öppnas från lagringen', 'The document could not be opened from storage')
                          : t('Inget underlag uppladdat', 'No document uploaded')}
                      </p>
                      {purchase.document_file_path && (
                        <p className="text-xs text-muted-foreground">
                          {t('Kontrollera att filen fortfarande finns i bucketen purchase-documents.', 'Check that the file still exists in the purchase-documents bucket.')}
                        </p>
                      )}
                      {documentLoadError && (
                        <p className="text-xs text-destructive">
                          {t('Signering av dokumentlänk misslyckades.', 'Signing the document URL failed.')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border border-border">
              <CardHeader><CardTitle className="text-base">{t('Radklassificering', 'Line classification')}</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Beskrivning', 'Description')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Momsbehandling', 'VAT treatment')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp (SEK)', 'Amount (SEK)')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(lines || []).map((line) => (
                      <TableRow key={line.id}>
                        <TableCell className="text-sm">{line.description || '—'}</TableCell>
                        <TableCell>
                          {purchase.status === 'posted' ? (
                            <span className="text-sm">{line.expense_account}</span>
                          ) : (
                            <Input className="w-20 h-8 text-sm" value={line.expense_account} onChange={(e) => updateLine.mutate({ lineId: line.id, updates: { expense_account: e.target.value } })} />
                          )}
                        </TableCell>
                        <TableCell>
                          {purchase.status === 'posted' ? (
                            <span className="text-sm">{vatLabels[line.vat_treatment as keyof typeof vatLabels]}</span>
                          ) : (
                            <Select value={line.vat_treatment} onValueChange={(v) => updateLine.mutate({ lineId: line.id, updates: { vat_treatment: v } })}>
                              <SelectTrigger className="h-8 text-sm w-52"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {Object.entries(vatLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">
                          <div>{formatSEKDecimal(Number(line.gross_amount))}</div>
                          {isForeignDocument && lines?.length === 1 && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {formatCurrencyAmount(purchaseFx.originalGross, purchaseFx.originalCurrency)}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="border border-border">
              <CardHeader><CardTitle className="text-base">{t('Bokföring', 'Journal entry')}</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">{t('Namn', 'Name')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Debet', 'Debit')}</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Kredit', 'Credit')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journalPreview.map((jl, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm font-medium">{jl.account}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{jl.accountName}</TableCell>
                        <TableCell className="text-right text-sm">{jl.debit > 0 ? formatSEKDecimal(jl.debit) : '–'}</TableCell>
                        <TableCell className="text-right text-sm">{jl.credit > 0 ? formatSEKDecimal(jl.credit) : '–'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

          </div>

          <div className="flex h-full flex-col gap-6">
            <PurchaseUploadForm
              purchase={purchase}
              purchaseLine={primaryLine}
              disabled={purchase.status === 'posted'}
              title={t('Utkastdetaljer', 'Draft details')}
              submitLabel={t('Spara', 'Save')}
              hideSubmitButton
              onSaveStateChange={setSaveState}
            />

            <Card className="border border-border">
              <CardHeader><CardTitle className="text-base">{t('Momssammanställning', 'VAT summary')}</CardTitle></CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div><p className="text-xs text-muted-foreground">{t('Betalkälla', 'Payment source')}</p><p>{paymentLabels[purchase.payment_source as keyof typeof paymentLabels]}</p></div>
                {purchase.posting_date && <div><p className="text-xs text-muted-foreground">{t('Bokföringsdatum', 'Posting date')}</p><p>{purchase.posting_date}</p></div>}
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Leverantörsfaktura', 'Supplier invoice')}</p>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Valuta', 'Currency')}</span><span>{purchaseFx.originalCurrency}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Belopp', 'Amount')}</span><span>{formatCurrencyAmount(purchaseFx.originalGross, purchaseFx.originalCurrency)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Leverantörsmoms', 'Supplier VAT')}</span><span>{formatCurrencyAmount(purchaseFx.originalVat, purchaseFx.originalCurrency)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Belopp (SEK)', 'Amount (SEK)')}</span><span>{formatSEKDecimal(convertedInvoiceAmountSek)}</span></div>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Valutaomräkning', 'Currency conversion')}</p>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Original', 'Original')}</span><span>{formatCurrencyAmount(purchaseFx.originalGross, purchaseFx.originalCurrency)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('ECB-kurs', 'ECB rate')}</span><span>{purchaseFx.exchangeRateDate ? `${formatExchangeRate(purchaseFx.exchangeRate)} (${purchaseFx.exchangeRateDate})` : formatExchangeRate(purchaseFx.exchangeRate)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Omräknat', 'Converted')}</span><span>{formatCurrencyAmount(convertedInvoiceAmountSek, 'SEK')}</span></div>
                </div>
                {purchaseFx.exchangeRateOverridden && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    {t('Manuell överstyrning', 'Manual override')}: {purchaseFx.exchangeRateOverrideReason || '—'}
                  </div>
                )}
                {isReverseCharge ? (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Svensk moms', 'Swedish VAT')}</p>
                    <p className="font-medium text-foreground">{t('Omvänd skattskyldighet (25%)', 'Reverse charge (25%)')}</p>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Skattepliktigt belopp (SEK)', 'Taxable amount (SEK)')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeBaseSek)}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Utgående moms (SEK)', 'Output VAT (SEK)')}</span><span>{formatSEKDecimal(vatSummary.reverseChargeOutputVatSek)}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Ingående moms (SEK)', 'Input VAT (SEK)')}</span><span>{`-${formatSEKDecimal(vatSummary.reverseChargeInputVatSek)}`}</span></div>
                    <div className="flex justify-between gap-4 font-medium"><span>{t('Nettoeffekt moms', 'Net VAT effect')}</span><span>{`${formatSEKDecimal(netVatEffectSek)} ${t('(neutral)', '(neutral)')}`}</span></div>
                    <p className="text-xs text-muted-foreground pt-1">
                      {t(
                        'Omvänd skattskyldighet betyder att moms beräknas i Sverige i stället för att debiteras av leverantören. Utgående och ingående moms tar ut varandra.',
                        'Reverse charge means VAT is calculated in Sweden instead of charged by the supplier. The output and input VAT cancel each other out.',
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Svensk moms', 'Swedish VAT')}</p>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t('Avdragsgill moms (SEK)', 'Deductible VAT (SEK)')}</span><span>{formatSEKDecimal(vatSummary.deductibleInputVatSek || purchaseFx.convertedVatSek)}</span></div>
                    <div className="flex justify-between gap-4 font-medium"><span>{t('Nettoeffekt moms', 'Net VAT effect')}</span><span>{formatSEKDecimal(vatSummary.deductibleInputVatSek > 0 ? -vatSummary.deductibleInputVatSek : 0)}</span></div>
                  </div>
                )}
                <div className="flex justify-between font-semibold border-t border-border pt-2"><span>{t('Betalningsbelopp (SEK)', 'Payment amount (SEK)')}</span><span>{formatSEKDecimal(vatSummary.paymentAccountAmountSek)}</span></div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseDetail;
