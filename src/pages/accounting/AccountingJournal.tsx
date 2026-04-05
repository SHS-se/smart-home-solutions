import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MONTH_NAMES_SV, formatSEK, getAccountName } from '@/lib/accounting-utils';
import { Filter, Download, Info } from 'lucide-react';

const AccountingJournal: React.FC = () => {
  const [periodFilter, setPeriodFilter] = useState<string>('all');
  const [accountFilter, setAccountFilter] = useState<string>('all');

  const { data: periods } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_periods').select('*').order('year').order('month');
      return data || [];
    },
  });

  const { data: journalData, isLoading } = useQuery({
    queryKey: ['acc-journal', periodFilter, accountFilter],
    queryFn: async () => {
      let vQuery = supabase
        .from('acc_verifications')
        .select('id, verification_number, verification_date, description, period_id')
        .eq('is_posted', true)
        .order('verification_date', { ascending: false });

      if (periodFilter !== 'all') {
        vQuery = vQuery.eq('period_id', periodFilter);
      }

      const { data: verifications } = await vQuery;
      if (!verifications || verifications.length === 0) return [];

      const vIds = verifications.map(v => v.id);
      let lQuery = supabase
        .from('acc_journal_lines')
        .select('*')
        .in('verification_id', vIds)
        .order('sort_order');

      if (accountFilter !== 'all') {
        lQuery = lQuery.eq('account', accountFilter);
      }

      const { data: lines } = await lQuery;

      // Merge
      return verifications.flatMap(v => {
        const vLines = (lines || []).filter(l => l.verification_id === v.id);
        return vLines.map(l => ({
          ...l,
          verification_date: v.verification_date,
          verification_number: v.verification_number,
          verification_description: v.description,
        }));
      });
    },
  });

  // Get unique accounts for filter
  const uniqueAccounts = [...new Set((journalData || []).map(l => l.account))].sort();

  // Running balance calc
  const totalDebit = (journalData || []).reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = (journalData || []).reduce((s, l) => s + Number(l.credit), 0);

  // Compute running balance per line
  let balance = 0;
  const linesWithBalance = (journalData || []).reverse().map(l => {
    balance += Number(l.debit) - Number(l.credit);
    return { ...l, balance };
  }).reverse();

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              Journal
              <Info className="w-5 h-5 text-primary cursor-help" />
            </h1>
            <p className="text-muted-foreground mt-1">Kronologisk lista över alla bokförda transaktioner</p>
          </div>
          <Button variant="outline" size="sm">
            <Download className="w-4 h-4 mr-2" /> Exportera
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filtrera:</span>
          <div className="flex items-center gap-2">
            <span className="text-sm">Period:</span>
            <Select value={periodFilter} onValueChange={setPeriodFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alla perioder</SelectItem>
                {periods?.map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {MONTH_NAMES_SV[p.month]} {p.year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">Konto:</span>
            <Select value={accountFilter} onValueChange={setAccountFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alla konton</SelectItem>
                {uniqueAccounts.map(a => (
                  <SelectItem key={a} value={a}>{a} – {getAccountName(a) || a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Table */}
        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">Datum</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Konto</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Verifikation</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Beskrivning</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">Debet</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">Kredit</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">Saldo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Laddar...</TableCell>
                  </TableRow>
                ) : linesWithBalance.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                      Inga bokförda transaktioner
                    </TableCell>
                  </TableRow>
                ) : (
                  linesWithBalance.map((line, i) => (
                    <TableRow key={line.id}>
                      <TableCell className="text-sm">{line.verification_date}</TableCell>
                      <TableCell>
                        <div>
                          <span className="text-sm font-semibold">{line.account}</span>
                          <p className="text-xs text-muted-foreground">{line.account_name || getAccountName(line.account)}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-primary">{line.verification_number}</TableCell>
                      <TableCell className="text-sm">{line.description || line.verification_description}</TableCell>
                      <TableCell className="text-right text-sm">{Number(line.debit) > 0 ? formatSEK(Number(line.debit)) : '–'}</TableCell>
                      <TableCell className="text-right text-sm">{Number(line.credit) > 0 ? formatSEK(Number(line.credit)) : '–'}</TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {line.balance >= 0 ? formatSEK(line.balance) : `–${formatSEK(Math.abs(line.balance))}`}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            {linesWithBalance.length > 0 && (
              <div className="border-t border-border px-4 py-3 flex justify-between text-sm">
                <span className="text-muted-foreground">Visar {linesWithBalance.length} journalrader</span>
                <div className="flex gap-6">
                  <span>Total Debet <strong>{formatSEK(totalDebit)}</strong></span>
                  <span>Total Kredit <strong>{formatSEK(totalCredit)}</strong></span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default AccountingJournal;
