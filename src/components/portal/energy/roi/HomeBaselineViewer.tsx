import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import BenchPlanChart from '@/components/portal/planner-bench/BenchPlanChart';
import { benchDays, type BenchPeriod } from '@/lib/planner-bench/days';
import { generateHomeBaseline, type BaselineCapture } from '@/lib/home-baseline/browser';
import { BaselineGenerationError, frameStart, shiftFrame } from '@/lib/home-baseline/model';
import { formatHomeStamp } from '@/lib/energy-shift/home-time';
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
  const [selected, setSelected] = useState<number | null>(null), [period, setPeriod] = useState<BenchPeriod>('all');
  useEffect(() => () => { request.current?.abort(); }, []);
  const timeZone = capture?.input.timeZone ?? homeTimeZone;
  const stamp = (at: string) => formatHomeStamp(at, timeZone);
  const amount = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const move = (direction: -1 | 1) => {
    if (!end) return;
    request.current?.abort(); request.current = null;
    const next = shiftFrame(end, direction);
    setEnd(next); setCapture(frames.current.get(next) ?? null); setError(null); setBusy(false);
    setSelected(null); setPeriod('all');
  };
  const generate = async () => {
    if (!homeId) return;
    request.current?.abort();
    if (end) frames.current.delete(end);
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null); setCapture(null); setSelected(null); setPeriod('all');
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
  const totalEvDemand = input?.evDemandKwh.reduce((sum, v) => sum + v, 0) ?? 0;

  return <Card data-testid="roi-baseline"><CardHeader><CardTitle>{t('Standardmodell · 72 timmar', 'Default model · 72 hours')}</CardTitle></CardHeader>
    <CardContent className="space-y-5" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{t('Modell för valt hem med uppmätt förbrukning, solproduktion och elpriser. Genereras på begäran och sparas bara i denna vy.', 'Model for the selected home using recorded consumption, solar generation and electricity prices. Generated on demand and kept only in this view.')}</p>
      <p className="text-sm">{t('Batteri: maximal egenförbrukning. Bil: till 80% från lokal midnatt, med körbehov från uppmätta SOC-minskningar. Pool: start 30°C, stopp 30,5°C; cirkulation 60 W, full pump vid uppvärmning.', 'Battery: maximum self consumption. Car: to 80% from local midnight, with driving demand from recorded SOC declines. Pool: start 30°C, stop 30.5°C; circulation 60 W, full pump during heating.')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" className="min-h-11" onClick={() => move(-1)} disabled={!end} data-testid="baseline-previous">
          <ChevronLeft className="mr-1 h-4 w-4" />{t('Föregående 72 h', 'Previous 72 h')}
        </Button>
        <Button variant="outline" className="min-h-11" onClick={() => move(1)} disabled={!end || end === latestEnd} data-testid="baseline-next">
          {t('Nästa 72 h', 'Next 72 h')}<ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        <p className="text-sm" data-testid="baseline-frame" aria-live="polite">{end
          ? `${stamp(frameStart(end))} – ${stamp(end)} · ${timeZone}`
          : t('Senaste avslutade 72-timmarsfönster', 'Latest completed 72-hour frame')}</p>
      </div>
      {!homeId && <p className="text-sm text-muted-foreground">{t('Välj ett hem för att generera modellen.', 'Select a home to generate the model.')}</p>}
      {error && <Alert variant="destructive"><AlertTitle>{t('Modellen kunde inte genereras', 'Could not generate the model')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!capture && !busy && homeId && <p className="text-sm text-muted-foreground">{t('Tryck på Generera för att hämta underlaget för valt fönster.', 'Press Generate to load the inputs for the selected frame.')}</p>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t('Hämtar historik och beräknar standardmodellen…', 'Loading history and calculating the default model…')}</p>}
      {input && result && p && <>
        <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-3" data-testid="baseline-costs">
          <div><p className="text-sm text-muted-foreground">{t('Köp av el', 'Electricity imports')}</p><p className="text-xl font-semibold">{amount(result.ledger.importCostSek)} SEK</p><p className="text-xs text-muted-foreground">{amount(result.ledger.importKwh)} kWh</p></div>
          <div><p className="text-sm text-muted-foreground">{t('Intäkt från såld el', 'Electricity export revenue')}</p><p className="text-xl font-semibold">{amount(result.ledger.exportRevenueSek)} SEK</p><p className="text-xs text-muted-foreground">{amount(result.ledger.exportKwh)} kWh</p></div>
          <div><p className="text-sm text-muted-foreground">{t('Modellerad elkostnad · 72 h', 'Modelled electricity cost · 72 h')}</p><p className="text-xl font-semibold" data-testid="baseline-net-cost">{amount(result.ledger.costSek)} SEK</p><p className="text-xs text-muted-foreground">{t('Rörlig kostnad efter export; utan fasta avgifter och SHS-abonnemang', 'Variable cost after exports; excludes fixed fees and SHS subscription')}</p></div>
        </div>
        <div className="space-y-2 text-sm text-muted-foreground" data-testid="baseline-assumptions">
          <p>{t('Nuvarande utrustningsmodeller, fångade', 'Current equipment models, captured')} {stamp(input.modelCapturedAt)}. {t('Startvärden är historiska kvartmedelvärden från', 'Initial states are historical quarter averages from')} {stamp(input.initialObservedAt)}.</p>
          {p.car && <p>{t('Bilens senaste SOC före fönstret:', 'Last car SOC before the frame:')} {stamp(input.evInitialObservedAt!)}. {t('Uppmätta SOC-minskningar räknas som körbehov; tidigare laddning ignoreras. Laddning från nästa lokala midnatt. Antas kunna kopplas in för nattladdning.', 'Recorded SOC declines count as driving demand; previous charging is ignored. Charging starts at the next local midnight. Assumed available for overnight charging.')}</p>}
          {p.car && input.evMissingSocQuarters > 0 && <p>{t('Kvartar utan SOC:', 'Quarters without SOC:')} {input.evMissingSocQuarters}. {t('Minskningar över luckor räknas när nästa SOC observeras. Körning som döljs av samtidig laddning kan inte återskapas.', 'Declines across gaps are counted when the next SOC is observed. Driving hidden by simultaneous charging cannot be reconstructed.')}</p>}
          {p.pool_store && <p>{t('Värmepumpen startar med okänt avstängt tillstånd; historisk startfas finns inte lagrad.', 'The heat pump starts in an unobserved off state; its historical startup phase is not stored.')}</p>}
          <p>{t('Det här visar modellens kostnader. Schemaläggarbesparing och årlig återbetalning kräver en separat jämförelse.', 'This shows model costs. Scheduler savings and annual payback require a separate comparison.')}</p>
        </div>
        <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{t('Modeller och indata', 'Models and inputs')}</summary>
          <div className="mt-4 space-y-3 text-sm" data-testid="baseline-models">
            {p.battery && <p><strong>{t('Batteri', 'Battery')}:</strong> {p.battery.capacity_kwh} kWh · {p.battery.min_soc * 100}–{p.battery.max_soc * 100}% SOC · {p.battery.charge_max_w} / {p.battery.discharge_max_w} W · {t('laddnings-/urladdningsverkningsgrad', 'charge/discharge efficiency')} {p.battery.charge_efficiency * 100}% / {p.battery.discharge_efficiency * 100}%.</p>}
            {p.car && p.charger && <><p><strong>{input.carName}:</strong> {p.car.capacity_kwh} kWh · {p.charger.max_current_a} A · {p.charger.phase_count} × {p.charger.voltage_v} V · {t('laddningsverkningsgrad', 'charge efficiency')} {p.car.charge_efficiency * 100}%. {t('Körbehov i fönstret:', 'Driving demand in frame:')} {amount(totalEvDemand)} kWh.</p>
              <table className="w-full text-left"><caption className="sr-only">{t('Dagligt körbehov', 'Daily driving demand')}</caption><thead><tr><th>{t('Lokal dag', 'Local day')}</th><th>{t('SOC-minskningar (kWh)', 'SOC declines (kWh)')}</th></tr></thead><tbody>{input.evDailyDemand.map(day => <tr key={day.day}><td>{day.day}</td><td>{amount(day.kwh)}</td></tr>)}</tbody></table></>}
            {p.pool_store && p.heater && <><p><strong>Pool:</strong> {p.pool_store.capacity_kwh_per_c} kWh/°C · {t('kompressor', 'compressor')} {p.heater.compressor_w} W · {t('värme', 'heat')} {p.heater.heat_w} W · {t('full pump', 'full pump')} {p.heater.auxiliary_w + input.idlePumpW} W · {t('startrespons', 'startup response')}: {p.heater.response.kind}.</p>
              <p>{t('Värmeförlust', 'Heat loss')}: {p.pool_store.loss.kind === 'linear'
                ? `${p.pool_store.loss.kw_per_c} kW/°C · ${p.pool_store.loss.surroundings_c === null ? t('uppmätt utomhustemperatur', 'recorded outdoor temperature') : `${p.pool_store.loss.surroundings_c}°C`}`
                : p.pool_store.loss.points.map(point => `${point.at_c}°C: ${point.c_per_h}°C/h`).join(' · ')}.</p></>}
            <p>{t('Nätgräns import/export', 'Grid import/export limits')}: {p.limits.import_w} / {p.limits.export_w} W. {t('Inbyggd fysikberäkning:', 'Native physics calculation:')} {Math.round(result.projectionMs)} ms.</p>
          </div>
        </details>
        <BenchPlanChart series={result.series} compared={{ current: null, test: result.series }}
          names={{ current: '', test: t('Standardmodell', 'Default model') }} timeZone={input.timeZone}
          audit={null} selected={selected} onSelect={setSelected} days={benchDays(result.series.start, input.timeZone)}
          period={period} onPeriod={setPeriod} showAudit={false} idPrefix="home-baseline"
          dividerLabel={t('STANDARDMODELL →', 'DEFAULT MODEL →')} poolTargetC={p.pool_stop_c}
          scoreDetail={quarter === null ? null : <div data-testid="baseline-quarter" className="text-sm">
            {stamp(result.series.start[quarter])} · {t('Elkostnad', 'Electricity cost')}: {amount(result.series.costSek[quarter])} SEK
            {p.car && <> · {t('Körbehov', 'Driving demand')}: {amount(input.evDemandKwh[quarter])} kWh</>}
          </div>} />
      </>}
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" onClick={generate} disabled={busy || !homeId} data-testid="baseline-generate">
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('Generera standardmodell · 72 h', 'Generate default model · 72 h')}
        </Button>
        {capture && <Button variant="outline" className="min-h-11" onClick={() => downloadJson(`default-model-${capture.input.start.slice(0, 10)}.json`, capture)}>{t('Exportera modell', 'Export model')}</Button>}
      </div>
    </CardContent>
  </Card>;
}
