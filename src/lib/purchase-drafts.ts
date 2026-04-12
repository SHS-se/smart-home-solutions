import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/integrations/supabase/types';
import type { DocumentQualityStatus } from './accounting-utils';
import { suggestExpenseAccount } from './accounting-utils';
import { fuzzyMatchSupplier, generateDescription, type ParsedInvoice } from './invoice-parser';
import {
  buildExchangeSnapshot,
  buildPurchasePersistence,
  normalizeCurrency,
  parseAmount,
  type ExchangeRateLookupResult,
} from './accounting-fx';
import { fetchSingleEcbExchangeRate } from './ecb-rates';
import {
  buildInvoiceNumberNote,
  createEmptyPurchaseForm,
  findExistingSupplier,
  findDuplicatePurchaseId,
  inferSupplierMetadata,
  inferVatTreatment,
  normalizeSupplierInvoiceNumber,
  preserveSupplierInvoiceNumber,
  resolveSavedPurchaseId,
  type PurchaseFormValues,
} from './purchase-workflow';

type SupplierRow = Tables<'acc_suppliers'>;

export interface CreatePurchaseDraftParams {
  supabase: SupabaseClient<Database>;
  suppliers: SupplierRow[];
  userId?: string | null;
  file?: File | null;
  parsedInvoice?: ParsedInvoice | null;
  extractedText?: string | null;
  values: PurchaseFormValues;
  duplicateInvoiceMessage: string;
  fullAmountLabel: string;
  exchangeRateLookup?: ExchangeRateLookupResult;
}

export interface CreatePurchaseDraftResult {
  purchaseId: string;
  suppliers: SupplierRow[];
  documentQualityStatus: DocumentQualityStatus;
  parserReviewRequired: boolean;
  parserReviewReasons: string[];
  parserFingerprintLabel: string;
}

export function buildPurchaseDraftDefaults(params: {
  parsedInvoice?: ParsedInvoice | null;
  extractedText?: string | null;
  suppliers?: Pick<SupplierRow, 'id' | 'name' | 'vat_number'>[];
}): PurchaseFormValues {
  const form = createEmptyPurchaseForm();
  const parsedInvoice = params.parsedInvoice;
  if (!parsedInvoice) return form;
  const trustSupplierIdentity = parsedInvoice.fingerprint.recognized;
  const trustDerivedDescription = parsedInvoice.fingerprint.recognized;

  if (trustSupplierIdentity && parsedInvoice.supplierName) {
    const inferredSupplier = inferSupplierMetadata(parsedInvoice);
    const existingSupplier = findExistingSupplier(params.suppliers || [], {
      supplierName: parsedInvoice.supplierName,
      vatNumber: inferredSupplier.vatNumber,
    });

    if (existingSupplier) {
      form.supplierId = existingSupplier.id;
    } else if (params.suppliers?.length) {
      const fuzzyMatch = fuzzyMatchSupplier(parsedInvoice.supplierName, params.suppliers);
      if (fuzzyMatch && fuzzyMatch.score > 0.7) form.supplierId = fuzzyMatch.id;
      else form.newSupplierName = parsedInvoice.supplierName;
    } else {
      form.newSupplierName = parsedInvoice.supplierName;
    }
  }

  if (parsedInvoice.invoiceNumber) form.invoiceNumber = parsedInvoice.invoiceNumber;
  if (parsedInvoice.invoiceDate) form.documentDate = parsedInvoice.invoiceDate;
  if (parsedInvoice.dueDate) form.dueDate = parsedInvoice.dueDate;
  if (parsedInvoice.currency) form.currency = parsedInvoice.currency;
  if (parsedInvoice.grossAmount != null) form.grossAmount = String(parsedInvoice.grossAmount);
  if (parsedInvoice.vatAmount != null) form.vatAmount = String(parsedInvoice.vatAmount);
  if (parsedInvoice.netAmount != null) form.netAmount = String(parsedInvoice.netAmount);

  const description = trustDerivedDescription
    ? (parsedInvoice.description || generateDescription(parsedInvoice.supplierName, params.extractedText || ''))
    : null;
  if (description) form.description = description;

  return form;
}

export async function createPurchaseDraft(params: CreatePurchaseDraftParams): Promise<CreatePurchaseDraftResult> {
  const { supabase, userId, parsedInvoice, extractedText, duplicateInvoiceMessage, fullAmountLabel } = params;
  const values = params.values;
  let suppliers = [...params.suppliers];
  let supplierId = values.supplierId || null;
  let supplierCountry: string | null = null;
  let supplierType: string | null = null;
  const shouldAutoCreateSupplier = parsedInvoice?.fingerprint.recognized !== false;

  if (supplierId) {
    const selectedSupplier = suppliers.find((supplier) => supplier.id === supplierId);
    supplierCountry = selectedSupplier?.country || null;
    supplierType = selectedSupplier?.supplier_type || null;
  }

  if (shouldAutoCreateSupplier && !supplierId && values.newSupplierName.trim()) {
    const inferredSupplier = inferSupplierMetadata(parsedInvoice || null);
    const existingSupplier = findExistingSupplier(suppliers, {
      supplierName: values.newSupplierName,
      vatNumber: inferredSupplier.vatNumber,
    });

    if (existingSupplier) {
      supplierId = existingSupplier.id;
      const selectedSupplier = suppliers.find((supplier) => supplier.id === existingSupplier.id);
      supplierCountry = selectedSupplier?.country || null;
      supplierType = selectedSupplier?.supplier_type || null;
    } else {
      const { data: createdSupplier, error: supplierError } = await supabase
        .from('acc_suppliers')
        .insert({
          name: values.newSupplierName.trim(),
          country: inferredSupplier.country,
          supplier_type: inferredSupplier.supplierType,
          vat_number: inferredSupplier.vatNumber,
        })
        .select()
        .single();
      if (supplierError) throw supplierError;

      supplierId = createdSupplier.id;
      supplierCountry = createdSupplier.country;
      supplierType = createdSupplier.supplier_type;
      suppliers = [...suppliers, createdSupplier];
    }
  }

  const supplierInvoiceNumber = preserveSupplierInvoiceNumber(values.invoiceNumber);
  const normalizedSupplierInvoiceNumber = normalizeSupplierInvoiceNumber(values.invoiceNumber);
  if (supplierId && normalizedSupplierInvoiceNumber) {
    const { data: duplicateCandidates, error: duplicateCheckError } = await supabase
      .from('acc_purchases')
      .select('id, supplier_id, supplier_invoice_number')
      .eq('supplier_id', supplierId);
    if (duplicateCheckError) throw duplicateCheckError;

    const duplicatePurchaseId = findDuplicatePurchaseId(
      duplicateCandidates || [],
      supplierId,
      normalizedSupplierInvoiceNumber,
    );

    if (duplicatePurchaseId) throw new Error(duplicateInvoiceMessage);
  }

  const normalizedCurrency = normalizeCurrency(values.currency);
  const documentDate = values.documentDate || new Date().toISOString().split('T')[0];
  const originalAmounts = {
    gross: parseAmount(values.grossAmount),
    net: parseAmount(values.netAmount),
    vat: parseAmount(values.vatAmount),
  };
  const rateLookup = normalizedCurrency === 'SEK'
    ? {
        currency: 'SEK',
        rate: 1,
        rateDate: documentDate,
        source: 'SEK' as const,
      }
    : params.exchangeRateLookup ?? await fetchSingleEcbExchangeRate({ currency: normalizedCurrency, documentDate });
  const snapshot = buildExchangeSnapshot({
    documentDate,
    currency: normalizedCurrency,
    originalAmounts,
    lookup: rateLookup,
  });

  const purchasePayload = {
    supplier_id: supplierId,
    supplier_invoice_number: supplierInvoiceNumber,
    document_type: values.documentType,
    document_date: documentDate,
    due_date: values.dueDate || null,
    description: values.description,
    payment_source: values.paymentSource || 'owner_paid',
    notes: buildInvoiceNumberNote(values.invoiceNumber),
    ...buildPurchasePersistence(snapshot),
  };
  const documentQualityStatus: DocumentQualityStatus = parsedInvoice
    ? (parsedInvoice.parserReviewRequired ? 'insufficient' : 'sufficient')
    : 'pending';

  const inferredVatTreatment = inferVatTreatment({
    parsedInvoice: parsedInvoice || null,
    extractedText: extractedText || null,
    supplierCountry,
    supplierType,
  });
  const linePayload = {
    description: values.description || fullAmountLabel,
    net_amount: snapshot.convertedNetSek,
    vat_amount: snapshot.convertedVatSek,
    gross_amount: snapshot.convertedGrossSek,
    vat_rate: parsedInvoice?.vatRate ?? 25,
  };

  let filePath: string | null = null;
  if (params.file) {
    const ext = params.file.name.split('.').pop();
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('purchase-documents').upload(path, params.file);
    if (uploadError) throw uploadError;
    filePath = path;
  }

  const { data: newPurchase, error: purchaseError } = await supabase
    .from('acc_purchases')
    .insert({
      ...purchasePayload,
      document_file_path: filePath,
      document_quality_status: documentQualityStatus,
      status: 'draft',
      created_by: userId,
    })
    .select()
    .single();
  if (purchaseError) throw purchaseError;

  const savedPurchaseId = resolveSavedPurchaseId(null, newPurchase?.id);
  const { error: lineError } = await supabase.from('acc_purchase_lines').insert({
    purchase_id: savedPurchaseId,
    ...linePayload,
    expense_account: suggestExpenseAccount(parsedInvoice?.fingerprint.id, parsedInvoice?.supplierName),
    vat_treatment: inferredVatTreatment,
    sort_order: 0,
  });
  if (lineError) throw lineError;

  return {
    purchaseId: savedPurchaseId,
    suppliers,
    documentQualityStatus,
    parserReviewRequired: parsedInvoice?.parserReviewRequired || false,
    parserReviewReasons: parsedInvoice?.parserReviewReasons || [],
    parserFingerprintLabel: parsedInvoice?.fingerprint.label || 'Unknown invoice layout',
  };
}
