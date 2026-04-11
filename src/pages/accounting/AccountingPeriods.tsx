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
import { toast } from 'sonner';
import { Lock, Unlock, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const AccountingPeriods: React.FC = () => {
  const queryClient = useQueryClient();
  const { t, language } = useLanguage();
  const monthNames = language === 'sv' ? MONTH_NAMES_SV : MONTH_NAMES_EN;
  const statusLabels = language === 'sv' ? PERIOD_STATUS_LABELS : PERIOD_STATUS_LABELS_EN;

  const { data: periods, isLoading } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
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

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
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

  const getActionButton = (period: { id: string; status: string }) => {
    switch (period.status) {
      case 'open':
        return <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'closed' })}>{t('Stäng period', 'Close period')}</Button>;
      case 'review':
        return <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'closed' })}>{t('Stäng', 'Close')}</Button>;
      case 'closed':
        return <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'locked' })}><Lock className="w-3.5 h-3.5 mr-1" /> {t('Lås', 'Lock')}</Button>;
      case 'locked':
        return <Button variant="ghost" size="sm" className="text-destructive" onClick={() => updateStatus.mutate({ id: period.id, status: 'open' })}><Unlock className="w-3.5 h-3.5 mr-1" /> {t('Öppna igen', 'Reopen')}</Button>;
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
                    <TableCell className="text-muted-foreground">{verificationCounts?.[period.id] || 0} {t('bokförda', 'posted')}</TableCell>
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
