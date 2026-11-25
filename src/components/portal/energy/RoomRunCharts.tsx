import { useMemo, useState, type ReactNode } from 'react';
import { CartesianGrid, ComposedChart, ErrorBar, Line, ReferenceLine, Scatter, XAxis, YAxis } from 'recharts';
import { X } from 'lucide-react';
import { ChartContainer } from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useLanguage } from '@/contexts/LanguageContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { trendCooldown, trendRun, type RoomRunDisposition, type RoomRunPoint } from '@/lib/energy-shift/room-run-points';
import { roomResponseLines, type RoomResponseLines, type RoomResponseView } from '@/lib/energy-shift/room-response-view';
import { measuredPointStatus, measuredRoomLineAt, type MeasuredPointStatus, type MeasuredRoomAssessment, type MeasuredRoomCalibration, type MeasuredRoomLine } from '../../../../supabase/functions/_shared/planner/models/room/measured-evidence';
import { isEquilibrium } from '../../../../supabase/functions/_shared/planner/models/room/thermal';

const ACCENT = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';
const SUSPECT = 'hsl(var(--foreground))';
const GRID_STEPS = 60;

type Kind = 'used' | 'credible' | 'noisy' | 'suspect';
const kindOf = (disposition: RoomRunDisposition): Kind => (disposition === 'fitted' || disposition === 'assessed') ? 'used'
  : disposition === 'provisional' ? 'credible' : disposition === 'suspect_change' ? 'suspect' : 'noisy';

interface Dot { id: string; x: number; y: number; err?: [number, number]; kind: Kind; label: string }
interface ModelLine { at: (x: number) => number; measuredRange: { minX: number; maxX: number } | null }

function Marker({ cx, cy, dot, selected, onSelect, anchored = false }: {
  cx?: number; cy?: number; dot: Dot; selected: boolean; onSelect: (id: string) => void; anchored?: boolean;
}) {
  if (cx === undefined || cy === undefined) return null;
  const colour = dot.kind === 'suspect' ? SUSPECT : dot.kind === 'noisy' ? MUTED : ACCENT;
  const fill = dot.kind === 'used' ? ACCENT : dot.kind === 'credible' ? 'hsl(var(--primary) / 0.35)' : 'hsl(var(--background))';
  const select = () => onSelect(dot.id);
  return <g role="button" tabIndex={0} aria-label={dot.label} aria-pressed={selected} className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    data-run={dot.id} onClick={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } }}>
    <title>{dot.label}</title>
    <circle cx={cx} cy={cy} r={12} fill="transparent" />
    {selected && (anchored
      ? <PopoverAnchor asChild><circle cx={cx} cy={cy} r={9} fill="none" stroke="hsl(var(--foreground))" strokeWidth={2} /></PopoverAnchor>
      : <circle cx={cx} cy={cy} r={9} fill="none" stroke="hsl(var(--foreground))" strokeWidth={2} />)}
    {dot.kind === 'suspect'
      ? <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} transform={`rotate(45 ${cx} ${cy})`} fill={fill} stroke={colour} strokeWidth={1.8} />
      : <circle cx={cx} cy={cy} r={5} fill={fill} stroke={colour} strokeWidth={1.8} />}
  </g>;
}

function niceDomain(values: number[], step: number): [number, number] {
  const low = Math.min(...values), high = Math.max(...values);
  const lo = Math.floor(low / step) * step, hi = Math.ceil(high / step) * step;
  return [lo, hi === lo ? hi + step : hi];
}

/** Runs as points; the published model's response as a line, solid over the
 * measured runs and dashed beyond them. */
function RunScatter({ label, unit, dots, line, xDomain, yDomain, selected, onSelect, zeroLine, detail }: {
  label: string; unit: string; dots: Dot[]; line: ModelLine | null; xDomain: [number, number]; yDomain: [number, number];
  selected: string | null; onSelect: (id: string) => void; zeroLine?: boolean;
  /** When given, the selected point opens its own details beside it. */
  detail?: { label: string; render: (id: string) => ReactNode; onClose: () => void };
}) {
  const { language } = useLanguage();
  const format = (value: number) => value.toLocaleString(language, { maximumFractionDigits: 2 });
  const grid = line ? Array.from({ length: GRID_STEPS + 1 }, (_, i) => {
    const x = xDomain[0] + (xDomain[1] - xDomain[0]) * i / GRID_STEPS;
    const range = line.measuredRange;
    const inside = range && x >= range.minX - 1e-9 && x <= range.maxX + 1e-9;
    return { x, fit: inside ? line.at(x) : null, beyond: inside ? null : line.at(x) };
  }) : [];
  // Join the dashed segments to the solid measured segment.
  for (let i = 1; i < grid.length; i++) {
    if (grid[i].fit !== null && grid[i - 1].fit === null) grid[i - 1].beyond = line!.at(grid[i - 1].x);
    if (grid[i].fit === null && grid[i - 1].fit !== null) grid[i - 1].beyond = grid[i - 1].fit;
  }
  const open = !!detail && selected !== null && dots.some(dot => dot.id === selected);
  // A narrow chart has no room beside a point; below it, the details can shift to fit the screen.
  const narrow = useIsMobile();
  const chart = <ChartContainer className="h-72 w-full min-w-0" config={{}} role="img" aria-label={label}>
    <ComposedChart margin={{ top: 10, right: 16, left: 0, bottom: 18 }}>
      <CartesianGrid className="stroke-border" />
      <XAxis dataKey="x" type="number" domain={xDomain} allowDataOverflow tickCount={8}
        tickFormatter={value => `${format(value)}°`}
        label={{ value: language === 'sv' ? 'Ute (°C)' : 'Outdoors (°C)', position: 'insideBottom', offset: -10, fontSize: 12 }} />
      <YAxis type="number" width={48} domain={yDomain} allowDataOverflow tickFormatter={value => format(value)}
        label={{ value: unit, angle: -90, position: 'insideLeft', offset: 12, fontSize: 12 }} />
      {zeroLine && <ReferenceLine y={0} stroke={MUTED} />}
      {line && <Line data={grid} dataKey="fit" type="linear" stroke={ACCENT} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />}
      {line && <Line data={grid} dataKey="beyond" type="linear" stroke={ACCENT} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls={false} />}
      <Scatter data={dots} dataKey="y" isAnimationActive={false}
        shape={(props: { cx?: number; cy?: number; payload?: Dot }) => props.payload
          ? <Marker cx={props.cx} cy={props.cy} dot={props.payload} selected={props.payload.id === selected} onSelect={onSelect} anchored={open} />
          : <g />}>
        <ErrorBar dataKey="err" direction="y" width={0} stroke={MUTED} strokeWidth={1.2} />
      </Scatter>
    </ComposedChart>
  </ChartContainer>;
  if (!detail) return chart;
  return <Popover open={open} onOpenChange={next => { if (!next) detail.onClose(); }}>
    {chart}
    {open && <PopoverContent side={narrow ? 'bottom' : 'right'} align="center" collisionPadding={8} aria-label={detail.label}
      className="w-80 max-w-[calc(100vw-1rem)] p-3 text-xs" data-testid="room-point-detail">{detail.render(selected!)}</PopoverContent>}
  </Popover>;
}

function Key({ lines, chronological, measured = false }: { lines: boolean; chronological: boolean; measured?: boolean }) {
  const { t } = useLanguage();
  const items: [Kind, string][] = [
    ['used', measured ? t('Nära linjen i sitt diagram', 'Close to its chart’s line') : chronological ? t('Bedömt mot modellen', 'Assessed against the model') : t('I publicerad anpassning', 'In the published fit')],
    ['noisy', t('För brusigt att bedöma', 'Too noisy to judge')],
    ['suspect', measured ? t('Flaggad: långt från linjen i sitt diagram', 'Flagged: far from its chart’s line') : t('Avvikande förlopp', 'Flagged run')],
  ];
  if (measured) items.splice(1, 1);
  if (!chronological) items.splice(1, 0, ['credible', t('Trovärdigt förlopp', 'Credible run')]);
  return <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {items.map(([kind, label]) => <li key={kind} className="flex items-center gap-1.5">
      <svg width="12" height="12" aria-hidden="true">{kind === 'suspect'
        ? <rect x="2.5" y="2.5" width="7" height="7" transform="rotate(45 6 6)" fill="none" stroke={SUSPECT} strokeWidth="1.6" />
        : <circle cx="6" cy="6" r="4.2" stroke={kind === 'noisy' ? MUTED : ACCENT} strokeWidth="1.6"
          fill={kind === 'used' ? ACCENT : kind === 'credible' ? 'hsl(var(--primary) / 0.35)' : 'none'} />}</svg>
      {label}
    </li>)}
    {lines && <>
      <li className="flex items-center gap-1.5"><svg width="18" height="12" aria-hidden="true">
        <line x1="0" y1="6" x2="18" y2="6" stroke={ACCENT} strokeWidth="2.5" /></svg>{measured ? t('Publicerad anpassning', 'Published fit') : t('Rummets modell', 'Room model')}</li>
      <li className="flex items-center gap-1.5"><svg width="18" height="12" aria-hidden="true">
        <line x1="0" y1="6" x2="18" y2="6" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="5 4" /></svg>{t('Utanför visade förlopp', 'Beyond the runs shown')}</li>
    </>}
  </ul>;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
    <dt className="text-muted-foreground">{term}</dt><dd className="text-right font-medium tabular-nums">{children}</dd>
  </div>;
}

function RunDetail({ point, lines, shared, onClose }: {
  point: RoomRunPoint; lines: RoomResponseLines | null; shared: boolean; onClose: () => void;
}) {
  const { language, t } = useLanguage();
  const format = (value: number, digits = 1) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const temp = (value: number | null) => value === null ? '—' : `${format(value)} °C`;
  const date = (ms: number) => new Date(ms).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = (ms: number) => new Date(ms).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(point.fromMs).toDateString() === new Date(point.toMs).toDateString();
  const status: Record<RoomRunDisposition, string> = {
    assessed: t('Förloppets uppmätta värmerespons har jämförts med rummets publicerade modell.',
      'The run’s measured heating response was assessed against the published room model.'),
    fitted: t('Ingår i den tidigare publicerade anpassningen.', 'Included in the earlier published fit.'),
    provisional: t('Trovärdigt, men inte i gruppen av förlopp som stämmer överens med varandra.',
      'Credible, but not in the group of runs that agree with each other.'),
    older_response: t('Trovärdigt, men äldre än responsen som nu används.', 'Credible, but older than the response now in use.'),
    uninformative: t('Värmen var för liten eller för kort jämfört med mätbruset för att bedöma rummets respons.',
      'Too little or too brief heating against the measurement noise to judge the room’s response.'),
    suspect_change: t('Förloppet avviker från den tidigare publicerade responsen. Orsaken är inte fastställd.',
      'The run differs from the earlier published response. The cause has not been established.'),
  };
  const standardized = lines?.cooling.pointY(point) ?? null;
  return <section aria-label={t('Valt förlopp', 'Selected run')} data-testid="room-run-detail"
    className="min-w-0 space-y-2 rounded-md border bg-muted/20 p-3 text-xs">
    <div className="flex items-start justify-between gap-2">
      <div>
        <h5 className="text-sm font-semibold">{date(point.fromMs)}</h5>
        <p className="text-muted-foreground tabular-nums">{time(point.fromMs)} – {sameDay ? time(point.toMs) : `${date(point.toMs)} ${time(point.toMs)}`}</p>
      </div>
      <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={onClose} aria-label={t('Stäng', 'Close')}><X className="h-4 w-4" /></Button>
    </div>
    <p>{status[point.disposition]}</p>
    {point.change && <p className="text-muted-foreground">{t('Ändring', 'Change')} {point.change.size > 0 ? '+' : ''}{format(point.change.size, 2)} °C/h {t('kl.', 'at')} {time(point.change.atMs)}
      {' · '}{point.change.phase === 'heating' ? t('under uppvärmning', 'while heating') : t('under avsvalning', 'while cooling')}</p>}
    <dl>
      {point.onMs !== null && point.offMs !== null && <Row term={t('Värmaren på', 'Heater on')}>{time(point.onMs)} – {time(point.offMs)}</Row>}
      <Row term={t('Tillförd energi', 'Energy delivered')}>{format(point.energyKwh, 2)} kWh</Row>
      <Row term={t('Ute (medel)', 'Outdoors (mean)')}>{temp(point.outdoorC)}</Row>
      <Row term={t('Övriga hemmet (medel)', 'Rest of home (mean)')}>{temp(point.houseC)}</Row>
      <Row term={t('Rummet start → topp → slut', 'Room start → peak → end')}>{temp(point.roomStartC)} → {temp(point.roomPeakC)} → {temp(point.roomEndC)}</Row>
      <Row term={t('Värmerespons', 'Heating response')}>{point.gain === null ? t('Kunde inte skattas', 'Could not be estimated')
        : `${format(point.gain, 2)} ± ${format(point.gainSe ?? 0, 2)} °C/kWh`}</Row>
      <Row term={t('Uppmätt avsvalning', 'Measured cool-down')}>{point.cooldown
        ? `${format(point.cooldown.c_per_h, 2)} °C/h · ${format(point.cooldown.hours)} h ${t('vid', 'at')} ${temp(point.cooldown.room_c)}`
        : t('För kort för att mäta', 'Too short to measure')}</Row>
      {standardized !== null && lines && <Row term={t(`Avsvalning vid ${format(lines.cooling.reference.roomC)} °C`,
        `Cool-down at ${format(lines.cooling.reference.roomC)} °C`)}>{format(standardized, 2)} °C/h</Row>}
      <Row term={t('Övergångar i förloppet', 'Transitions in this run')}>{point.transitions.toLocaleString(language)}</Row>
      <Row term={t('Bedömt mot', 'Assessed against')}>{shared ? t('Rummets gemensamma modell', 'The shared room model')
        : point.scope === 'general' ? t('Tidigare allmän respons', 'Previous general response')
        : `${t('Tidigare intervall', 'Previous band')} ${format(Number(point.scope))} – ${format(Number(point.scope) + 5)} °C`}</Row>
    </dl>
  </section>;
}

function ModelSummary({ view }: { view: RoomResponseView }) {
  const { language, t } = useLanguage();
  const response = view.response!;
  const model = response.model;
  const format = (value: number, digits = 2) => value.toLocaleString(language, { maximumFractionDigits: digits });
  return <dl className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 p-3 sm:grid-cols-4" data-testid="room-model-summary">
    <div><dt>{t('Modellens värmarparameter', 'Model heater parameter')}{model.gain_reference_outdoor_c != null && ` · ${format(model.gain_reference_outdoor_c)} °C ${t('ute', 'outdoors')}`}</dt><dd className="font-medium">{isEquilibrium(model)
      ? `${format(model.heater_c_per_w * 1000)} °C/kW` : `${format(model.gain_c_per_wh * 1000)} °C/kWh`}</dd></div>
    {model.gain_outdoor_slope_per_c != null && <div><dt>{t('Värmarresponsens relativa väderlutning', 'Relative weather slope of heater response')}</dt><dd className="font-medium">{format(model.gain_outdoor_slope_per_c, 4)} /°C</dd></div>}
    {!isEquilibrium(model) && model.heat_loss_w_per_c !== null && <div><dt>{t('Värmeförlust', 'Heat loss')}</dt>
      <dd className="font-medium">{format(model.heat_loss_w_per_c, 0)} W/°C</dd></div>}
    <div><dt>{t('Termisk tidskonstant', 'Thermal time constant')}</dt><dd className="font-medium">{isEquilibrium(model)
      ? t('Ingen dynamisk tidskonstant', 'No dynamic time constant') : model.response_family === 'integrator'
      ? t('Obegränsad i modellen', 'Unbounded in this model') : model.time_constant_h === null ? '—' : `${format(model.time_constant_h, 1)} h`}</dd></div>
    <div><dt>{t('Värmefördröjning', 'Heater lag')}</dt><dd className="font-medium">{format(model.heat_lag_h ?? 0)} h</dd></div>
    {response.fittedTransitions !== null && <div><dt>{t('Anpassade övergångar', 'Fitted transitions')}</dt>
      <dd className="font-medium" data-testid="fitted-transitions">{format(response.fittedTransitions, 0)}</dd></div>}
    {view.observedRuns !== null && <div><dt>{t('Bedömda uppvärmningsförlopp', 'Assessed heating runs')}</dt>
      <dd className="font-medium" data-testid="assessed-heating-runs">{format(view.observedRuns, 0)}</dd></div>}
    {response.fittedTransitions === null && response.fittedRuns !== null && <div>
      <dt>{t('Anpassade uppvärmningsförlopp', 'Fitted heating runs')}</dt>
      <dd className="font-medium" data-testid="fitted-heating-runs">{format(response.fittedRuns, 0)}</dd></div>}
    {response.trainingFrom && response.trainingTo && <div className="col-span-2"><dt>{t('Träningsdata', 'Training data')}</dt>
      <dd className="font-medium">{response.trainingFrom.slice(0, 10)} – {response.trainingTo.slice(0, 10)}</dd></div>}
  </dl>;
}

function LegacyRoomRunCharts({ view }: { view: RoomResponseView }) {
  const { language, t } = useLanguage();
  const [selected, setSelected] = useState<string | null>(null);
  const format = (value: number, digits = 1) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const lines = useMemo(() => roomResponseLines(view), [view]);
  const shared = view.assessed === 'shared';
  const chronological = view.response?.fittedTransitions != null;
  const chart = useMemo(() => {
    const { points } = view;
    const date = (ms: number) => new Date(ms).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' });
    const fmt = (value: number, digits = 1) => value.toLocaleString(language, { maximumFractionDigits: digits });
    const heating = points.filter(p => p.outdoorC !== null && p.gain !== null);
    // A shared ledger plots cool-downs moved to the model's reference conditions;
    // a legacy ledger plots them as measured, without a line.
    const coolingY = (p: RoomRunPoint) => lines ? lines.cooling.pointY(p) : p.cooldown?.c_per_h ?? null;
    const cooling = points.filter(p => p.cooldown && coolingY(p) !== null);
    const xs = [...heating.map(p => p.outdoorC!), ...cooling.map(p => p.cooldown!.outdoor_c)];
    const xDomain: [number, number] = xs.length ? niceDomain(xs, 5) : [-15, 15];
    if (xDomain[1] - xDomain[0] < 15) xDomain[1] = xDomain[0] + 15;
    const scaleFrom = heating.filter(trendRun).length ? heating.filter(trendRun) : heating;
    const heaterTop = Math.max(lines?.heater.cPerKwh ?? 0,
      ...scaleFrom.map(p => p.gain! + Math.min(p.gainSe ?? 0, p.gain!))) * 1.15;
    const yHeat: [number, number] = [0, Math.max(niceDomain([heaterTop || 1], 1)[1], 1)];
    const coolValues = cooling.map(p => coolingY(p)!);
    const lineValues = lines ? [lines.cooling.at(xDomain[0]), lines.cooling.at(xDomain[1])] : [];
    const yCool: [number, number] = (coolValues.length || lineValues.length) ? niceDomain([...coolValues, ...lineValues, 0], 0.1) : [0, 1];
    const clamp = (value: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, value));
    const heaterDots: Dot[] = heating.map(p => {
      const y = clamp(p.gain!, yHeat), se = p.gainSe ?? 0;
      return { id: p.id, x: p.outdoorC!, y, kind: kindOf(p.disposition),
        err: [y - clamp(p.gain! - se, yHeat), clamp(p.gain! + se, yHeat) - y],
        label: `${date(p.fromMs)} · ${fmt(p.outdoorC!)} °C · ${fmt(p.gain!, 2)} ± ${fmt(se, 2)} °C/kWh` };
    });
    const coolingDots: Dot[] = cooling.map(p => ({ id: p.id, x: p.cooldown!.outdoor_c, y: clamp(coolingY(p)!, yCool),
      kind: trendCooldown(p) ? kindOf(p.disposition) : 'suspect',
      label: `${date(p.fromMs)} · ${fmt(p.cooldown!.outdoor_c)} °C · ${fmt(coolingY(p)!, 2)} °C/h` }));
    const range = (values: number[]) => values.length ? { minX: Math.min(...values), maxX: Math.max(...values) } : null;
    const heatRange = range(heating.map(p => p.outdoorC!)), coolRange = range(cooling.map(p => p.cooldown!.outdoor_c));
    return { heating, cooling, xDomain, yHeat, yCool, heaterDots, coolingDots, heatRange, coolRange,
      offScale: heating.filter(p => p.gain! < yHeat[0] || p.gain! > yHeat[1]).length,
      unplaced: points.filter(p => p.outdoorC === null).length };
  }, [view, lines, language]);
  const point = view.points.find(p => p.id === selected) ?? null;
  const select = (id: string) => setSelected(current => current === id ? null : id);
  const heaterTitle = t('Värmerespons per förlopp', 'Heating response per run');
  const coolingTitle = t('Avsvalning per förlopp', 'Cool-down per run');
  const heaterLine: ModelLine | null = lines ? { at: () => lines.heater.cPerKwh, measuredRange: chart.heatRange } : null;
  const coolingLine: ModelLine | null = lines ? { at: lines.cooling.at, measuredRange: chart.coolRange } : null;
  const balance = lines?.cooling.balanceC ?? null;
  const hold = lines && chart.coolRange ? [-20, -15, -10, -5, 0, 5, 10, 15]
    .filter(c => c >= chart.coolRange!.minX - 1 && c <= chart.coolRange!.maxX + 1)
    .flatMap(c => { const kw = lines.holdKw(c); return kw === null ? [] : [{ c, kw }]; }) : [];

  return <section className="space-y-3" aria-label={t('Uppvärmningsförlopp efter utetemperatur', 'Heating runs by outdoor temperature')}>
    {view.response && <>
      <ModelSummary view={view} />
      <p className="text-xs text-muted-foreground">{t(
        'Planeraren använder den här enda responsen vid varje prognostiserad utetemperatur.',
        'The planner uses this one response at every forecast outdoor temperature.',
      )}</p>
    </>}
    <h4 className="font-semibold">{t('Uppvärmningsförlopp efter utetemperatur', 'Heating runs by outdoor temperature')}</h4>
    <p className="text-xs text-muted-foreground">{t(
      'Varje punkt är ett uppmätt förlopp där värmaren slogs på och sedan av. Välj en punkt för detaljer.',
      'Each point is one measured run where the heater switched on and then off. Select a point for details.',
    )}</p>
    {chronological && <p className="text-xs text-muted-foreground">{t(
      'Modellen anpassas till alla användbara intervallövergångar. Avslutade uppvärmningsförlopp bedöms sedan mot den publicerade modellen.',
      'The model uses all eligible interval transitions. Each completed heating run is then assessed against the published model.',
    )}</p>}
    {chronological && view.observedRuns === null && <p role="status" className="text-xs text-muted-foreground">{t(
      'Bedömningar för den publicerade modellen är inte tillgängliga.', 'Run assessments for the published model are unavailable.',
    )}</p>}
    {!shared && !chronological && <p role="status" className="text-xs text-muted-foreground">{t(
      'Rummets gemensamma modell lärs fortfarande in. Punkterna är bedömda mot tidigare temperaturintervall och visas utan linje.',
      'The shared room model is still being learned. These points were assessed against earlier temperature bands and are shown without a line.',
    )}</p>}
    {chart.heating.length === 0 && chart.unplaced > 0 && <p role="status" className="text-xs text-muted-foreground">{t(
      `${chart.unplaced} förlopp saknar utetemperatur. De placeras efter nästa modelluppdatering.`,
      `${chart.unplaced} runs have no outdoor temperature yet. They are placed after the next model update.`,
    )}</p>}
    <div className="grid gap-5">
      <section className="min-w-0 space-y-1">
        <h5 className="font-medium">{heaterTitle}</h5>
        <p className="text-xs text-muted-foreground">{t(
          'Temperaturökning per kWh som värmaren tillför. Modellen beräknar värmeförlusterna separat och använder samma värmerespons vid alla utetemperaturer.',
          'Temperature rise per kWh delivered by the heater. The model calculates heat losses separately and uses the same heating response at every outdoor temperature.',
        )}</p>
        <RunScatter label={heaterTitle} unit="°C/kWh" dots={chart.heaterDots} line={heaterLine}
          xDomain={chart.xDomain} yDomain={chart.yHeat} selected={selected} onSelect={select} />
        {lines && <p className="text-xs tabular-nums" aria-live="polite">
          {t('Modell', 'Model')}: {format(lines.heater.cPerKwh, 2)} °C/kWh
          {lines.heater.excessScatter !== null && lines.heater.excessScatter >= 2 && ` · ${t(
            `förloppen spretar ${format(lines.heater.excessScatter)} gånger mer än sin egen osäkerhet`,
            `runs scatter ${format(lines.heater.excessScatter)}× more than their own uncertainty`)}`}
          {chart.offScale > 0 && ` · ${chart.offScale} ${t('utanför skalan', 'off scale')}`}</p>}
      </section>
      <section className="min-w-0 space-y-1">
        <h5 className="font-medium">{coolingTitle}</h5>
        <p className="text-xs text-muted-foreground">{lines ? t(
          `Linjen visar hur snabbt rummet svalnar med värmaren avstängd och utan solinstrålning, vid ${format(lines.cooling.reference.roomC)} °C inne och ${format(lines.cooling.reference.houseC)} °C i övriga hemmet. Varje förlopp är flyttat till samma förhållanden med modellen.`,
          `The line shows how fast the room cools with the heater off and no sunlight, at ${format(lines.cooling.reference.roomC)} °C indoors and ${format(lines.cooling.reference.houseC)} °C in the rest of the home. Each run is moved to the same conditions with the model.`,
        ) : t(
          'Hur snabbt rummet svalnar under de första timmarna efter att värmaren stängts av och dess eftervärme har avtagit.',
          'How fast the room cools in the first hours after the heater stops and its stored heat has passed.',
        )}</p>
        {chart.cooling.length > 0 || lines ? <>
          <RunScatter label={coolingTitle} unit="°C/h" dots={chart.coolingDots} line={coolingLine} zeroLine
            xDomain={chart.xDomain} yDomain={chart.yCool} selected={selected} onSelect={select} />
          {lines && balance !== null && Number.isFinite(balance) && <p className="text-xs tabular-nums" aria-live="polite">
            {t('Svalnar inte utan värme över', 'Stops cooling unheated above')} {format(balance)} °C</p>}
        </> : <p role="status" className="text-xs text-muted-foreground">{t(
          'Inga avsvalningar har mätts ännu.', 'No cool-downs have been measured yet.')}</p>}
      </section>
    </div>
    <Key lines={!!lines} chronological={chronological} />
    <RunPicker runs={view.points.map(run => ({ id: run.id, fromMs: run.fromMs }))} selected={point?.id ?? null} onSelect={setSelected} />
    {point && <RunDetail point={point} lines={lines} shared={shared} onClose={() => setSelected(null)} />}
    {hold.length > 0 && <section className="space-y-1">
      <h5 className="font-medium">{t('Effekt som håller rummets temperatur (uppskattning)', 'Power that holds the room temperature (estimate)')}</h5>
      <p className="text-xs text-muted-foreground">{t(
        'Den publicerade modellens avsvalningshastighet delad med värmarens temperaturökning per kWh.',
        'The published model’s cooling rate divided by the heater’s temperature rise per kWh.')}
        {chronological && ' ' + t('Prognosen räknar inte med framtida värmetillskott från omätta källor.',
          'The forecast assumes no future heat gains from unmetered sources.')}</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">{hold.map(({ c, kw }) => <div key={c} className="flex gap-1.5">
        <dt className="text-muted-foreground">{format(c)} °C</dt><dd className="font-medium">{format(kw, 2)} kW</dd>
      </div>)}</dl>
    </section>}
  </section>;
}

function RunPicker({ runs, selected, onSelect }: {
  runs: { id: string; fromMs: number }[]; selected: string | null; onSelect: (id: string | null) => void;
}) {
  const { language, t } = useLanguage();
  if (!runs.length) return null;
  return <label className="flex flex-wrap items-center gap-2 text-xs">{t('Visa detaljer för ett förlopp', 'Inspect a heating run')}
    <select className="min-h-11 max-w-full rounded-md border bg-background px-2" value={selected ?? ''}
      onChange={event => onSelect(event.target.value || null)}>
      <option value="">{t('Välj förlopp', 'Select run')}</option>
      {runs.map(run => <option key={run.id} value={run.id}>{new Date(run.fromMs).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}</option>)}
    </select>
  </label>;
}

/** One measure's status against the line drawn in its own chart. Earlier
 * ledgers stored no per-measure status; the published line decides it. */
function measuredStatus(stored: MeasuredPointStatus | null, line: MeasuredRoomLine | null, x: number, y: number): MeasuredPointStatus | null {
  return stored ?? (line ? measuredPointStatus(line, x, y) : null);
}

function PointDetail({ title, status, onClose, notes, children }: {
  title: string; status: string; onClose: () => void; notes: string[]; children: ReactNode;
}) {
  const { t } = useLanguage();
  return <div className="space-y-1">
    <div className="flex items-start justify-between gap-2"><div>
      <p className="font-semibold">{title}</p><p>{status}</p>
    </div><Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-11 w-11 shrink-0" onClick={onClose} aria-label={t('Stäng', 'Close')}><X className="h-4 w-4" /></Button></div>
    <dl>{children}</dl>
    {notes.length > 0 && <p>{t('Mätanmärkningar', 'Measurement notes')}: {notes.join(' · ')}</p>}
  </div>;
}

/** One chart's point: only that measure's facts, status and distance from its own line. */
function MeasuredPointDetail({ kind, run, line, onClose }: {
  kind: 'heating' | 'cooling'; run: MeasuredRoomAssessment; line: MeasuredRoomLine | null; onClose: () => void;
}) {
  const { language, t } = useLanguage();
  const value = (n: number | null | undefined, unit: string) => n == null ? '—' : `${n.toLocaleString(language, { maximumFractionDigits: 2 })} ${unit}`;
  const time = (ms: number) => new Date(ms).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  const statusLabel = (status: MeasuredPointStatus | null) => ({
    consistent: t('Nära linjen', 'Close to the line'),
    above_line: t('Flaggad: över linjen', 'Flagged: above the line'),
    below_line: t('Flaggad: under linjen', 'Flagged: below the line'),
  })[status ?? 'consistent'];
  // Notes about the other measure do not describe this point.
  const notes = run.reasons.filter(code => code !== 'descriptive_line_residual' &&
    !code.startsWith(kind === 'heating' ? 'cooling_' : 'heating_') && code !== (kind === 'heating' ? 'missing_cooling' : ''))
    .map(code => measuredReason(code, t));
  if (kind === 'heating' && run.heating) {
    const h = run.heating;
    const status = measuredStatus(run.heating_status, line, h.outdoor_c, h.c_per_kwh);
    return <PointDetail title={t(`Uppvärmning ${time(h.on_ms)}`, `Heating ${time(h.on_ms)}`)} status={statusLabel(status)} onClose={onClose} notes={notes}>
      <Row term={t('Uppmätt nettoökning', 'Measured net rise')}>{value(h.c_per_kwh, '°C/kWh')}</Row>
      <Row term={t('Avstånd från linjen', 'Distance from line')}>{value(line ? h.c_per_kwh - measuredRoomLineAt(line, h.outdoor_c) : null, '°C/kWh')}</Row>
      <Row term={t('Värmaren på → av', 'Heater on → off')}>{time(run.on_ms)} → {time(run.off_ms)}</Row>
      <Row term={t('Start → topp (intervallmedel)', 'Onset → peak (interval means)')}>{value(h.room_start_c, '°C')} → {value(h.room_peak_c, '°C')}</Row>
      <Row term={t('Toppens mätintervall', 'Peak measurement interval')}>{time(h.peak_ms)} – {time(h.peak_end_ms)}</Row>
      <Row term={t('Energi från start till topp', 'Energy from onset to peak')}>{value(h.energy_kwh, 'kWh')}</Row>
      <Row term={t('Ute', 'Outdoors')}>{value(h.outdoor_c, '°C')}</Row>
      <Row term={t('Rum / övriga hemmet', 'Room / rest of home')}>{value(h.room_mean_c, '°C')} / {value(h.house_c, '°C')}</Row>
      <Row term={t('Justerad till referenstemperatur', 'Adjusted to reference temperature')}>{value(run.reference_heating_c_per_kwh, '°C/kWh')}</Row>
    </PointDetail>;
  }
  if (kind === 'cooling' && run.cooling) {
    const c = run.cooling;
    const status = measuredStatus(run.cooling_status, line, c.outdoor_c, c.c_per_h);
    return <PointDetail title={t(`Avsvalning ${time(c.from_ms)}`, `Cooling ${time(c.from_ms)}`)} status={statusLabel(status)} onClose={onClose} notes={notes}>
      <Row term={t('Uppmätt avsvalning, värmaren av', 'Measured cooling, heater off')}>{value(c.c_per_h, '°C/h')}</Row>
      <Row term={t('Avstånd från linjen', 'Distance from line')}>{value(line ? c.c_per_h - measuredRoomLineAt(line, c.outdoor_c) : null, '°C/h')}</Row>
      <Row term={t('Värmaren av', 'Heater off')}>{time(run.off_ms)}</Row>
      <Row term={t('Mätintervall', 'Measurement interval')}>{time(c.from_ms)} – {time(c.to_ms)}</Row>
      <Row term={t('Ute', 'Outdoors')}>{value(c.outdoor_c, '°C')}</Row>
      <Row term={t('Rum / övriga hemmet', 'Room / rest of home')}>{value(c.room_c, '°C')} / {value(c.house_c, '°C')}</Row>
      <Row term={t('Justerad till referenstemperatur', 'Adjusted to reference temperature')}>{value(run.reference_cooling_c_per_h, '°C/h')}</Row>
    </PointDetail>;
  }
  return null;
}

function measuredReason(code: string, t: (sv: string, en: string) => string): string {
  const reasons: Record<string, [string, string]> = {
    heating_window_incomplete: ['Uppvärmningen saknar fullständiga start-, temperatur- eller energimätningar', 'Heating is missing complete onset, temperature or energy measurements'],
    cooling_window_incomplete: ['Avsvalningen saknar ett tillräckligt uppmätt intervall med värmaren av', 'Cooling lacks a sufficiently measured heater-off interval'],
    descriptive_line_residual: ['Avvikande avstånd från den publicerade linjen', 'Flagged distance from the published line'],
    missing_onset: ['Startmätning saknas', 'Onset measurement is missing'],
    missing_peak: ['Toppmätning saknas', 'Peak measurement is missing'],
    missing_energy: ['Energimätning saknas', 'Energy measurement is missing'],
    missing_outdoor: ['Utetemperatur saknas', 'Outdoor temperature is missing'],
    missing_house: ['Temperatur i övriga hemmet saknas', 'Rest-of-home temperature is missing'],
    missing_cooling: ['Mätbar avsvalning saknas', 'Measurable cooling is missing'],
    nonpositive_energy: ['Ingen positiv uppmätt värmeenergi', 'No positive measured heating energy'],
    incomplete_run: ['Förloppet är inte avslutat', 'The run is not complete'],
  };
  const message = reasons[code];
  return message ? t(...message) : t(`Sparad mätanmärkning: ${code}`, `Stored measurement note: ${code}`);
}

function MeasuredRoomRunCharts({ view }: { view: RoomResponseView }) {
  const { language, t } = useLanguage();
  const calibration = view.response!.measuredRuns!;
  // A point is selected in one chart; the other chart's point for the same run stays closed.
  const [selected, setSelected] = useState<{ kind: 'heating' | 'cooling'; id: string } | null>(null);
  const format = (value: number, digits = 2) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const byId = useMemo(() => new Map(view.measuredPoints.map(run => [run.id, run])), [view.measuredPoints]);
  const descriptions = {
    heating: t('Uppmätt nettoökning per kWh från värmepåslag till topp. Start och topp är intervallmedelvärden som närmar sig förloppets ändpunkter.',
      'Measured net rise per kWh from heater onset to peak. Onset and peak are interval-mean proxies for the run’s endpoints.'),
    cooling: t('Uppmätt temperaturfall per timme med värmaren av. Positivt värde betyder att rummet svalnar; negativt att det värms.',
      'Measured temperature fall per hour with the heater off. A positive value means cooling; a negative value means warming.'),
  };
  const charts = (['heating', 'cooling'] as const).map(kind => {
    const line: MeasuredRoomLine | null = calibration.lines[kind];
    const unit = kind === 'heating' ? '°C/kWh' : '°C/h';
    const title = kind === 'heating' ? t('Nettoökning per förlopp', 'Net rise per run') : t('Avsvalning per förlopp', 'Cooling per run');
    // Each chart judges only its own measure, against the line it draws.
    const dots = view.measuredPoints.flatMap(run => {
      const fact = run[kind];
      const y = kind === 'heating' ? run.heating?.c_per_kwh : run.cooling?.c_per_h;
      if (!fact || y == null) return [];
      const status = measuredStatus(kind === 'heating' ? run.heating_status : run.cooling_status, line, fact.outdoor_c, y);
      const state: Kind = status === 'above_line' || status === 'below_line' ? 'suspect' : 'used';
      return [{ id: run.id, x: fact.outdoor_c, y, kind: state,
        label: `${new Date(run.from_ms).toLocaleDateString(language)} · ${format(fact.outdoor_c)} °C · ${format(y)} ${unit}` }];
    });
    const flagged = dots.filter(dot => dot.kind === 'suspect').length;
    const counts = { kept: dots.length - flagged, flagged, missing: view.measuredPoints.length - dots.length };
    const xDomain = dots.length ? niceDomain(dots.map(dot => dot.x), 5) : [-15, 15] as [number, number];
    const lineValues = line ? xDomain.map(x => measuredRoomLineAt(line, x)) : [];
    const yDomain = niceDomain([0, ...dots.map(dot => dot.y), ...lineValues], kind === 'heating' ? .5 : .1);
    const fitted: ModelLine | null = line ? { at: x => measuredRoomLineAt(line, x), measuredRange: dots.length
      ? { minX: Math.min(...dots.map(dot => dot.x)), maxX: Math.max(...dots.map(dot => dot.x)) } : null } : null;
    return { kind, unit, title, dots, xDomain, yDomain, fitted, line, counts };
  });
  const missingReasons = new Map<string, number>();
  for (const run of view.measuredPoints) for (const reason of new Set(run.reasons)) missingReasons.set(reason, (missingReasons.get(reason) ?? 0) + 1);
  return <section className="space-y-4" aria-label={t('Uppmätta förlopp efter utetemperatur', 'Measured runs by outdoor temperature')}>
    <div className="space-y-2">
      <h4 className="font-semibold">{t('Uppmätta förlopp efter utetemperatur', 'Measured runs by outdoor temperature')}</h4>
      <p className="text-xs text-muted-foreground">{t('Punkterna är beräknade från temperatur- och energimätningar vid de förhållanden som rådde under varje förlopp.',
        'Points are calculated from temperature and energy readings at the conditions observed during each run.')}</p>
      <p className="text-xs text-muted-foreground">{t('Uppvärmning och avsvalning bedöms var för sig, mot linjen i sitt eget diagram. Linjerna kommer från den publicerade anpassningen.',
        'Heating and cooling are judged separately, each against the line in its own chart. The lines come from the published fit.')}</p>
      <p className="text-xs tabular-nums" data-testid="measured-run-counts">{format(view.measuredPoints.length, 0)} {t('visade förlopp', 'runs shown')}</p>
      {view.observedRuns === null && <p role="status" className="text-xs text-muted-foreground">{t('Förloppen för denna modellrevision är inte tillgängliga. Linjerna kommer från den publicerade anpassningen.',
        'Runs for this model revision are unavailable. The lines come from the published fit.')}</p>}
    </div>
    {charts.map(chart => <section key={chart.kind} className="min-w-0 space-y-1">
      <h5 className="font-medium">{chart.title}</h5>
      <p className="text-xs text-muted-foreground">{descriptions[chart.kind]}</p>
      {chart.dots.length || chart.line ? <RunScatter label={chart.title} unit={chart.unit} dots={chart.dots} line={chart.fitted}
        xDomain={chart.xDomain} yDomain={chart.yDomain} zeroLine
        selected={selected?.kind === chart.kind ? selected.id : null} onSelect={id => setSelected({ kind: chart.kind, id })}
        detail={{ label: chart.kind === 'heating' ? t('Vald uppvärmningspunkt', 'Selected heating point') : t('Vald avsvalningspunkt', 'Selected cooling point'),
          onClose: () => setSelected(null),
          render: id => { const run = byId.get(id); return run ? <MeasuredPointDetail kind={chart.kind} run={run} line={chart.line} onClose={() => setSelected(null)} /> : null; } }} />
        : <p className="py-3 text-xs text-muted-foreground">{t('Inga mätbara punkter eller publicerad linje är tillgängliga.', 'No measurable points or published line are available.')}</p>}
      <p className="text-xs text-muted-foreground tabular-nums">{chart.line ? t(
        `Publicerad linje: ${format(chart.line.intercept)} ${chart.unit} vid ${format(chart.line.reference_outdoor_c)} °C ute, lutning ${format(chart.line.slope_per_c, 3)} ${chart.unit}/°C. ${format(chart.line.points, 0)} förlopp i anpassningen.`,
        `Published line: ${format(chart.line.intercept)} ${chart.unit} at ${format(chart.line.reference_outdoor_c)} °C outdoors, slope ${format(chart.line.slope_per_c, 3)} ${chart.unit}/°C. ${format(chart.line.points, 0)} runs in the fit.`,
      ) : t('Ingen linje har publicerats för detta mått.', 'No line has been published for this measure.')}</p>
      <p className="text-xs tabular-nums" data-testid={`measured-run-counts-${chart.kind}`}>{format(chart.counts.kept, 0)} {t('nära linjen', 'close to the line')}{' · '}
        {format(chart.counts.flagged, 0)} {t('flaggade', 'flagged')}{' · '}{format(chart.counts.missing, 0)} {chart.kind === 'heating'
          ? t('utan uppvärmningspunkt', 'without a heating point') : t('utan avsvalningspunkt', 'without a cooling point')}</p>
    </section>)}
    <Key lines={charts.some(chart => chart.line !== null)} chronological measured />
    <p className="text-xs text-muted-foreground">{t('En punkt flaggas när den ligger mer än tre robusta spridningar från linjen i sitt diagram. Den finns kvar i anpassningen med lägre vikt, och flaggan fastställer inte orsaken.',
      'A point is flagged when it lies more than three robust spreads from the line in its chart. It stays in the fit with reduced weight, and the flag does not establish the cause.')}
      {' '}{t('Välj en punkt för att se dess mätning.', 'Select a point to see its measurement.')}</p>
    {missingReasons.size > 0 && <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      {t('Mätanmärkningar för visade förlopp', 'Measurement notes for the runs shown')}</summary>
      <ul className="list-disc space-y-1 pl-5">{[...missingReasons].map(([reason, count]) => <li key={reason}>{measuredReason(reason, t)} · {format(count, 0)}</li>)}</ul>
    </details>}
    {(calibration.validation.trajectory_mae_c !== null || calibration.validation.projected_trajectory_mae_c != null) &&
      <section className="space-y-1 text-xs" data-testid="room-prediction-error">
        <h5 className="font-medium">{t('Medelabsolut prognosfel för temperatur', 'Mean absolute temperature prediction error')}</h5>
        <dl>
          {calibration.validation.trajectory_mae_c !== null && <Row term={t('Anpassad respons', 'Fitted response')}>{format(calibration.validation.trajectory_mae_c)} °C</Row>}
          {calibration.validation.projected_trajectory_mae_c != null && <Row term={t('Planerarens prognos', 'Planner forecast')}>{format(calibration.validation.projected_trajectory_mae_c)} °C</Row>}
        </dl>
        <p className="text-muted-foreground">{format(calibration.validation.observations, 0)} {t('valideringsobservationer', 'validation observations')}
          {calibration.validation.projected_trajectory_mae_c != null && ' · ' + t('Planerarens prognos räknar inte med framtida positiva tillskott från omätt värme.',
            'The planner forecast excludes future positive unmetered heat gains.')}</p>
      </section>}
    <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{t('Planerarens modellparametrar', 'Planner model parameters')}</summary>
      <ModelSummary view={view} />
      <p className="mt-2 text-muted-foreground">{t('Planeraren anpassar värmarens respons och värmeutbytet med uteluften och övriga hemmet till temperatur- och energimätningarna genom hela förloppet. Avsvalningen avtar när temperaturskillnaderna minskar. Toppunkterna ovan beskriver förloppen; de bestämmer inte värmarens respons. Om mätningarna inte kan identifiera responsen används den kronologiska anpassningen.',
        'The planner fits heater response and heat exchange with outdoors and the rest of the home to temperature and energy readings throughout each run. Cooling slows as temperature differences shrink. The peak points above describe the runs; they do not determine heater response. Where the readings cannot identify a response, the chronological fit is used.')}</p>
    </details>
  </section>;
}

export default function RoomRunCharts(props: { view: RoomResponseView }) {
  return props.view.response?.measuredRuns ? <MeasuredRoomRunCharts {...props} /> : <LegacyRoomRunCharts {...props} />;
}
