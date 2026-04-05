import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { QUARTER_LABELS, QUARTER_MONTHS, formatSEK } from '@/lib/accounting-utils';
import { Calendar, AlertCircle, CheckCircle, Info } from 'lucide-react';

const VAT_STATUS_LABELS: Record<string, string> = {
  open: 'Öppen',
  in_review: 'Granskning',
  approved: 'Godkänd',
  filed: 'Inlämnad',
  locked: 'Låst',
};

const VAT_STATUS_COLORS: Record<string, string> = {
  open: 'bg-green-100 text-green-800',
  in_review: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  filed: 'bg-green-100 text-green-800',
  locked: 'bg-primary/10 text-primary',
};

const VatPeriodsList: React.FC = () => {
  const { data: vatPeriods } = useQuery({
    queryKey: ['acc-vat-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_vat_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('quarter', { ascending: false });
      return data || [];
    },
  });

  // Count unresolved purchase issues for Q1 2026
  const { data: q1Issues } = useQuery({
    queryKey: ['acc-q1-issues'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('id, status')
        .gte('document_date', '2026-01-01')
        .lte('document_date', '2026-03-31')
        .neq('status', 'posted');
      return data?.length || 0;
    },
  });

  const { data: q1PostedCount } = useQuery({
    queryKey: ['acc-q1-posted'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('id')
        .gte('document_date', '2026-01-01')
        .lte('document_date', '2026-03-31')
        .eq('status', 'posted');
      return data?.length || 0;
    },
  });

  const q1Total = (q1PostedCount || 0) + (q1Issues || 0);
  const q1Readiness = q1Total > 0 ? Math.round((q1PostedCount || 0) / q1Total * 100) : 0;

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            Momsperioder
            <Info className="w-5 h-5 text-primary cursor-help" />
          </h1>
          <p className="text-muted-foreground mt-1">Kvartalsvis momsrapportering och inlämning</p>
        </div>

        {/* Alert for Q1 */}
        {q1Issues !== undefined && q1Issues > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-amber-800">Q1 2026 kräver granskning</p>
              <p className="text-sm text-amber-700 mt-0.5">
                {q1Issues} inköp ej bokförda. Deadline 12 maj 2026.
              </p>
              <Link to="/accounting/vat-periods/q1-2026">
                <Button size="sm" variant="destructive" className="mt-2">Granska nu</Button>
              </Link>
            </div>
          </div>
        )}

        {/* Quarter cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(vatPeriods || []).map((vp) => {
            const isQ1 = vp.year === 2026 && vp.quarter === 1;
            const readiness = isQ1 ? q1Readiness : 0;
            const issues = isQ1 ? q1Issues || 0 : 0;
            const periodSlug = `q${vp.quarter}-${vp.year}`;

            return (
              <Card key={vp.id} className="border border-border">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-xl font-bold">{QUARTER_LABELS[vp.quarter]} {vp.year}</h3>
                      <p className="text-sm text-muted-foreground">{QUARTER_MONTHS[vp.quarter]}</p>
                    </div>
                    <Badge className={`${VAT_STATUS_COLORS[vp.status] || ''} border-0 text-xs`}>
                      {VAT_STATUS_LABELS[vp.status] || vp.status}
                    </Badge>
                  </div>

                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Beredskap</span>
                      <span className="font-medium">{readiness}%</span>
                    </div>
                    <Progress value={readiness} className="h-2" />

                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Problem</span>
                      {issues > 0 ? (
                        <span className="text-destructive font-medium">{issues} problem</span>
                      ) : (
                        <span className="text-green-600 flex items-center gap-1">
                          <CheckCircle className="w-3.5 h-3.5" /> Inga problem
                        </span>
                      )}
                    </div>

                    {vp.deadline && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Deadline</span>
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {new Date(vp.deadline).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="mt-5">
                    {isQ1 ? (
                      <Link to={`/accounting/vat-periods/${periodSlug}`}>
                        <Button className="w-full">Granska och godkänn</Button>
                      </Link>
                    ) : (
                      <Button variant="outline" className="w-full" disabled>
                        Ej tillgänglig
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-primary">Momsrapportering steg för steg</p>
            <ol className="list-decimal list-inside text-muted-foreground mt-2 space-y-1">
              <li>Bokför alla inköp i kvartalet</li>
              <li>Granska och åtgärda alla flaggade transaktioner</li>
              <li>Kontrollera momsberäkningarna i varje deklarationsruta</li>
              <li>Godkänn och skapa en ögonblicksbild av rapporten</li>
              <li>Exportera underlag för inlämning</li>
              <li>Ladda upp bekräftelse från Skatteverket</li>
            </ol>
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default VatPeriodsList;
