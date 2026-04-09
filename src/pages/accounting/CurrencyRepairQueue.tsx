import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  allocateConvertedLineAmounts,
  buildPurchasePersistence,
  buildPurchaseRepairProposal,
  detectForeignCurrencyIntegrityIssue,
  formatCurrencyAmount,
  getPurchaseExchangeSnapshot,
  normalizeCurrency,
  roundMoney,
} from '@/lib/accounting-fx';
import { fetchEcbExchangeRates } from '@/lib/ecb-rates';
import { formatSEKDecimal } from '@/lib/accounting-utils';
import { toast } from 'sonner';

const STATUS_STYLES: Record<string, string> = {
  draft_can_auto_fix: 'bg-amber-100 text-amber-900',
  draft_fixed: 'bg-green-100 text-green-900',
  posted_requires_correction: 'bg-red-100 text-red-900',
  correction_proposed: 'bg-blue-100 text-blue-900',
  reviewed: 'bg-muted text-muted-foreground',
};

const CurrencyRepairQueue: React.FC = () => {
  const { isAdmin, user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['acc-currency-repair-purchases'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('acc_purchases')
        .select('*, supplier:acc_suppliers(name), verification:acc_verifications(verification_number), lines:acc_purchase_lines(*)')
        .in('currency', ['EUR', 'USD'])
        .order('document_date', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
  });

  const { data: repairCases } = useQuery({
    queryKey: ['acc-currency-repair-cases'],
    queryFn: async () => {
      const { data, error } = await supabase.from('acc_currency_repair_cases').select('*');
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin,
  });

  const { data: fxLookups } = useQuery({
    queryKey: ['acc-currency-repair-lookups', (purchases || []).map((purchase) => `${normalizeCurrency((purchase as any).original_currency || purchase.currency)}:${purchase.document_date}`).sort().join('|')],
    queryFn: async () => {
      const uniqueRequests = Array.from(new Map(
        (purchases || []).map((purchase) => {
          const currency = normalizeCurrency((purchase as any).original_currency || purchase.currency);
          return [`${currency}:${purchase.document_date}`, { currency, documentDate: purchase.document_date }];
        }),
      ).values());
      return fetchEcbExchangeRates(uniqueRequests);
    },
    enabled: isAdmin && Boolean(purchases?.length),
  });

  const caseMap = new Map((repairCases || []).map((repairCase) => [repairCase.purchase_id, repairCase]));
  const rows = (purchases || []).flatMap((purchase) => {
    const currency = normalizeCurrency((purchase as any).original_currency || purchase.currency);
    const lookup = (fxLookups || []).find((item) => item.currency === currency && item.documentDate === purchase.document_date);
    if (!lookup) return [];

    const expected = getPurchaseExchangeSnapshot({
      ...purchase,
      exchange_rate_source: lookup.source,
      exchange_rate_date: lookup.rateDate,
      exchange_rate: lookup.rate,
      ecb_exchange_rate: lookup.rate,
      ecb_exchange_rate_date: lookup.rateDate,
      converted_gross_amount_sek: roundMoney(Number((purchase as any).original_gross_amount ?? purchase.gross_amount) * lookup.rate),
      converted_net_amount_sek: roundMoney(Number((purchase as any).original_net_amount ?? purchase.net_amount) * lookup.rate),
      converted_vat_amount_sek: roundMoney(Number((purchase as any).original_vat_amount ?? purchase.vat_amount) * lookup.rate),
    });
    const detected = detectForeignCurrencyIntegrityIssue(purchase, expected);
    const repairCase = caseMap.get(purchase.id);

    if (!detected && !repairCase) return [];

    return [{
      purchase,
      expected,
      detected,
      repairCase,
      status: repairCase?.status || detected?.status || 'reviewed',
    }];
  });

  const upsertRepairCase = async (payload: Record<string, unknown>) => {
    const { error } = await supabase.from('acc_currency_repair_cases').upsert(payload, { onConflict: 'purchase_id' });
    if (error) throw error;
  };

  const autoFixDraft = useMutation({
    mutationFn: async (row: typeof rows[number]) => {
      const purchaseSnapshot = buildPurchasePersistence(row.expected);
      const lines = allocateConvertedLineAmounts(
        ((row.purchase as any).lines || []).map((line: any) => ({
          ...line,
          net_amount: Number(line.net_amount),
          vat_amount: Number(line.vat_amount),
          gross_amount: Number(line.gross_amount),
        })),
        row.expected,
      );

      const { error: purchaseError } = await supabase
        .from('acc_purchases')
        .update(purchaseSnapshot)
        .eq('id', row.purchase.id);
      if (purchaseError) throw purchaseError;

      await Promise.all(lines.map(async (line) => {
        const { error } = await supabase
          .from('acc_purchase_lines')
          .update({
            net_amount: line.net_amount,
            vat_amount: line.vat_amount,
            gross_amount: line.gross_amount,
          })
          .eq('id', line.id);
        if (error) throw error;
      }));

      await upsertRepairCase({
        purchase_id: row.purchase.id,
        status: 'draft_fixed',
        detected_reason: row.detected?.reason || 'Draft converted to persisted SEK values from invoice-date ECB rate',
        stored_snapshot: row.detected?.stored || getPurchaseExchangeSnapshot(row.purchase),
        expected_snapshot: row.expected,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['acc-currency-repair-purchases'] }),
        queryClient.invalidateQueries({ queryKey: ['acc-currency-repair-cases'] }),
        queryClient.invalidateQueries({ queryKey: ['acc-purchases'] }),
      ]);
      toast.success(t('Utkastet reparerades med ECB-kursen', 'Draft repaired using the ECB rate'));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const createCorrectionProposal = useMutation({
    mutationFn: async (row: typeof rows[number]) => {
      const proposal = buildPurchaseRepairProposal({
        purchaseId: row.purchase.id,
        verificationNumber: ((row.purchase as any).verification as any)?.verification_number || null,
        paymentSource: row.purchase.payment_source as any,
        lines: allocateConvertedLineAmounts(
          ((row.purchase as any).lines || []).map((line: any) => ({
            ...line,
            net_amount: Number(line.net_amount),
            vat_amount: Number(line.vat_amount),
            gross_amount: Number(line.gross_amount),
          })),
          row.expected,
        ),
        stored: row.detected?.stored || getPurchaseExchangeSnapshot(row.purchase),
        expected: row.expected,
      });

      await upsertRepairCase({
        purchase_id: row.purchase.id,
        status: 'correction_proposed',
        detected_reason: row.detected?.reason || 'Posted foreign-currency purchase requires corrective accounting',
        stored_snapshot: row.detected?.stored || getPurchaseExchangeSnapshot(row.purchase),
        expected_snapshot: row.expected,
        proposal_snapshot: proposal,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['acc-currency-repair-cases'] });
      toast.success(t('Korrigeringsförslag skapades', 'Correction proposal created'));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const markReviewed = useMutation({
    mutationFn: async (row: typeof rows[number]) => {
      await upsertRepairCase({
        purchase_id: row.purchase.id,
        status: 'reviewed',
        detected_reason: row.detected?.reason || 'Marked as reviewed',
        stored_snapshot: row.detected?.stored || getPurchaseExchangeSnapshot(row.purchase),
        expected_snapshot: row.expected,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user?.id,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['acc-currency-repair-cases'] });
      toast.success(t('Markerad som granskad', 'Marked as reviewed'));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (!isAdmin) {
    return (
      <AccountingLayout>
        <Card className="border border-border">
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t('Sidan är endast tillgänglig för admin/finance-användare.', 'This page is available only to admin/finance users.')}
          </CardContent>
        </Card>
      </AccountingLayout>
    );
  }

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Valutareparation', 'Currency repair')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('Foreign-currency purchases that need review, auto-fix, or corrective accounting proposals are listed here.', 'Foreign-currency purchases that need review, auto-fix, or corrective accounting proposals are listed here.')}
          </p>
        </div>

        <Card className="border border-border">
          <CardHeader>
            <CardTitle>{t('Reparationskö', 'Repair queue')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Dokument', 'Document')}</TableHead>
                  <TableHead>{t('Leverantör', 'Supplier')}</TableHead>
                  <TableHead>{t('Valuta', 'Currency')}</TableHead>
                  <TableHead>{t('Originalt belopp', 'Original amount')}</TableHead>
                  <TableHead>{t('Fakturadatum', 'Invoice date')}</TableHead>
                  <TableHead className="text-right">{t('Lagrad SEK', 'Stored SEK')}</TableHead>
                  <TableHead className="text-right">{t('Förväntad SEK', 'Expected SEK')}</TableHead>
                  <TableHead>{t('Status', 'Status')}</TableHead>
                  <TableHead className="text-right">{t('Åtgärder', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                      {t('Inga valutaköp behöver reparation just nu.', 'No foreign-currency purchases currently need repair.')}
                    </TableCell>
                  </TableRow>
                ) : rows.map((row) => {
                  const snapshot = getPurchaseExchangeSnapshot(row.purchase);
                  return (
                    <TableRow key={row.purchase.id}>
                      <TableCell className="text-sm">
                        <Link to={`/accounting/purchases/${row.purchase.id}`} className="text-primary hover:underline">
                          {row.purchase.id.slice(0, 8)}...
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{(row.purchase.supplier as any)?.name || '—'}</TableCell>
                      <TableCell className="text-sm">{snapshot.originalCurrency}</TableCell>
                      <TableCell className="text-sm">{formatCurrencyAmount(snapshot.originalGross, snapshot.originalCurrency)}</TableCell>
                      <TableCell className="text-sm">{row.purchase.document_date}</TableCell>
                      <TableCell className="text-right text-sm">{formatSEKDecimal(snapshot.convertedGrossSek)}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{formatSEKDecimal(row.expected.convertedGrossSek)}</TableCell>
                      <TableCell>
                        <Badge className={`${STATUS_STYLES[row.status] || STATUS_STYLES.reviewed} border-0`}>
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {row.status === 'draft_can_auto_fix' && (
                            <Button size="sm" onClick={() => autoFixDraft.mutate(row)} disabled={autoFixDraft.isPending}>
                              {t('Auto-fix draft', 'Auto-fix draft')}
                            </Button>
                          )}
                          {(row.status === 'posted_requires_correction' || row.status === 'correction_proposed') && (
                            <Button size="sm" variant="outline" onClick={() => createCorrectionProposal.mutate(row)} disabled={createCorrectionProposal.isPending}>
                              {t('Create correction proposal', 'Create correction proposal')}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => markReviewed.mutate(row)} disabled={markReviewed.isPending}>
                            {t('Mark reviewed', 'Mark reviewed')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default CurrencyRepairQueue;
