import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MONTH_NAMES_SV, MONTH_NAMES_EN, PERIOD_STATUS_LABELS, PERIOD_STATUS_LABELS_EN, PERIOD_STATUS_COLORS } from '@/lib/accounting-utils';
import { isAccountingPeriodLockedByVatFiling } from '@/lib/vat-periods';
import { toast } from 'sonner';
import { Lock, Unlock, Info, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const AccountingPeriods: React.FC = () => {
  const queryClient = useQueryClient();
  const { t, language } = useLanguage();
  const monthNames = language === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;
  const statusLabels = language === 'sv' ? PERIOD_STATUS_LABELS : PERIOD_STATUS_LABELS_EN;

  const { data: periods, isLoading } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      // Ensure the current and next month always have a period row before fetching.
      await supabase.rpc('acc_ensure_current_periods');
      const { data } = await supabase.from('acc_periods').select('*').order('year').order('month');
      return data || [];
    },
  });

  const { data: verificationCounts } = useQuery({
    queryKey: ['acc-verification-counts'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_verifications').select('period_id, id').eq('is_posted', true);
      const counts: Record<string, number> = {};
      (data || []).forEach(v => { counts[v.period_id!] = (counts[v.period_id!] || 0) + 1; });
      return counts;
    },
  });

  const { data: unpostedByPeriod } = useQuery({
    queryKey: ['acc-unposted-by-period'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_purchases').select('document_date, status').neq('status', 'posted');
      const counts: Record<string, number> = {};
      (data || []).forEach(p => {
        const d = new Date(p.document_date);
        const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
        counts[key] = (counts[key] || 0) + 1;
      });
      return counts;
    },
  });

  const { data: filedVatPeriods } = useQuery({
    queryKey: ['acc-filed-vat-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_vat_periods')
        .select('year, quarter, filing_confirmation_path, filing_confirmed_at')
        .not('filing_confirmed_at', 'is', null);
      return data || [];
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status, year, month }: { id: string; status: string; year: number; month: number }) => {
      if (
        status === 'open' &&
        isAccountingPeriodLockedByVatFiling({ year, month }, filedVatPeriods || [])
      ) {
        throw new Error(t(
          'Perioden kan inte öppnas igen efter att momsbekräftelsen har laddats upp för kvartalet.',
          'This period cannot be reopened after the VAT filing confirmation has been uploaded for the quarter.',
        ));
      }
      const updates: Record<string, unknown> = { status };
      if (status === 'locked') updates.locked_at = new Date().toISOString();
      const { error } = await supabase.from('acc_periods').update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-periods'] });
      toast.success(t('Period uppdaterad', 'Period updated'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const getActionButton = (period: { id: string; status: string; year: number; month: number }) => {
    const lockedByVatFiling = isAccountingPeriodLockedByVatFiling({
      year: period.year,
      month: period.month,
    }, filedVatPeriods || []);

    if (lockedByVatFiling) {
      return (
        <Button variant="secondary" size="sm" disabled>
          <Lock className="w-3.5 h-3.5 mr-1" /> {t('Låst via momsinlämning', 'Locked by VAT filing')}
        </Button>
      );
    }

    switch (period.status) {
      case 'open':
        return <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'closed', year: period.year, month: period.month })}>{t('Stäng period', 'Close period')}</Button>;
      case 'review':
        return <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'closed', year: period.year, month: period.month })}>{t('Stäng', 'Close')}</Button>;
      case 'closed':
        return (
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => updateStatus.mutate({ id: period.id, status: 'open', year: period.year, month: period.month })}>
              <Unlock className="w-3.5 h-3.5 mr-1" /> {t('Öppna igen', 'Reopen')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'locked', year: period.year, month: period.month })}>
              <Lock className="w-3.5 h-3.5 mr-1" /> {t('Lås', 'Lock')}
            </Button>
          </div>
        );
      case 'locked':
        return <Button variant="ghost" size="sm" className="text-destructive" onClick={() => updateStatus.mutate({ id: period.id, status: 'open', year: period.year, month: period.month })}><Unlock className="w-3.5 h-3.5 mr-1" /> {t('Öppna igen', 'Reopen')}</Button>;
      default: return null;
    }
  };

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            {t('Räkenskapsår och perioder', 'Fiscal years and periods')}
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-5 h-5 text-primary cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs">
                {t(
                  'Bokföringsperioder delar upp året i hanterbara delar (månader). En "öppen" period kan ta emot nya transaktioner. "Stängd" innebär att inga fler poster bör läggas till. "Låst" betyder att perioden är permanent förseglad för revisionsändamål.',
                  'Accounting periods divide the year into manageable chunks (months). An "open" period can receive new transactions. "Closed" means no more entries should be added. "Locked" means the period is permanently sealed for audit purposes.'
                )}
              </TooltipContent>
            </Tooltip>
          </h1>
          <p className="text-muted-foreground mt-1">{t('Hantera bokföringsperioder och räkenskapsår', 'Manage accounting periods and fiscal years')}</p>
        </div>

        <Card className="border border-border">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">{t('Räkenskapsår 2026', 'Fiscal year 2026')}</h2>
                <p className="text-sm text-muted-foreground">{t('1 januari 2026 – 31 december 2026', '1 January 2026 – 31 December 2026')}</p>
              </div>
              <Badge className="bg-primary/10 text-primary border-0">{t('Pågående', 'In progress')}</Badge>
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <p className="text-xs text-muted-foreground">{t('Öppna perioder', 'Open periods')}</p>
                <p className="text-2xl font-bold">{periods?.filter(p => p.status === 'open').length || 0}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Stängda perioder', 'Closed periods')}</p>
                <p className="text-2xl font-bold">{periods?.filter(p => p.status === 'closed').length || 0}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Låsta perioder', 'Locked periods')}</p>
                <p className="text-2xl font-bold">{periods?.filter(p => p.status === 'locked').length || 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border border-border">
          <CardHeader><CardTitle>{t('Månatliga perioder', 'Monthly periods')}</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Period', 'Period')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Verifikationer', 'Verifications')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Åtgärder', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(periods || []).map((period) => (
                  <TableRow key={period.id}>
                    <TableCell className="font-medium">{monthNames[period.month]} {period.year}</TableCell>
                    <TableCell>
                      <Badge className={`${PERIOD_STATUS_COLORS[period.status as keyof typeof PERIOD_STATUS_COLORS]} border-0 text-xs`}>
                        {statusLabels[period.status as keyof typeof statusLabels]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">{verificationCounts?.[period.id] || 0} {t('bokförda', 'posted')}</span>
                      {(() => {
                        const key = `${period.year}-${period.month}`;
                        const unposted = unpostedByPeriod?.[key] || 0;
                        return unposted > 0 ? (
                          <span className="inline-flex items-center gap-1 ml-2 text-amber-700 text-xs">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {unposted} {t('ej bokförda', 'unposted')}
                          </span>
                        ) : null;
                      })()}
                    </TableCell>
                    <TableCell className="text-right">{getActionButton(period)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-sm text-foreground">
            <p className="font-medium text-primary">{t('Periodhantering', 'Period management')}</p>
            <p className="text-muted-foreground mt-1">
              {t(
                'Perioder måste stängas och låsas i kronologisk ordning. En låst period kan endast öppnas igen av ekonomiansvarig, och all aktivitet loggas för revision.',
                'Periods must be closed and locked in chronological order. A locked period can only be reopened by the finance manager, and all activity is logged for audit.'
              )}
            </p>
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default AccountingPeriods;
