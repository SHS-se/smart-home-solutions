import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  PURCHASE_STATUS_LABELS, PURCHASE_STATUS_COLORS, PAYMENT_SOURCE_LABELS,
  VAT_TREATMENT_LABELS, formatSEK, formatSEKDecimal, buildJournalPreview,
  getPurchaseBlockers, getAccountName, getCreditAccount,
} from '@/lib/accounting-utils';
import type { PaymentSource, VatTreatment } from '@/lib/accounting-utils';
import { toast } from 'sonner';
import { ArrowLeft, AlertTriangle, Eye, FileText, CheckCircle } from 'lucide-react';

const PurchaseDetail: React.FC = () => {
  const { purchaseId } = useParams<{ purchaseId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: purchase, isLoading } = useQuery({
    queryKey: ['acc-purchase', purchaseId],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('*, supplier:acc_suppliers(*)')
        .eq('id', purchaseId!)
        .single();
      return data;
    },
    enabled: !!purchaseId,
  });

  const { data: lines } = useQuery({
    queryKey: ['acc-purchase-lines', purchaseId],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchase_lines')
        .select('*')
        .eq('purchase_id', purchaseId!)
        .order('sort_order');
      return data || [];
    },
    enabled: !!purchaseId,
  });

  const updateLine = useMutation({
    mutationFn: async ({ lineId, updates }: { lineId: string; updates: Record<string, unknown> }) => {
      const { error } = await supabase.from('acc_purchase_lines').update(updates).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['acc-purchase-lines', purchaseId] }),
  });

  const postPurchase = useMutation({
    mutationFn: async () => {
      if (!purchase || !lines) throw new Error('Data missing');

      const blockers = getPurchaseBlockers({
        ...purchase,
        supplier_id: purchase.supplier_id,
        lines: lines.map(l => ({
          vat_treatment: l.vat_treatment,
          net_amount: Number(l.net_amount),
          vat_amount: Number(l.vat_amount),
          gross_amount: Number(l.gross_amount),
        })),
        gross_amount: Number(purchase.gross_amount),
        net_amount: Number(purchase.net_amount),
        vat_amount: Number(purchase.vat_amount),
      });

      const errors = blockers.filter(b => b.type === 'error');
      if (errors.length > 0) throw new Error(errors[0].message);

      // Find period
      const docDate = new Date(purchase.document_date);
      const { data: period } = await supabase
        .from('acc_periods')
        .select('id')
        .eq('year', docDate.getFullYear())
        .eq('month', docDate.getMonth() + 1)
        .single();

      if (!period) throw new Error('Ingen bokföringsperiod hittades för dokumentdatum');

      // Allocate verification number
      const { data: vNum } = await supabase.rpc('allocate_acc_verification_number');
      const verificationNumber = vNum as unknown as string;

      // Create verification
      const { data: verification, error: vErr } = await supabase
        .from('acc_verifications')
        .insert({
          verification_number: verificationNumber,
          verification_date: purchase.posting_date || purchase.document_date,
          description: purchase.description || `Inköp ${(purchase.supplier as any)?.name || ''}`.trim(),
          period_id: period.id,
          source_type: 'purchase',
          source_id: purchase.id,
          is_posted: true,
          posted_at: new Date().toISOString(),
          posted_by: user?.id,
          created_by: user?.id,
        })
        .select()
        .single();

      if (vErr) throw vErr;

      // Build journal lines
      const journalPreview = buildJournalPreview(
        lines.map(l => ({
          expense_account: l.expense_account,
          vat_treatment: l.vat_treatment as VatTreatment,
          net_amount: Number(l.net_amount),
          vat_amount: Number(l.vat_amount),
          gross_amount: Number(l.gross_amount),
          description: l.description,
        })),
        purchase.payment_source as PaymentSource,
        purchase.description || '',
      );

      const journalInserts = journalPreview.map((jl, i) => ({
        verification_id: verification.id,
        account: jl.account,
        account_name: jl.accountName,
        description: jl.description,
        debit: jl.debit,
        credit: jl.credit,
        sort_order: i,
      }));

      const { error: jErr } = await supabase.from('acc_journal_lines').insert(journalInserts);
      if (jErr) throw jErr;

      // Update purchase status
      const { error: pErr } = await supabase
        .from('acc_purchases')
        .update({
          status: 'posted',
          verification_id: verification.id,
          posting_date: purchase.posting_date || purchase.document_date,
        })
        .eq('id', purchase.id);
      if (pErr) throw pErr;

      return verificationNumber;
    },
    onSuccess: (vNum) => {
      queryClient.invalidateQueries({ queryKey: ['acc-purchase', purchaseId] });
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] });
      toast.success(`Bokförd som ${vNum}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !purchase) {
    return <AccountingLayout><div className="py-12 text-center text-muted-foreground">Laddar...</div></AccountingLayout>;
  }

  const blockers = getPurchaseBlockers({
    ...purchase,
    supplier_id: purchase.supplier_id,
    lines: (lines || []).map(l => ({
      vat_treatment: l.vat_treatment,
      net_amount: Number(l.net_amount),
      vat_amount: Number(l.vat_amount),
      gross_amount: Number(l.gross_amount),
    })),
    gross_amount: Number(purchase.gross_amount),
    net_amount: Number(purchase.net_amount),
    vat_amount: Number(purchase.vat_amount),
  });

  const errors = blockers.filter(b => b.type === 'error');
  const warnings = blockers.filter(b => b.type === 'warning');
  const canPost = errors.length === 0 && purchase.status !== 'posted';

  const journalPreview = lines && lines.length > 0
    ? buildJournalPreview(
        lines.map(l => ({
          expense_account: l.expense_account,
          vat_treatment: l.vat_treatment as VatTreatment,
          net_amount: Number(l.net_amount),
          vat_amount: Number(l.vat_amount),
          gross_amount: Number(l.gross_amount),
          description: l.description,
        })),
        purchase.payment_source as PaymentSource,
        purchase.description || '',
      )
    : [];

  return (
    <AccountingLayout>
      <div className="space-y-6">
        {/* Back link */}
        <Link to="/accounting/purchases" className="text-primary text-sm hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Tillbaka till lista
        </Link>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              Granska inköp
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {(purchase.supplier as any)?.name || 'Okänd leverantör'} · {purchase.document_date}
            </p>
          </div>
          <Badge className={`${PURCHASE_STATUS_COLORS[purchase.status as keyof typeof PURCHASE_STATUS_COLORS]} border-0`}>
            {PURCHASE_STATUS_LABELS[purchase.status as keyof typeof PURCHASE_STATUS_LABELS]}
          </Badge>
        </div>

        {/* Blockers */}
        {errors.length > 0 && purchase.status !== 'posted' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-800">Blockerad för bokföring</p>
              <ul className="text-sm text-red-700 mt-1 space-y-0.5">
                {errors.map((b, i) => <li key={i}>• {b.message}</li>)}
              </ul>
            </div>
          </div>
        )}

        {warnings.length > 0 && purchase.status !== 'posted' && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              {warnings.map((b, i) => <p key={i} className="text-sm text-amber-800">{b.message}</p>)}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Document preview */}
            <Card className="border border-border">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">Underlag</CardTitle>
                {purchase.document_file_path && (
                  <Button variant="ghost" size="sm">
                    <Eye className="w-4 h-4 mr-1" /> Fullskärm
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {purchase.document_file_path ? (
                  <div className="bg-muted rounded-lg p-8 text-center">
                    <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">PDF-förhandsvisning</p>
                    <p className="text-xs text-muted-foreground">{purchase.document_file_path}</p>
                  </div>
                ) : (
                  <div className="bg-muted rounded-lg p-8 text-center">
                    <p className="text-sm text-muted-foreground">Inget underlag uppladdat</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Line classification */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="text-base">Radklassificering</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">Beskrivning</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">Konto</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">Momsbehandling</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">Belopp</TableHead>
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
                            <Input
                              className="w-20 h-8 text-sm"
                              value={line.expense_account}
                              onChange={(e) => updateLine.mutate({ lineId: line.id, updates: { expense_account: e.target.value } })}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          {purchase.status === 'posted' ? (
                            <span className="text-sm">{VAT_TREATMENT_LABELS[line.vat_treatment as keyof typeof VAT_TREATMENT_LABELS]}</span>
                          ) : (
                            <Select
                              value={line.vat_treatment}
                              onValueChange={(v) => updateLine.mutate({ lineId: line.id, updates: { vat_treatment: v } })}
                            >
                              <SelectTrigger className="h-8 text-sm w-52">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries(VAT_TREATMENT_LABELS).map(([k, v]) => (
                                  <SelectItem key={k} value={k}>{v}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">
                          {formatSEK(Number(line.gross_amount))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Journal preview */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="text-base">Bokföring</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">Konto</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">Namn</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">Debet</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">Kredit</TableHead>
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

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Supplier card */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="text-base">Leverantör</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Namn</p>
                  <p className="font-medium">{(purchase.supplier as any)?.name || '—'}</p>
                </div>
                {(purchase.supplier as any)?.org_number && (
                  <div>
                    <p className="text-xs text-muted-foreground">Org.nummer</p>
                    <p>{(purchase.supplier as any).org_number}</p>
                  </div>
                )}
                {(purchase.supplier as any)?.country && (
                  <div>
                    <p className="text-xs text-muted-foreground">Land</p>
                    <p>{(purchase.supplier as any).country}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Document details */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="text-base">Dokumentdetaljer</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Fakturadatum</p><p>{purchase.document_date}</p></div>
                {purchase.posting_date && <div><p className="text-xs text-muted-foreground">Bokföringsdatum</p><p>{purchase.posting_date}</p></div>}
                <div><p className="text-xs text-muted-foreground">Betalkälla</p><p>{PAYMENT_SOURCE_LABELS[purchase.payment_source as keyof typeof PAYMENT_SOURCE_LABELS]}</p></div>
                <div><p className="text-xs text-muted-foreground">Valuta</p><p>{purchase.currency}</p></div>
              </CardContent>
            </Card>

            {/* VAT summary */}
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="text-base">Momssammanställning</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Nettobelopp</span><span>{formatSEK(Number(purchase.net_amount))}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Moms 25%</span><span>{formatSEK(Number(purchase.vat_amount))}</span></div>
                <div className="flex justify-between font-semibold border-t border-border pt-2 mt-2"><span>Totalt</span><span>{formatSEK(Number(purchase.gross_amount))}</span></div>
              </CardContent>
            </Card>

            {/* Post action */}
            {purchase.status !== 'posted' && (
              <Button
                className="w-full"
                disabled={!canPost || postPurchase.isPending}
                onClick={() => postPurchase.mutate()}
              >
                {postPurchase.isPending ? 'Bokför...' : 'Bokför faktura'}
              </Button>
            )}

            {purchase.status === 'posted' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="text-sm text-green-800 font-medium">Bokförd</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseDetail;
