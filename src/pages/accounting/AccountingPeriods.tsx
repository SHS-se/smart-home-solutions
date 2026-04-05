import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MONTH_NAMES_SV, PERIOD_STATUS_LABELS, PERIOD_STATUS_COLORS } from '@/lib/accounting-utils';
import { toast } from 'sonner';
import { Lock, Unlock, Info } from 'lucide-react';

const AccountingPeriods: React.FC = () => {
  const queryClient = useQueryClient();

  const { data: periods, isLoading } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_periods')
        .select('*')
        .order('year')
        .order('month');
      return data || [];
    },
  });

  const { data: verificationCounts } = useQuery({
    queryKey: ['acc-verification-counts'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_verifications')
        .select('period_id, id')
        .eq('is_posted', true);
      const counts: Record<string, number> = {};
      (data || []).forEach(v => {
        counts[v.period_id!] = (counts[v.period_id!] || 0) + 1;
      });
      return counts;
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const updates: Record<string, unknown> = { status };
      if (status === 'locked') {
        updates.locked_at = new Date().toISOString();
      }
      const { error } = await supabase.from('acc_periods').update(updates).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-periods'] });
      toast.success('Period uppdaterad');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const getActionButton = (period: { id: string; status: string }) => {
    switch (period.status) {
      case 'open':
        return (
          <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'closed' })}>
            Stäng period
          </Button>
        );
      case 'review':
        return (
          <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'closed' })}>
            Stäng
          </Button>
        );
      case 'closed':
        return (
          <Button variant="outline" size="sm" onClick={() => updateStatus.mutate({ id: period.id, status: 'locked' })}>
            <Lock className="w-3.5 h-3.5 mr-1" /> Lås
          </Button>
        );
      case 'locked':
        return (
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => updateStatus.mutate({ id: period.id, status: 'open' })}>
            <Unlock className="w-3.5 h-3.5 mr-1" /> Öppna igen
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Räkenskapsår och perioder</h1>
          <p className="text-muted-foreground mt-1">Hantera bokföringsperioder och räkenskapsår</p>
        </div>

        {/* Year summary */}
        <Card className="border border-border">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">Räkenskapsår 2026</h2>
                <p className="text-sm text-muted-foreground">1 januari 2026 – 31 december 2026</p>
              </div>
              <Badge className="bg-primary/10 text-primary border-0">Pågående</Badge>
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <p className="text-xs text-muted-foreground">Öppna perioder</p>
                <p className="text-2xl font-bold">{periods?.filter(p => p.status === 'open').length || 0}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Stängda perioder</p>
                <p className="text-2xl font-bold">{periods?.filter(p => p.status === 'closed').length || 0}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Låsta perioder</p>
                <p className="text-2xl font-bold">{periods?.filter(p => p.status === 'locked').length || 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Monthly periods table */}
        <Card className="border border-border">
          <CardHeader>
            <CardTitle>Månatliga perioder</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">Period</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Verifikationer</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">Åtgärder</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(periods || []).map((period) => (
                  <TableRow key={period.id}>
                    <TableCell className="font-medium">
                      {MONTH_NAMES_SV[period.month]} {period.year}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${PERIOD_STATUS_COLORS[period.status as keyof typeof PERIOD_STATUS_COLORS]} border-0 text-xs`}>
                        {PERIOD_STATUS_LABELS[period.status as keyof typeof PERIOD_STATUS_LABELS]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {verificationCounts?.[period.id] || 0} bokförda
                    </TableCell>
                    <TableCell className="text-right">
                      {getActionButton(period)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Info banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-sm text-foreground">
            <p className="font-medium text-primary">Periodhantering</p>
            <p className="text-muted-foreground mt-1">
              Perioder måste stängas och låsas i kronologisk ordning. En låst period kan endast öppnas igen av ekonomiansvarig, och all aktivitet loggas för revision.
            </p>
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default AccountingPeriods;
