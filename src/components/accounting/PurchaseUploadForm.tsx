import React, { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import { formatExchangeRate } from '@/lib/accounting-utils';
import { fuzzyMatchSupplier, generateDescription, type ParsedInvoice } from '@/lib/invoice-parser';
import {
  buildExchangeSnapshot,
  buildPurchasePersistence,
  formatCurrencyAmount,
  isForeignCurrency,
  normalizeCurrency,
  parseAmount,
} from '@/lib/accounting-fx';
import { fetchSingleEcbExchangeRate } from '@/lib/ecb-rates';
import {
  buildInvoiceNumberNote,
  createEmptyPurchaseForm,
  extractInvoiceNumberFromNotes,
  findDuplicatePurchaseId,
  inferSupplierMetadata,
  inferVatTreatment,
  normalizeSupplierInvoiceNumber,
  resolveSavedPurchaseId,
} from '@/lib/purchase-workflow';

interface Props {
  file?: File | null;
  parsedInvoice?: ParsedInvoice | null;
  extractedText?: string | null;
  purchase?: Tables<'acc_purchases'> | null;
  purchaseLine?: Tables<'acc_purchase_lines'> | null;
  disabled?: boolean;
  fillHeight?: boolean;
  title?: string;
  submitLabel?: string;
  onSaved?: (purchaseId: string) => void;
}

const PurchaseUploadForm: React.FC<Props> = ({
  file = null,
  parsedInvoice = null,
  extractedText = null,
  purchase = null,
  purchaseLine = null,
  disabled = false,
  fillHeight = false,
  title,
  submitLabel,
  onSaved,
}) => {
  const { user, isAdmin } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const appliedRef = useRef<ParsedInvoice | null>(null);
  const isEditing = !!purchase;

  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const [form, setForm] = useState(createEmptyPurchaseForm);
  const [manualExchangeRate, setManualExchangeRate] = useState('');
  const [manualOverrideReason, setManualOverrideReason] = useState('');

  const { data: suppliers } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => { const { data } = await supabase.from('acc_suppliers').select('*').order('name'); return data || []; },
  });

  useEffect(() => {
    if (!purchase) return;

    setForm({
      supplierId: purchase.supplier_id || '',
      newSupplierName: '',
      invoiceNumber: purchase.supplier_invoice_number || extractInvoiceNumberFromNotes(purchase.notes),
      documentType: purchase.document_type || 'supplier_invoice',
      documentDate: purchase.document_date || '',
      dueDate: purchase.due_date || '',
      currency: purchase.original_currency || purchase.currency || 'SEK',
      grossAmount: String(Number(purchase.original_gross_amount ?? purchase.gross_amount) || 0),
      vatAmount: String(Number(purchase.original_vat_amount ?? purchase.vat_amount) || 0),
      netAmount: String(Number(purchase.original_net_amount ?? purchase.net_amount) || 0),
      paymentSource: purchase.payment_source || '',
      description: purchase.description || purchaseLine?.description || '',
    });
    setManualExchangeRate(purchase.exchange_rate_overridden ? String(Number(purchase.exchange_rate) || '') : '');
    setManualOverrideReason(purchase.exchange_rate_override_reason || '');
    setAutoFilled(new Set());
  }, [purchase, purchaseLine]);

  useEffect(() => {
    if (isEditing || !parsedInvoice || parsedInvoice === appliedRef.current) return;
    appliedRef.current = parsedInvoice;
    const f = { ...form };
    const filled = new Set<string>();
    if (parsedInvoice.supplierName) {
      if (suppliers?.length) {
        const match = fuzzyMatchSupplier(parsedInvoice.supplierName, suppliers);
        if (match && match.score > 0.7) { f.supplierId = match.id; filled.add('supplierId'); }
        else { f.newSupplierName = parsedInvoice.supplierName; filled.add('newSupplierName'); }
      } else { f.newSupplierName = parsedInvoice.supplierName; filled.add('newSupplierName'); }
    }
    if (parsedInvoice.invoiceNumber) { f.invoiceNumber = parsedInvoice.invoiceNumber; filled.add('invoiceNumber'); }
    if (parsedInvoice.invoiceDate) { f.documentDate = parsedInvoice.invoiceDate; filled.add('documentDate'); }
    if (parsedInvoice.dueDate) { f.dueDate = parsedInvoice.dueDate; filled.add('dueDate'); }
    if (parsedInvoice.currency) { f.currency = parsedInvoice.currency; filled.add('currency'); }
    if (parsedInvoice.grossAmount != null) { f.grossAmount = String(parsedInvoice.grossAmount); filled.add('grossAmount'); }
    if (parsedInvoice.vatAmount != null) { f.vatAmount = String(parsedInvoice.vatAmount); filled.add('vatAmount'); }
    if (parsedInvoice.netAmount != null) { f.netAmount = String(parsedInvoice.netAmount); filled.add('netAmount'); }
    const desc = parsedInvoice.description || generateDescription(parsedInvoice.supplierName, extractedText || '');
    if (desc) { f.description = desc; filled.add('description'); }
    setForm(f);
    setAutoFilled(filled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedInvoice, isEditing]);

  const updateField = (field: string, value: string) => {
    setForm(f => ({ ...f, [field]: value }));
    setAutoFilled(af => { const n = new Set(af); n.delete(field); return n; });
  };

  const normalizedCurrency = normalizeCurrency(form.currency);
  const isForeignDocument = isForeignCurrency(normalizedCurrency);
  const documentDate = form.documentDate || new Date().toISOString().split('T')[0];
  const originalAmounts = {
    gross: parseAmount(form.grossAmount),
    net: parseAmount(form.netAmount),
    vat: parseAmount(form.vatAmount),
  };
  const parsedManualExchangeRate = manualExchangeRate.trim() ? parseAmount(manualExchangeRate) : null;
  const preserveExistingOverride = Boolean(!isAdmin && purchase?.exchange_rate_overridden);

  const exchangeRatePreview = useQuery({
    queryKey: ['acc-ecb-rate-preview', normalizedCurrency, documentDate],
    queryFn: () => fetchSingleEcbExchangeRate({ currency: normalizedCurrency, documentDate }),
    enabled: normalizedCurrency.length === 3 && !!documentDate && ['SEK', 'EUR', 'USD'].includes(normalizedCurrency),
  });

  const effectiveOverrideRate = preserveExistingOverride
    ? parseAmount(purchase?.exchange_rate)
    : parsedManualExchangeRate;
  const effectiveOverrideReason = preserveExistingOverride
    ? (purchase?.exchange_rate_override_reason || '')
    : manualOverrideReason;

  const exchangeSnapshot = exchangeRatePreview.data
    ? buildExchangeSnapshot({
        documentDate,
        currency: normalizedCurrency,
        originalAmounts,
        lookup: exchangeRatePreview.data,
        overrideRate: effectiveOverrideRate,
        overrideReason: effectiveOverrideReason,
      })
    : null;

  const saveBlockedByFx = isForeignDocument && (
    exchangeRatePreview.isLoading ||
    !!exchangeRatePreview.error ||
    !exchangeSnapshot ||
    (manualExchangeRate.trim().length > 0 && (
      !isAdmin ||
      !manualOverrideReason.trim() ||
      (parsedManualExchangeRate != null && parsedManualExchangeRate <= 0)
    ))
  );

  const saveDraft = useMutation({
    mutationFn: async () => {
      let supplierId = form.supplierId || null;
      let supplierCountry: string | null = null;
      let supplierType: string | null = null;

      if (supplierId) {
        const selectedSupplier = suppliers?.find((supplier) => supplier.id === supplierId);
        supplierCountry = selectedSupplier?.country || null;
        supplierType = selectedSupplier?.supplier_type || null;
      }

      if (!supplierId && form.newSupplierName.trim()) {
        const inferredSupplier = inferSupplierMetadata(parsedInvoice);
        const { data: ns, error } = await supabase.from('acc_suppliers').insert({
          name: form.newSupplierName.trim(),
          country: inferredSupplier.country,
          supplier_type: inferredSupplier.supplierType,
          vat_number: inferredSupplier.vatNumber,
        }).select().single();
        if (error) throw error;
        supplierId = ns.id;
        supplierCountry = ns.country;
        supplierType = ns.supplier_type;
      }

      const supplierInvoiceNumber = normalizeSupplierInvoiceNumber(form.invoiceNumber);
      if (supplierId && supplierInvoiceNumber) {
        const { data: duplicateCandidates, error: duplicateCheckError } = await supabase
          .from('acc_purchases')
          .select('id, supplier_id, supplier_invoice_number')
          .eq('supplier_id', supplierId)
          .eq('supplier_invoice_number', supplierInvoiceNumber);
        if (duplicateCheckError) throw duplicateCheckError;

        const duplicatePurchaseId = findDuplicatePurchaseId(
          duplicateCandidates || [],
          supplierId,
          supplierInvoiceNumber,
          purchase?.id,
        );

        if (duplicatePurchaseId) {
          throw new Error(
            t(
              'Den här leverantörsfakturan finns redan registrerad och kan inte sparas igen.',
              'This supplier invoice is already registered and cannot be saved again.',
            ),
          );
        }
      }

      const rateLookup = normalizedCurrency === 'SEK'
        ? {
            currency: 'SEK',
            rate: 1,
            rateDate: documentDate,
            source: 'SEK' as const,
          }
        : await fetchSingleEcbExchangeRate({ currency: normalizedCurrency, documentDate });

      const snapshot = buildExchangeSnapshot({
        documentDate,
        currency: normalizedCurrency,
        originalAmounts,
        lookup: rateLookup,
        overrideRate: effectiveOverrideRate,
        overrideReason: effectiveOverrideReason,
      });

      const purchasePayload = {
        supplier_id: supplierId,
        supplier_invoice_number: supplierInvoiceNumber,
        document_type: form.documentType,
        document_date: documentDate,
        due_date: form.dueDate || null,
        description: form.description,
        payment_source: form.paymentSource || 'owner_paid',
        notes: buildInvoiceNumberNote(form.invoiceNumber),
        ...buildPurchasePersistence(snapshot),
      };

      const inferredVatTreatment = inferVatTreatment({
        parsedInvoice,
        extractedText,
        supplierCountry,
        supplierType,
      });
      const linePayload = {
        description: form.description || t('Hela beloppet', 'Full amount'),
        net_amount: snapshot.convertedNetSek,
        vat_amount: snapshot.convertedVatSek,
        gross_amount: snapshot.convertedGrossSek,
        vat_rate: parsedInvoice?.vatRate ?? purchaseLine?.vat_rate ?? 25,
      };

      if (purchase) {
        const { error: purchaseError } = await supabase.from('acc_purchases').update(purchasePayload).eq('id', purchase.id);
        if (purchaseError) throw purchaseError;

        if (purchaseLine) {
          const lineUpdates: Record<string, unknown> = { ...linePayload };
          if (purchaseLine.vat_treatment === 'needs_review' && inferredVatTreatment !== 'needs_review') {
            lineUpdates.vat_treatment = inferredVatTreatment;
          }

          const { error: lineError } = await supabase.from('acc_purchase_lines').update(lineUpdates).eq('id', purchaseLine.id);
          if (lineError) throw lineError;
        } else {
          const { error: lineError } = await supabase.from('acc_purchase_lines').insert({
            purchase_id: purchase.id,
            ...linePayload,
            expense_account: '4000',
            vat_treatment: inferredVatTreatment,
            sort_order: 0,
          });
          if (lineError) throw lineError;
        }

        return purchase.id;
      }

      let filePath: string | null = null;
      if (file) {
        const ext = file.name.split('.').pop();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error } = await supabase.storage.from('purchase-documents').upload(path, file);
        if (error) throw error;
        filePath = path;
      }
      const { data: newPurchase, error } = await supabase.from('acc_purchases').insert({
        ...purchasePayload,
        document_file_path: filePath,
        status: 'draft',
        created_by: user?.id,
      }).select().single();
      if (error) throw error;
      const savedPurchaseId = resolveSavedPurchaseId(purchase?.id, newPurchase?.id);
      await supabase.from('acc_purchase_lines').insert({
        purchase_id: savedPurchaseId,
        ...linePayload,
        expense_account: '4000',
        vat_treatment: inferredVatTreatment,
        sort_order: 0,
      });
      return savedPurchaseId;
    },
    onSuccess: (savedPurchaseId) => {
      if (purchase?.id) {
        queryClient.invalidateQueries({ queryKey: ['acc-purchase', purchase.id] });
        queryClient.invalidateQueries({ queryKey: ['acc-purchase-lines', purchase.id] });
      }
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] });
      toast.success(
        isEditing
          ? t('Utkast uppdaterat', 'Draft updated')
          : t('Inköp sparat som utkast', 'Purchase saved as draft'),
      );
      onSaved?.(savedPurchaseId);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const AutoLabel = ({ text, field }: { text: string; field: string }) => (
    <div className="flex items-center gap-1.5">
      <Label className="text-xs text-muted-foreground">{text}</Label>
      {autoFilled.has(field) && (
        <TooltipProvider><Tooltip><TooltipTrigger asChild>
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" />
        </TooltipTrigger><TooltipContent side="right" className="text-xs">{t('Automatiskt tolkad – kontrollera', 'Auto-detected – please verify')}</TooltipContent></Tooltip></TooltipProvider>
      )}
    </div>
  );

  return (
    <Card className={`border border-border overflow-auto ${fillHeight ? 'h-full' : ''}`}>
      <CardHeader className="pb-4"><CardTitle className="text-base">{title || t('Dokumentdetaljer', 'Document details')}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <AutoLabel text={t('Leverantör', 'Supplier')} field="supplierId" />
          <Select
            value={form.supplierId}
            disabled={disabled || saveDraft.isPending}
            onValueChange={(v) => { setForm(f => ({ ...f, supplierId: v, newSupplierName: '' })); setAutoFilled(af => { const n = new Set(af); n.delete('supplierId'); return n; }); }}
          >
            <SelectTrigger><SelectValue placeholder={t('Välj leverantör...', 'Select supplier...')} /></SelectTrigger>
            <SelectContent>{suppliers?.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          {!form.supplierId && (
            <div>
              <AutoLabel text="" field="newSupplierName" />
              <Input
                placeholder={t('Eller skapa ny leverantör...', 'Or create new supplier...')}
                value={form.newSupplierName}
                disabled={disabled || saveDraft.isPending}
                onChange={(e) => updateField('newSupplierName', e.target.value)}
                className="text-sm"
              />
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <AutoLabel text={t('Fakturanummer', 'Invoice number')} field="invoiceNumber" />
          <Input value={form.invoiceNumber} disabled={disabled || saveDraft.isPending} onChange={(e) => updateField('invoiceNumber', e.target.value)} placeholder={t('Leverantörens ref...', 'Supplier ref...')} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t('Dokumenttyp', 'Document type')}</Label>
          <Select value={form.documentType} disabled={disabled || saveDraft.isPending} onValueChange={(v) => updateField('documentType', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="supplier_invoice">{t('Leverantörsfaktura', 'Supplier invoice')}</SelectItem>
              <SelectItem value="receipt">{t('Kvitto', 'Receipt')}</SelectItem>
              <SelectItem value="other">{t('Annat', 'Other')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <AutoLabel text={t('Fakturadatum', 'Invoice date')} field="documentDate" />
            <Input type="date" value={form.documentDate} disabled={disabled || saveDraft.isPending} onChange={(e) => updateField('documentDate', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <AutoLabel text={t('Förfallodatum', 'Due date')} field="dueDate" />
            <Input type="date" value={form.dueDate} disabled={disabled || saveDraft.isPending} onChange={(e) => updateField('dueDate', e.target.value)} />
          </div>
        </div>

        <div className="space-y-1.5">
          <AutoLabel text={t('Valuta', 'Currency')} field="currency" />
          <Input value={form.currency} disabled={disabled || saveDraft.isPending} onChange={(e) => updateField('currency', e.target.value.toUpperCase())} placeholder="SEK" maxLength={3} />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <AutoLabel text={isForeignDocument ? t('Originalt brutto', 'Original gross') : t('Brutto', 'Gross')} field="grossAmount" />
            <Input type="number" step="0.01" disabled={disabled || saveDraft.isPending} value={form.grossAmount} onChange={(e) => updateField('grossAmount', e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <AutoLabel text={isForeignDocument ? t('Original moms', 'Original VAT') : t('Moms', 'VAT')} field="vatAmount" />
            <Input type="number" step="0.01" disabled={disabled || saveDraft.isPending} value={form.vatAmount} onChange={(e) => updateField('vatAmount', e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <AutoLabel text={isForeignDocument ? t('Originalt netto', 'Original net') : t('Netto', 'Net')} field="netAmount" />
            <Input type="number" step="0.01" disabled={disabled || saveDraft.isPending} value={form.netAmount} onChange={(e) => updateField('netAmount', e.target.value)} placeholder="0" />
          </div>
        </div>

        {normalizedCurrency.length === 3 && ['SEK', 'EUR', 'USD'].includes(normalizedCurrency) && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t('Dokumentvaluta', 'Document currency')}</span>
              <span className="font-medium">{normalizedCurrency}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t('Originalt netto', 'Original net')}</span>
              <span>{formatCurrencyAmount(originalAmounts.net, normalizedCurrency)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">
                {normalizedCurrency === 'SEK'
                  ? t('Växelkurs', 'Exchange rate')
                  : t('ECB-kurs', 'ECB rate')}
              </span>
              <span>
                {exchangeRatePreview.isLoading
                  ? t('Hämtar...', 'Loading...')
                  : exchangeRatePreview.error
                    ? t('Kunde inte hämta', 'Lookup failed')
                    : exchangeSnapshot
                      ? `${exchangeSnapshot.exchangeRateSource === 'MANUAL_OVERRIDE' ? t('Manuell', 'Manual') : 'ECB'} ${exchangeSnapshot.exchangeRateDate ? `${t('på', 'on')} ${exchangeSnapshot.exchangeRateDate}` : ''}: ${formatExchangeRate(exchangeSnapshot.exchangeRate)}`
                      : '—'}
              </span>
            </div>
            {exchangeSnapshot && (
              <>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('Omräknat netto', 'Converted net')}</span>
                  <span className="font-medium">{formatCurrencyAmount(exchangeSnapshot.convertedNetSek, 'SEK')}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('Omräknad moms', 'Converted VAT')}</span>
                  <span>{formatCurrencyAmount(exchangeSnapshot.convertedVatSek, 'SEK')}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('Omräknat brutto', 'Converted gross')}</span>
                  <span>{formatCurrencyAmount(exchangeSnapshot.convertedGrossSek, 'SEK')}</span>
                </div>
              </>
            )}
            {isForeignDocument && isAdmin && (
              <div className="border-t border-border pt-2 space-y-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{t('Manuell växelkurs', 'Manual exchange rate')}</Label>
                  <Input
                    type="number"
                    step="0.0001"
                    value={manualExchangeRate}
                    disabled={disabled || saveDraft.isPending}
                    onChange={(e) => setManualExchangeRate(e.target.value)}
                    placeholder={t('Lämna tomt för ECB', 'Leave empty to use ECB')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{t('Orsak till manuell kurs', 'Reason for manual rate')}</Label>
                  <Textarea
                    value={manualOverrideReason}
                    disabled={disabled || saveDraft.isPending || !manualExchangeRate.trim()}
                    onChange={(e) => setManualOverrideReason(e.target.value)}
                    placeholder={t('Krävs vid manuell överstyrning', 'Required for manual overrides')}
                    rows={2}
                  />
                </div>
              </div>
            )}
            {isForeignDocument && !isAdmin && purchase?.exchange_rate_overridden && (
              <p className="text-xs text-amber-700">
                {t('Växelkursen är manuellt överstyrd av admin och bevaras vid sparning.', 'This exchange rate was manually overridden by an admin and will be preserved when saving.')}
              </p>
            )}
            {isForeignDocument && exchangeRatePreview.error && (
              <p className="text-xs text-destructive">
                {t('ECB-kursen kunde inte hämtas. Dokumentet kan inte sparas förrän kursen finns tillgänglig.', 'The ECB rate could not be fetched. The document cannot be saved until the rate is available.')}
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t('Betalkälla', 'Payment source')}</Label>
          <Select value={form.paymentSource} disabled={disabled || saveDraft.isPending} onValueChange={(v) => updateField('paymentSource', v)}>
            <SelectTrigger><SelectValue placeholder={t('Välj betalkälla...', 'Select payment source...')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="owner_paid">{t('Ägarens egna medel', 'Owner\'s own funds')}</SelectItem>
              <SelectItem value="company_bank">{t('Företagskonto', 'Company bank account')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <AutoLabel text={t('Beskrivning', 'Description')} field="description" />
          <Textarea value={form.description} disabled={disabled || saveDraft.isPending} onChange={(e) => updateField('description', e.target.value)} placeholder={t('Vad är köpt...', 'What was purchased...')} rows={2} />
        </div>

        <Button onClick={() => saveDraft.mutate()} disabled={disabled || saveDraft.isPending || saveBlockedByFx} className="w-full gap-2">
          <Save className="h-4 w-4" />
          {saveDraft.isPending
            ? t('Sparar...', 'Saving...')
            : submitLabel || (isEditing ? t('Spara ändringar', 'Save changes') : t('Spara utkast', 'Save draft'))}
        </Button>
      </CardContent>
    </Card>
  );
};

export default PurchaseUploadForm;
