import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MONTH_NAMES_SV, MONTH_NAMES_EN, formatExchangeRate, formatSEK, getAccountName } from '@/lib/accounting-utils';
import { formatCurrencyAmount, normalizeCurrency } from '@/lib/accounting-fx';
import { fetchAllRows } from '@/lib/fetch-all-rows';
import { Filter, Download, Info, AlertTriangle, CheckCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const AccountingJournal: React.FC = () => {
  const { t, language } = useLanguage();
  const monthNames = language === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;
  const [searchParams, setSearchParams] = useSearchParams();
  const periodFilter = searchParams.get('period') || 'all';
  const accountFilter = searchParams.get('account') || 'all';
  const verificationFilter = searchParams.get('verification') || 'all';

  const { data: periods } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_periods').select('*').order('year').order('month');
      return data || [];
    },
  });

  const { data: verificationOptions } = useQuery({
    queryKey: ['acc-verification-options'],
    queryFn: () => fetchAllRows((from, to) =>
      supabase
        .from('acc_verifications')
        .select('id, verification_number, verification_date, description, period_id')
        .eq('is_posted', true)
        .order('verification_date', { ascending: false })
        .order('id')
        .range(from, to)),
  });

  const { data: journalData, isLoading } = useQuery({
    queryKey: ['acc-journal', periodFilter, accountFilter, verificationFilter],
    queryFn: async () => {
      const verifications = await fetchAllRows((from, to) => {
        let vQuery = supabase.from('acc_verifications').select('id, verification_number, verification_date, description, period_id').eq('is_posted', true).order('verification_date', { ascending: false }).order('id');
        if (periodFilter !== 'all') vQuery = vQuery.eq('period_id', periodFilter);
        if (verificationFilter !== 'all') vQuery = vQuery.eq('id', verificationFilter);
        return vQuery.range(from, to);
      });
      if (verifications.length === 0) return [];
      // Fetch lines without an .in(ids) filter (thousands of UUIDs would blow
      // the request URL) and join client-side against the verification set.
      const vIdSet = new Set(verifications.map(v => v.id));
      const lines = await fetchAllRows((from, to) => {
        let lQuery = supabase.from('acc_journal_lines').select('*').order('verification_id').order('sort_order').order('id');
        if (verificationFilter !== 'all') lQuery = lQuery.eq('verification_id', verificationFilter);
        if (accountFilter !== 'all') lQuery = lQuery.eq('account', accountFilter);
        return lQuery.range(from, to);
      });
      return verifications.flatMap(v => {
        const vLines = lines.filter(l => vIdSet.has(l.verification_id) && l.verification_id === v.id);
        return vLines.map(l => ({ ...l, verification_date: v.verification_date, verification_number: v.verification_number, verification_description: v.description }));
      });
    },
  });

  const filteredVerificationOptions = useMemo(() => {
    if (periodFilter === 'all') return verificationOptions || [];
    return (verificationOptions || []).filter((verification) => verification.period_id === periodFilter);
  }, [periodFilter, verificationOptions]);

  const selectedVerification = filteredVerificationOptions.find((verification) => verification.id === verificationFilter)
    || verificationOptions?.find((verification) => verification.id === verificationFilter)
    || null;
  const verificationSelectOptions = useMemo(() => {
    if (!selectedVerification) return filteredVerificationOptions;
    if (filteredVerificationOptions.some((verification) => verification.id === selectedVerification.id)) {
      return filteredVerificationOptions;
    }
    return [selectedVerification, ...filteredVerificationOptions];
  }, [filteredVerificationOptions, selectedVerification]);

  const updateParam = (key: string, value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value === 'all' || value === '') nextParams.delete(key);
    else nextParams.set(key, value);
    setSearchParams(nextParams);
  };

  const uniqueAccounts = [...new Set((journalData || []).map(l => l.account))].sort();
  const totalDebit = (journalData || []).reduce((s, l) => s + Number(l.debit), 0);
  const totalCredit = (journalData || []).reduce((s, l) => s + Number(l.credit), 0);
  let balance = 0;
  const linesWithBalance = (journalData || []).reverse().map(l => { balance += Number(l.debit) - Number(l.credit); return { ...l, balance }; }).reverse();
  const isGloballyBalanced = linesWithBalance.length > 0 && Math.abs(totalDebit - totalCredit) < 0.01;

  // Check each verification balances individually
  const verificationBalances = new Map<string, { debit: number; credit: number; number: string }>();
  for (const line of journalData || []) {
    const vId = line.verification_id;
    const entry = verificationBalances.get(vId) || { debit: 0, credit: 0, number: line.verification_number || vId };
    entry.debit += Number(line.debit);
    entry.credit += Number(line.credit);
    verificationBalances.set(vId, entry);
  }
  const unbalancedVerifications = [...verificationBalances.values()].filter(v => Math.abs(v.debit - v.credit) >= 0.01);

  const exportToCsv = () => {
    if (!linesWithBalance.length) return;
    const headers = [t('Datum', 'Date'), t('Konto', 'Account'), t('Kontonamn', 'Account name'), t('Verifikation', 'Verification'), t('Beskrivning', 'Description'), t('Original', 'Original'), t('Debet (SEK)', 'Debit (SEK)'), t('Kredit (SEK)', 'Credit (SEK)'), t('Saldo (SEK)', 'Balance (SEK)')];
    const rows = linesWithBalance.map(l => [
      l.verification_date,
      l.account,
      l.account_name || getAccountName(l.account) || '',
      l.verification_number,
      l.description || l.verification_description || '',
      l.original_amount && normalizeCurrency(l.original_currency) !== 'SEK'
        ? `${formatCurrencyAmount(Number(l.original_amount), l.original_currency)} @ ${l.exchange_rate_date} ${formatExchangeRate(l.exchange_rate == null ? null : Number(l.exchange_rate))}`
        : '',
      Number(l.debit) > 0 ? Number(l.debit).toFixed(2) : '',
      Number(l.credit) > 0 ? Number(l.credit).toFixed(2) : '',
      l.balance.toFixed(2),
    ]);
    const csv = [headers, ...rows].map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `journal-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              Journal
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-5 h-5 text-primary cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs text-xs">
                  {t(
                    'Journalen är en kronologisk lista över alla bokförda transaktioner. Varje händelse (t.ex. ett inköp) skapar en "verifikation" med minst en debetrad och en kreditrad — dessa måste alltid balansera. Tänk på det som den fullständiga historiken för allt som hänt i bokföringen.',
                    'The journal is a chronological record of every posted transaction. Each event (e.g. a purchase) creates a "verification" with at least one debit line and one credit line — these must always balance. Think of it as the complete history of everything that has happened in your books.'
                  )}
                </TooltipContent>
              </Tooltip>
            </h1>
            <p className="text-muted-foreground mt-1">{t('Kronologisk lista över alla bokförda transaktioner', 'Chronological list of all posted transactions')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={exportToCsv} disabled={!linesWithBalance.length}><Download className="w-4 h-4 mr-2" /> {t('Exportera CSV', 'Export CSV')}</Button>
        </div>

        {linesWithBalance.length > 0 && isGloballyBalanced && unbalancedVerifications.length === 0 && (
          <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 flex items-center gap-2.5">
            <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
            <span className="text-sm text-green-800">
              {t(
                `Alla ${verificationBalances.size} verifikationer balanserar · Total debet/kredit: ${formatSEK(totalDebit)}`,
                `All ${verificationBalances.size} verifications balance · Total debit/credit: ${formatSEK(totalDebit)}`,
              )}
            </span>
          </div>
        )}

        {linesWithBalance.length > 0 && unbalancedVerifications.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-800">{t('Obalanserade verifikationer', 'Unbalanced verifications')}</p>
              <ul className="text-sm text-red-700 mt-1 space-y-0.5">
                {unbalancedVerifications.map(v => (
                  <li key={v.number}>
                    {v.number}: {t('debet', 'debit')} {formatSEK(v.debit)}, {t('kredit', 'credit')} {formatSEK(v.credit)} ({t('differens', 'difference')}: {formatSEK(Math.abs(v.debit - v.credit))})
                  </li>
                ))}
              </ul>
              <p className="text-xs text-red-600 mt-2">
                {t('Varje verifikation måste ha lika debet och kredit. Korrigera felaktiga poster innan periodstängning.', 'Each verification must have equal debit and credit. Correct the entries before closing the period.')}
              </p>
            </div>
          </div>
        )}

        {linesWithBalance.length > 0 && unbalancedVerifications.length === 0 && !isGloballyBalanced && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-amber-800">{t('Journalen balanserar inte', 'Journal does not balance')}</p>
              <p className="text-sm text-amber-700">
                {t('Total debet och kredit skiljer sig med', 'Total debit and credit differ by')} {formatSEK(Math.abs(totalDebit - totalCredit))}. {t('Kontrollera att alla verifikationer är korrekt registrerade.', 'Check that all verifications are correctly recorded.')}
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-4">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t('Filtrera:', 'Filter:')}</span>
          <div className="flex items-center gap-2">
            <span className="text-sm">{t('Period:', 'Period:')}</span>
            <Select value={periodFilter} onValueChange={(value) => updateParam('period', value)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('Alla perioder', 'All periods')}</SelectItem>
                {periods?.map(p => <SelectItem key={p.id} value={p.id}>{monthNames[p.month]} {p.year}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">{t('Konto:', 'Account:')}</span>
            <Select value={accountFilter} onValueChange={(value) => updateParam('account', value)}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('Alla konton', 'All accounts')}</SelectItem>
                {uniqueAccounts.map(a => <SelectItem key={a} value={a}>{a} – {getAccountName(a) || a}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">{t('Verifikation:', 'Verification:')}</span>
            <Select value={verificationFilter} onValueChange={(value) => updateParam('verification', value)}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('Alla verifikationer', 'All verifications')}</SelectItem>
                {verificationSelectOptions.map((verification) => (
                  <SelectItem key={verification.id} value={verification.id}>
                    {verification.verification_number} · {verification.verification_date}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedVerification && (
            <button
              type="button"
              onClick={() => updateParam('verification', 'all')}
              className="text-sm text-primary hover:underline"
            >
              {t('Rensa verifikation', 'Clear verification')}: {selectedVerification.verification_number}
            </button>
          )}
        </div>

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Datum', 'Date')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Konto', 'Account')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Verifikation', 'Verification')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Beskrivning', 'Description')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Original', 'Original')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Debet', 'Debit')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Kredit', 'Credit')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Saldo', 'Balance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : linesWithBalance.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">{t('Inga bokförda transaktioner', 'No posted transactions')}</TableCell></TableRow>
                ) : (
                  linesWithBalance.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="text-sm">{line.verification_date}</TableCell>
                      <TableCell>
                        <div><span className="text-sm font-semibold">{line.account}</span><p className="text-xs text-muted-foreground">{line.account_name || getAccountName(line.account)}</p></div>
                      </TableCell>
                      <TableCell className="text-sm text-primary">
                        <Link to={`/accounting/journal?verification=${line.verification_id}`} className="hover:underline">
                          {line.verification_number}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{line.description || line.verification_description}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {line.original_amount && normalizeCurrency(line.original_currency) !== 'SEK' ? (
                          <div className="space-y-0.5">
                            <div>{formatCurrencyAmount(Number(line.original_amount), line.original_currency)}</div>
                            <div>{line.exchange_rate_source || '—'} · {line.exchange_rate_date || '—'} · {formatExchangeRate(line.exchange_rate == null ? null : Number(line.exchange_rate))}</div>
                          </div>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm">{Number(line.debit) > 0 ? formatSEK(Number(line.debit)) : '–'}</TableCell>
                      <TableCell className="text-right text-sm">{Number(line.credit) > 0 ? formatSEK(Number(line.credit)) : '–'}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{line.balance >= 0 ? formatSEK(line.balance) : `–${formatSEK(Math.abs(line.balance))}`}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            {linesWithBalance.length > 0 && (
              <div className="border-t border-border px-4 py-3 flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Visar', 'Showing')} {linesWithBalance.length} {t('journalrader', 'journal lines')}</span>
                <div className="flex gap-6">
                  <span>{t('Total Debet', 'Total Debit')} <strong>{formatSEK(totalDebit)}</strong></span>
                  <span>{t('Total Kredit', 'Total Credit')} <strong>{formatSEK(totalCredit)}</strong></span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
};

export default AccountingJournal;
