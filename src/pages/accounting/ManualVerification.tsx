import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MONTH_NAMES_SV, MONTH_NAMES_EN, getAccountName, formatSEKDecimal } from '@/lib/accounting-utils';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';

interface ManualLine { id: string; account: string; debit: string; credit: string; }

const ManualVerification: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  const monthNames = language === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;
  const queryClient = useQueryClient();

  const [form, setForm] = useState({ date: new Date().toISOString().split('T')[0], description: '', periodId: '' });
  const [lines, setLines] = useState<ManualLine[]>([
    { id: '1', account: '', debit: '', credit: '' },
    { id: '2', account: '', debit: '', credit: '' },
  ]);

  const { data: periods } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => { const { data } = await supabase.from('acc_periods').select('*').order('year').order('month'); return data || []; },
  });

  const addLine = () => setLines([...lines, { id: String(Date.now()), account: '', debit: '', credit: '' }]);
  const removeLine = (id: string) => { if (lines.length <= 2) return; setLines(lines.filter(l => l.id !== id)); };
  const updateLine = (id: string, field: keyof ManualLine, value: string) => setLines(lines.map(l => l.id === id ? { ...l, [field]: value } : l));

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const postVerification = useMutation({
    mutationFn: async () => {
      if (!isBalanced) throw new Error(t('Debet och kredit måste balansera', 'Debit and credit must balance'));
      if (!form.description.trim()) throw new Error(t('Beskrivning krävs', 'Description required'));
      if (!form.periodId) throw new Error(t('Välj en period', 'Select a period'));
      const { data: vNum } = await supabase.rpc('allocate_acc_verification_number');
      const { data: verification, error: vErr } = await supabase.from('acc_verifications').insert({
        verification_number: vNum as unknown as string, verification_date: form.date, description: form.description,
        period_id: form.periodId, source_type: 'manual', is_posted: true, posted_at: new Date().toISOString(), posted_by: user?.id, created_by: user?.id,
      }).select().single();
      if (vErr) throw vErr;
      const journalInserts = lines.filter(l => l.account && (Number(l.debit) > 0 || Number(l.credit) > 0)).map((l, i) => ({
        verification_id: verification.id, account: l.account, account_name: getAccountName(l.account),
        description: form.description, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, sort_order: i,
      }));
      const { error: jErr } = await supabase.from('acc_journal_lines').insert(journalInserts);
      if (jErr) throw jErr;
      return vNum;
    },
    onSuccess: (vNum) => {
      queryClient.invalidateQueries({ queryKey: ['acc-journal'] });
      toast.success(t(`Verifikation ${vNum} bokförd`, `Verification ${vNum} posted`));
      navigate('/accounting/journal');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AccountingLayout>
      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Manuell verifikation', 'Manual verification')}</h1>
          <p className="text-muted-foreground mt-1">{t('Skapa en manuell journalpost', 'Create a manual journal entry')}</p>
        </div>

        <Card className="border border-border">
          <CardContent className="p-6 space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('Datum', 'Date')}</Label>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t('Period', 'Period')}</Label>
                <Select value={form.periodId} onValueChange={(v) => setForm({ ...form, periodId: v })}>
                  <SelectTrigger><SelectValue placeholder={t('Välj period...', 'Select period...')} /></SelectTrigger>
                  <SelectContent>
                    {periods?.filter(p => p.status === 'open' || p.status === 'review').map(p => (
                      <SelectItem key={p.id} value={p.id}>{monthNames[p.month]} {p.year}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('Beskrivning', 'Description')}</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('Beskriv verifikationen...', 'Describe the verification...')} rows={2} />
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">{t('Rader', 'Lines')}</Label>
                <Button variant="ghost" size="sm" onClick={addLine}><Plus className="w-4 h-4 mr-1" /> {t('Lägg till rad', 'Add line')}</Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                    <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Debet', 'Debit')}</TableHead>
                    <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Kredit', 'Credit')}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Input className="w-24 h-8 text-sm" value={line.account} onChange={(e) => updateLine(line.id, 'account', e.target.value)} placeholder="4000" />
                          <span className="text-xs text-muted-foreground">{getAccountName(line.account)}</span>
                        </div>
                      </TableCell>
                      <TableCell><Input className="w-28 h-8 text-sm text-right ml-auto" type="number" step="0.01" value={line.debit} onChange={(e) => updateLine(line.id, 'debit', e.target.value)} placeholder="0" /></TableCell>
                      <TableCell><Input className="w-28 h-8 text-sm text-right ml-auto" type="number" step="0.01" value={line.credit} onChange={(e) => updateLine(line.id, 'credit', e.target.value)} placeholder="0" /></TableCell>
                      <TableCell>{lines.length > 2 && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeLine(line.id)}><Trash2 className="w-3.5 h-3.5" /></Button>}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2">
                    <TableCell className="font-medium text-sm">{t('Summa', 'Total')}</TableCell>
                    <TableCell className="text-right text-sm font-medium">{formatSEKDecimal(totalDebit)}</TableCell>
                    <TableCell className="text-right text-sm font-medium">{formatSEKDecimal(totalCredit)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
              {totalDebit > 0 && !isBalanced && (
                <p className="text-sm text-destructive mt-2">{t('Debet och kredit balanserar inte', 'Debit and credit do not balance')} ({t('differens', 'difference')}: {formatSEKDecimal(Math.abs(totalDebit - totalCredit))})</p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button onClick={() => postVerification.mutate()} disabled={!isBalanced || postVerification.isPending}>
                {postVerification.isPending ? t('Bokför...', 'Posting...') : t('Bokför verifikation', 'Post verification')}
              </Button>
              <Button variant="outline" onClick={() => navigate('/accounting/journal')}>{t('Avbryt', 'Cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default ManualVerification;
