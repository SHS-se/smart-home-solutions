// How close the planner's price estimate for unpublished days came to what the
// market then published. Each plan's estimate is kept per home and per day
// (energy_price_estimate_days); this reads it beside the real prices. Staff
// only, and silent for anyone the database refuses.

import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

export interface EstimateRow {
  home_id: string;
  issued_on: string;
  target_day: string;
  lead_days: number;
  basis: string;
  quarters: number;
  estimated_sek_per_kwh: number;
  actual_sek_per_kwh: number | null;
  quarter_mae_sek_per_kwh: number | null;
}

interface LeadSummary { lead: number; basis: string; days: number; levelMae: number; bias: number; quarterMae: number }

/** Mean errors per days of lead and basis, over the estimates whose day has since been published. */
export function summariseEstimates(rows: EstimateRow[]): LeadSummary[] {
  const groups = new Map<string, EstimateRow[]>();
  for (const row of rows) {
    // A day estimated in part (the plan's last day) says little about its level.
    if (row.actual_sek_per_kwh === null || row.quarter_mae_sek_per_kwh === null || row.quarters < 48) continue;
    const key = `${row.lead_days}/${row.basis}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return [...groups.values()].map(group => ({
    lead: group[0].lead_days,
    basis: group[0].basis,
    days: group.length,
    levelMae: mean(group.map(row => Math.abs(Number(row.estimated_sek_per_kwh) - Number(row.actual_sek_per_kwh)))),
    bias: mean(group.map(row => Number(row.estimated_sek_per_kwh) - Number(row.actual_sek_per_kwh))),
    quarterMae: mean(group.map(row => Number(row.quarter_mae_sek_per_kwh))),
  })).sort((a, b) => a.lead - b.lead || a.basis.localeCompare(b.basis));
}

const db = supabase as unknown as SupabaseClient;
const kr = (value: number, signed = false) => `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}`;

const PriceEstimateAccuracy: React.FC = () => {
  const { t } = useLanguage();
  const query = useQuery({
    queryKey: ['price-estimate-accuracy'],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_price_estimate_accuracy', { p_days: 60 });
      if (error) throw new Error(error.message);
      return (data ?? []) as EstimateRow[];
    },
    retry: false,
    refetchInterval: 15 * 60_000,
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const summary = useMemo(() => summariseEstimates(rows), [rows]);
  const basisLabel = (basis: string) => basis === 'wind' ? t('vind', 'wind') : t('norm', 'norm');
  if (query.isError || rows.length === 0) return null;
  const recent = rows.filter(row => row.quarters >= 48).slice(0, 12);

  return (
    <Card data-testid="price-estimate-accuracy">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('Prisuppskattningens träffsäkerhet', 'Price estimate accuracy')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('Vad planeraren trodde att opublicerade dagar skulle kosta, mot vad de sedan kostade. Importpris, kr/kWh, senaste 60 dagarna.',
            'What the planner believed unpublished days would cost, against what they then cost. Import price, SEK/kWh, last 60 days.')}
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('Dagar fram', 'Days ahead')}</th>
              <th className="py-1 pr-3 font-medium">{t('Grund', 'Basis')}</th>
              <th className="py-1 pr-3 font-medium text-right">{t('Dagar', 'Days')}</th>
              <th className="py-1 pr-3 font-medium text-right" title={t('Medelfel i dagens medelpris', 'Mean error in the day’s mean price')}>{t('Nivåfel', 'Level error')}</th>
              <th className="py-1 pr-3 font-medium text-right" title={t('Positivt: uppskattningen var för hög', 'Positive: the estimate was too high')}>{t('Skevhet', 'Bias')}</th>
              <th className="py-1 font-medium text-right" title={t('Medelfel per kvart', 'Mean error per quarter-hour')}>{t('Kvartsfel', 'Quarter error')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.length === 0 && (
              <tr><td colSpan={6} className="py-2 text-muted-foreground">{t('Inga uppskattade dagar har publicerats än.', 'No estimated day has been published yet.')}</td></tr>
            )}
            {summary.map(row => (
              <tr key={`${row.lead}/${row.basis}`} className="border-t">
                <td className="py-1 pr-3">{row.lead}</td>
                <td className="py-1 pr-3">{basisLabel(row.basis)}</td>
                <td className="py-1 pr-3 text-right">{row.days}</td>
                <td className="py-1 pr-3 text-right font-medium">{kr(row.levelMae)}</td>
                <td className="py-1 pr-3 text-right">{kr(row.bias, true)}</td>
                <td className="py-1 text-right">{kr(row.quarterMae)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('Dag', 'Day')}</th>
              <th className="py-1 pr-3 font-medium">{t('Uppskattad', 'Estimated on')}</th>
              <th className="py-1 pr-3 font-medium">{t('Grund', 'Basis')}</th>
              <th className="py-1 pr-3 font-medium text-right">{t('Trodde', 'Believed')}</th>
              <th className="py-1 pr-3 font-medium text-right">{t('Blev', 'Was')}</th>
              <th className="py-1 font-medium text-right">{t('Fel', 'Error')}</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(row => {
              const error = row.actual_sek_per_kwh === null ? null : Number(row.estimated_sek_per_kwh) - Number(row.actual_sek_per_kwh);
              return (
                <tr key={`${row.home_id}/${row.issued_on}/${row.target_day}`} className="border-t">
                  <td className="py-1 pr-3">{row.target_day}</td>
                  <td className="py-1 pr-3 text-muted-foreground">{row.issued_on}</td>
                  <td className="py-1 pr-3">{basisLabel(row.basis)}</td>
                  <td className="py-1 pr-3 text-right">{kr(Number(row.estimated_sek_per_kwh))}</td>
                  <td className="py-1 pr-3 text-right">{row.actual_sek_per_kwh === null ? '–' : kr(Number(row.actual_sek_per_kwh))}</td>
                  <td className={`py-1 text-right ${error !== null && Math.abs(error) > 0.5 ? 'text-destructive' : ''}`}>{error === null ? t('väntar', 'waiting') : kr(error, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
};

export default PriceEstimateAccuracy;
