import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import EnergyChart from '../charts/EnergyChart';
import { modelChartData } from '@/lib/energy-shift/model-chart-data';
import { projectPlanChart } from '@/lib/energy-shift/plan-chart-data';
import BaselineModelDetails from './BaselineModelDetails';
import PeriodComparison from './PeriodComparison';
import type { BaselineSession } from '@/lib/home-baseline/session';
import { formatHomeDateTime, formatHomeMonth, homeMonthBounds } from '@/lib/energy-shift/home-time';
import { downloadJson } from '@/lib/download-json';
import { useHomeTimeZone } from '../HomeTimeZoneContext';

export default function HomeBaselineViewer({ session, homeId, onClose }: { session: BaselineSession; homeId: string | null; onClose: () => void }) {
  const { t } = useLanguage(), homeTimeZone = useHomeTimeZone();
  const { view, period, capture, busy, error, timeZone: sessionTimeZone, canPrevious, canNext } = useSyncExternalStore(session.subscribe, session.snapshot);
  const [graphMode, setGraphMode] = useState<'default' | 'scheduler' | 'actual'>('default');
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => { setSelected(null); }, [period, graphMode]);
  const timeZone = sessionTimeZone ?? homeTimeZone;
  const stamp = (at: string) => formatHomeDateTime(at, timeZone);
  const amount = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const partialMonth = period?.view === 'month' && Date.parse(period.end) < homeMonthBounds(period.start, 0, timeZone).endMs;
  const input = capture?.input, result = capture?.result, p = input?.problem;
  const quarter = selected === null || !result || selected >= result.series.start.length ? null : selected;
  const chart = useMemo(() => {
    if (!capture) return null;
    if (graphMode === 'actual') return projectPlanChart({ rows: capture.input.recorded.rows, devices: capture.input.recorded.devices,
      range: { from: 0, to: capture.input.recorded.rows.length }, timeZone: capture.input.timeZone, prices: { kind: 'bench' } });
    const { series } = graphMode === 'scheduler' ? capture.scheduler : capture.result;
    return projectPlanChart({ ...modelChartData(series), devices: series.devices,
      range: { from: 0, to: series.start.length }, timeZone: capture.input.timeZone });
  }, [capture, graphMode]);

  return <Card data-testid="roi-baseline"><CardHeader className="flex-row items-center justify-between"><CardTitle>{t('Grafer', 'Graphs')}</CardTitle><Button variant="ghost" className="min-h-11" onClick={onClose}>{t('Stäng graf', 'Close graph')}</Button></CardHeader>
    <CardContent className="space-y-5" aria-busy={busy}>
      <div className="flex gap-2" role="group" aria-label={t('Tidsperiod', 'Time horizon')}>
        <Button variant={view === 'frame' ? 'default' : 'outline'} className="min-h-11" aria-pressed={view === 'frame'} onClick={() => session.setView('frame')} data-testid="baseline-view-frame">72 h</Button>
        <Button variant={view === 'month' ? 'default' : 'outline'} className="min-h-11" aria-pressed={view === 'month'} onClick={() => session.setView('month')} data-testid="baseline-view-month">{t('Månad', 'Month')}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" className="min-h-11" onClick={() => session.step(-1)} disabled={!canPrevious} data-testid="baseline-previous" aria-label={view === 'month' ? t('Föregående månad', 'Previous month') : t('Föregående period', 'Previous period')}>
          <ChevronLeft className="mr-1 h-4 w-4" />{t('Föregående', 'Previous')}<span className="hidden sm:inline">{view === 'month' ? t(' månad', ' month') : t(' period', ' period')}</span>
        </Button>
        <Button variant="outline" className="min-h-11" onClick={() => session.step(1)} disabled={!canNext} data-testid="baseline-next" aria-label={view === 'month' ? t('Nästa månad', 'Next month') : t('Nästa period', 'Next period')}>
          {t('Nästa', 'Next')}<span className="hidden sm:inline">{view === 'month' ? t(' månad', ' month') : t(' period', ' period')}</span><ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        <p className="text-sm" data-testid="baseline-frame" aria-live="polite">{period
          ? view === 'month' ? `${formatHomeMonth(period.start, timeZone)}${partialMonth ? ` · ${t('till', 'through')} ${stamp(period.end)}` : ''}`
            : `${stamp(period.start)} – ${stamp(period.end)}`
          : view === 'month' ? t('Senaste månaden', 'Latest month') : t('Senaste 72 timmarna', 'Latest 72 hours')}</p>
      </div>
      {!homeId && <p className="text-sm text-muted-foreground">{t('Välj ett hem för att generera modellen.', 'Select a home to generate the model.')}</p>}
      {error && <Alert variant="destructive"><AlertTitle>{t('Modellen kunde inte genereras', 'Could not generate the model')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!capture && !busy && homeId && <p className="text-sm text-muted-foreground">{t('Generera modellen för vald period.', 'Generate the model for this period.')}</p>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t('Genererar…', 'Generating…')}</p>}
      {capture && input && result && p && chart && <>
        <PeriodComparison capture={capture} />
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Graf', 'Graph')}>
          <Button variant={graphMode === 'default' ? 'default' : 'outline'} className="min-h-11" aria-pressed={graphMode === 'default'} onClick={() => setGraphMode('default')} data-testid="comparison-graph-default">{t('Basmodell', 'Baseline model')}</Button>
          <Button variant={graphMode === 'scheduler' ? 'default' : 'outline'} className="min-h-11" aria-pressed={graphMode === 'scheduler'} onClick={() => setGraphMode('scheduler')} data-testid="comparison-graph-scheduler">SHS Energy Scheduler</Button>
          <Button variant={graphMode === 'actual' ? 'default' : 'outline'} className="min-h-11" aria-pressed={graphMode === 'actual'} onClick={() => setGraphMode('actual')} data-testid="comparison-graph-actual">{t('Uppmätt förbrukning', 'Recorded consumption')}</Button>
        </div>
        <EnergyChart key={`${graphMode}:${view}:${input.start}:${input.end}`} rows={chart.rows} series={chart.consumption.series}
          baseValues={chart.consumption.baseValues} consumptionIssues={chart.consumption.issues}
          timeZone={input.timeZone} dividerIndex={graphMode === 'actual' ? chart.rows.length : 0} dividerLabel={graphMode === 'actual' ? t('UPPMÄTT', 'RECORDED') : graphMode === 'scheduler' ? 'SHS ENERGY SCHEDULER' : t('BASMODELL', 'BASELINE MODEL')}
          hasBattery={p.battery !== null} hasEvBattery={p.car !== null} realPrices={chart.realPrices}
          poolTargetC={p.pool_stop_c} selectedIndex={quarter ?? -1} onQuarterClick={setSelected}
          costLines={[{ key: graphMode, name: graphMode === 'actual' ? t('Uppmätt förbrukning', 'Recorded consumption') : graphMode === 'scheduler' ? 'SHS Energy Scheduler' : t('Basmodell', 'Baseline model'), colour: 'var(--plan-load-2)',
            values: chart.rows.map((row, i) => {
              if (graphMode === 'actual') return row.cumulativeCostSek;
              const bill = graphMode === 'scheduler' ? capture.modeled.schedulerBill : capture.modeled.baselineBill;
              return row.cumulativeCostSek + (bill.supplierFixedSek + bill.gridFixedSek) * (i + 1) / chart.rows.length + (i === chart.rows.length - 1 ? bill.gridPeakSek : 0);
            }) }]}
          scoreDetail={quarter === null ? null : <div data-testid="baseline-quarter" className="text-sm">
            {stamp(result.series.start[quarter])} · {t('Elkostnad', 'Electricity cost')}: {amount(graphMode === 'actual' ? input.recorded.rows[quarter].costSek ?? 0 : (graphMode === 'scheduler' ? capture.scheduler : result).series.costSek[quarter])} SEK
            {graphMode === 'default' && p.car && <> · {t('Körbehov', 'Driving demand')}: {amount(input.evDemandKwh[quarter])} kWh</>}
          </div>} />
        <BaselineModelDetails capture={capture} />
      </>}
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" onClick={() => session.generate()} disabled={busy || !homeId} data-testid="baseline-generate">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('Generera modell', 'Generate model')}
        </Button>
        {capture && <Button variant="outline" className="min-h-11" onClick={() => downloadJson(`default-model-${capture.input.start.slice(0, 10)}.json`, capture)}>{t('Exportera modell', 'Export model')}</Button>}
      </div>
    </CardContent>
  </Card>;
}
