import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import EnergyChart from '../charts/EnergyChart';
import { modelChartData } from '@/lib/energy-shift/model-chart-data';
import { projectPlanChart } from '@/lib/energy-shift/plan-chart-data';
import BaselineModelDetails from './BaselineModelDetails';
import { generateHomeBaseline, type BaselineCapture } from '@/lib/home-baseline/browser';
import { BaselineGenerationError, frameStart, shiftFrame } from '@/lib/home-baseline/model';
import { formatHomeDateTime } from '@/lib/energy-shift/home-time';
import { downloadJson } from '@/lib/download-json';
import { useHomeTimeZone } from '../HomeTimeZoneContext';

const CACHE_FRAMES = 8;

export default function HomeBaselineViewer({ customerId, homeId }: { customerId: string; homeId: string | null }) {
  const { t } = useLanguage(), homeTimeZone = useHomeTimeZone();
  const frames = useRef(new Map<string, BaselineCapture>());
  const request = useRef<AbortController | null>(null);
  const [latestEnd, setLatestEnd] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [capture, setCapture] = useState<BaselineCapture | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const timeZone = capture?.input.timeZone ?? homeTimeZone;
  const stamp = (at: string) => formatHomeDateTime(at, timeZone);
  const amount = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const move = (direction: -1 | 1) => {
    if (!end) return;
    request.current?.abort(); request.current = null;
    const next = shiftFrame(end, direction);
    setEnd(next); setCapture(frames.current.get(next) ?? null); setError(null); setBusy(false);
    setSelected(null);
  };
  const generate = async () => {
    if (!homeId) return;
    request.current?.abort();
    if (end) frames.current.delete(end);
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null); setCapture(null); setSelected(null);
    try {
      const result = await generateHomeBaseline({ customerId, homeId }, end, controller.signal);
      controller.signal.throwIfAborted();
      if (request.current !== controller) return;
      frames.current.delete(result.input.end);
      frames.current.set(result.input.end, result);
      if (frames.current.size > CACHE_FRAMES) frames.current.delete(frames.current.keys().next().value!);
      setLatestEnd(previous => previous ?? result.input.end); setEnd(result.input.end); setCapture(result);
    } catch (failure) {
      if (!controller.signal.aborted && request.current === controller) {
        setError(failure instanceof Error ? failure.message : String(failure));
        if (failure instanceof BaselineGenerationError) {
          setLatestEnd(previous => previous ?? failure.end); setEnd(failure.end);
        }
      }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  const input = capture?.input, result = capture?.result, p = input?.problem;
  const quarter = selected === null || !result ? null : selected;
  const chart = useMemo(() => {
    if (!capture) return null;
    const { series } = capture.result;
    return projectPlanChart({ ...modelChartData(series), devices: series.devices,
      range: { from: 0, to: series.start.length }, timeZone: capture.input.timeZone });
  }, [capture]);

  return <Card data-testid="roi-baseline"><CardHeader><CardTitle>{t('Standardmodell · 72 timmar', 'Default model · 72 hours')}</CardTitle></CardHeader>
    <CardContent className="space-y-5" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" className="min-h-11" onClick={() => move(-1)} disabled={!end} data-testid="baseline-previous" aria-label={t('Föregående period', 'Previous period')}>
          <ChevronLeft className="mr-1 h-4 w-4" />{t('Föregående', 'Previous')}<span className="hidden sm:inline">{t(' period', ' period')}</span>
        </Button>
        <Button variant="outline" className="min-h-11" onClick={() => move(1)} disabled={!end || end === latestEnd} data-testid="baseline-next" aria-label={t('Nästa period', 'Next period')}>
          {t('Nästa', 'Next')}<span className="hidden sm:inline">{t(' period', ' period')}</span><ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        <p className="text-sm" data-testid="baseline-frame" aria-live="polite">{end
          ? `${stamp(frameStart(end))} – ${stamp(end)}`
          : t('Senaste 72 timmarna', 'Latest 72 hours')}</p>
      </div>
      {!homeId && <p className="text-sm text-muted-foreground">{t('Välj ett hem för att generera modellen.', 'Select a home to generate the model.')}</p>}
      {error && <Alert variant="destructive"><AlertTitle>{t('Modellen kunde inte genereras', 'Could not generate the model')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!capture && !busy && homeId && <p className="text-sm text-muted-foreground">{t('Generera modellen för vald period.', 'Generate the model for this period.')}</p>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t('Genererar…', 'Generating…')}</p>}
      {capture && input && result && p && chart && <>
        <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-3" data-testid="baseline-costs">
          <div><p className="text-sm text-muted-foreground">{t('Köp av el', 'Electricity imports')}</p><p className="text-xl font-semibold">{amount(result.ledger.importCostSek)} SEK</p><p className="text-xs text-muted-foreground">{amount(result.ledger.importKwh)} kWh</p></div>
          <div><p className="text-sm text-muted-foreground">{t('Såld el', 'Export revenue')}</p><p className="text-xl font-semibold">{amount(result.ledger.exportRevenueSek)} SEK</p><p className="text-xs text-muted-foreground">{amount(result.ledger.exportKwh)} kWh</p></div>
          <div><p className="text-sm text-muted-foreground">{t('Modellerad elkostnad', 'Modelled electricity cost')}</p><p className="text-xl font-semibold" data-testid="baseline-net-cost">{amount(result.ledger.costSek)} SEK</p></div>
        </div>
        <EnergyChart rows={chart.rows} series={chart.consumption.series}
          baseValues={chart.consumption.baseValues} consumptionIssues={chart.consumption.issues}
          timeZone={input.timeZone} dividerIndex={0} dividerLabel={t('STANDARDMODELL', 'DEFAULT MODEL')}
          hasBattery={p.battery !== null} hasEvBattery={p.car !== null} realPrices={chart.realPrices}
          poolTargetC={p.pool_stop_c} selectedIndex={selected ?? -1} onQuarterClick={setSelected}
          costLines={[{ key: 'default', name: t('Standardmodell', 'Default model'), colour: 'var(--plan-load-2)',
            values: chart.rows.map(row => row.cumulativeCostSek) }]}
          scoreDetail={quarter === null ? null : <div data-testid="baseline-quarter" className="text-sm">
            {stamp(result.series.start[quarter])} · {t('Elkostnad', 'Electricity cost')}: {amount(result.series.costSek[quarter])} SEK
            {p.car && <> · {t('Körbehov', 'Driving demand')}: {amount(input.evDemandKwh[quarter])} kWh</>}
          </div>} />
        <BaselineModelDetails capture={capture} />
      </>}
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" onClick={generate} disabled={busy || !homeId} data-testid="baseline-generate">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('Generera modell', 'Generate model')}
        </Button>
        {capture && <Button variant="outline" className="min-h-11" onClick={() => downloadJson(`default-model-${capture.input.start.slice(0, 10)}.json`, capture)}>{t('Exportera modell', 'Export model')}</Button>}
      </div>
    </CardContent>
  </Card>;
}
