import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, CartesianGrid, ComposedChart, ErrorBar, Line, ReferenceLine, Scatter, XAxis, YAxis } from 'recharts';
import { X } from 'lucide-react';
import { ChartContainer } from '@/components/ui/chart';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { roomRunPoints, trendCooldown, trendRun, type RoomRunDisposition, type RoomRunPoint } from '@/lib/energy-shift/room-run-points';
import { fitTrend, trendAt, trendZero, type Trend } from '@/lib/energy-shift/room-run-trend';
import { MIN_ROOM_HEATING_RUNS } from '../../../../supabase/functions/_shared/planner/models/room/run-evidence';

const ACCENT = 'hsl(var(--primary))';
const MUTED = 'hsl(var(--muted-foreground))';
const SUSPECT = '#b47724';
const GRID_STEPS = 60;

type Kind = 'used' | 'credible' | 'noisy' | 'suspect';
const kindOf = (disposition: RoomRunDisposition): Kind => disposition === 'fitted' ? 'used'
  : disposition === 'provisional' ? 'credible' : disposition === 'suspect_change' ? 'suspect' : 'noisy';

interface Dot { id: string; x: number; y: number; err?: [number, number]; kind: Kind; label: string }

function Marker({ cx, cy, dot, selected, onSelect }: {
  cx?: number; cy?: number; dot: Dot; selected: boolean; onSelect: (id: string) => void;
}) {
  if (cx === undefined || cy === undefined) return null;
  const colour = dot.kind === 'suspect' ? SUSPECT : dot.kind === 'noisy' ? MUTED : ACCENT;
  const fill = dot.kind === 'used' ? ACCENT : dot.kind === 'credible' ? 'hsl(var(--primary) / 0.35)' : 'hsl(var(--background))';
  const select = () => onSelect(dot.id);
  return <g role="button" tabIndex={0} aria-label={dot.label} aria-pressed={selected} className="cursor-pointer outline-none"
    data-run={dot.id} onClick={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } }}>
    <title>{dot.label}</title>
    <circle cx={cx} cy={cy} r={12} fill="transparent" />
    {selected && <circle cx={cx} cy={cy} r={9} fill="none" stroke="hsl(var(--foreground))" strokeWidth={2} />}
    {dot.kind === 'suspect'
      ? <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} transform={`rotate(45 ${cx} ${cy})`} fill={fill} stroke={colour} strokeWidth={1.8} />
      : <circle cx={cx} cy={cy} r={5} fill={fill} stroke={colour} strokeWidth={1.8} />}
  </g>;
}

function niceDomain(values: number[], step: number, floor?: number): [number, number] {
  const low = Math.min(...values), high = Math.max(...values);
  const lo = Math.floor(low / step) * step, hi = Math.ceil(high / step) * step;
  return [floor !== undefined ? Math.min(floor, lo) : lo, hi === lo ? hi + step : hi];
}

function RunScatter({ label, unit, dots, trend, xDomain, yDomain, selected, onSelect, zeroLine }: {
  label: string; unit: string; dots: Dot[]; trend: Trend | null; xDomain: [number, number]; yDomain: [number, number];
  selected: string | null; onSelect: (id: string) => void; zeroLine?: boolean;
}) {
  const { language } = useLanguage();
  const format = (value: number) => value.toLocaleString(language, { maximumFractionDigits: 2 });
  const grid = trend ? Array.from({ length: GRID_STEPS + 1 }, (_, i) => {
    const x = xDomain[0] + (xDomain[1] - xDomain[0]) * i / GRID_STEPS;
    const { y, se } = trendAt(trend, x);
    const inside = x >= trend.minX - 1e-9 && x <= trend.maxX + 1e-9;
    return { x, band: inside ? [y - 1.96 * se, y + 1.96 * se] : null, fit: inside ? y : null, beyond: inside ? null : y };
  }) : [];
  // Join the dashed extrapolation to the solid observed segment.
  for (let i = 1; i < grid.length; i++) {
    if (grid[i].fit !== null && grid[i - 1].fit === null) grid[i - 1].beyond = trendAt(trend!, grid[i - 1].x).y;
    if (grid[i].fit === null && grid[i - 1].fit !== null) grid[i - 1].beyond = grid[i - 1].fit;
  }
  return <ChartContainer className="h-72 w-full min-w-0" config={{}} role="img" aria-label={label}>
    <ComposedChart margin={{ top: 10, right: 16, left: 0, bottom: 18 }}>
      <CartesianGrid className="stroke-border" />
      <XAxis dataKey="x" type="number" domain={xDomain} allowDataOverflow tickCount={8}
        tickFormatter={value => `${format(value)}°`}
        label={{ value: language === 'sv' ? 'Ute (°C)' : 'Outdoors (°C)', position: 'insideBottom', offset: -10, fontSize: 12 }} />
      <YAxis type="number" width={48} domain={yDomain} allowDataOverflow tickFormatter={value => format(value)}
        label={{ value: unit, angle: -90, position: 'insideLeft', offset: 12, fontSize: 12 }} />
      {zeroLine && <ReferenceLine y={0} stroke={MUTED} />}
      {trend && <Area data={grid} dataKey="band" type="monotone" stroke="none" fill={ACCENT} fillOpacity={0.1} isAnimationActive={false} />}
      {trend && <Line data={grid} dataKey="fit" type="monotone" stroke={ACCENT} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />}
      {trend && <Line data={grid} dataKey="beyond" type="monotone" stroke={ACCENT} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls={false} />}
      <Scatter data={dots} dataKey="y" isAnimationActive={false}
        shape={(props: { cx?: number; cy?: number; payload?: Dot }) => props.payload
          ? <Marker cx={props.cx} cy={props.cy} dot={props.payload} selected={props.payload.id === selected} onSelect={onSelect} />
          : <g />}>
        <ErrorBar dataKey="err" direction="y" width={0} stroke={MUTED} strokeWidth={1.2} />
      </Scatter>
    </ComposedChart>
  </ChartContainer>;
}

function Key() {
  const { t } = useLanguage();
  const items: [Kind, string][] = [
    ['used', t('I publicerad anpassning', 'In the published fit')],
    ['credible', t('Trovärdigt förlopp', 'Credible run')],
    ['noisy', t('För brusigt att bedöma', 'Too noisy to judge')],
    ['suspect', t('Annan värme ändrades under förloppet', 'Other heat changed during the run')],
  ];
  return <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    {items.map(([kind, label]) => <li key={kind} className="flex items-center gap-1.5">
      <svg width="12" height="12" aria-hidden="true">{kind === 'suspect'
        ? <rect x="2.5" y="2.5" width="7" height="7" transform="rotate(45 6 6)" fill="none" stroke={SUSPECT} strokeWidth="1.6" />
        : <circle cx="6" cy="6" r="4.2" stroke={kind === 'noisy' ? MUTED : ACCENT} strokeWidth="1.6"
          fill={kind === 'used' ? ACCENT : kind === 'credible' ? 'hsl(var(--primary) / 0.35)' : 'none'} />}</svg>
      {label}
    </li>)}
    <li className="flex items-center gap-1.5"><svg width="18" height="12" aria-hidden="true">
      <line x1="0" y1="6" x2="18" y2="6" stroke={ACCENT} strokeWidth="2.5" /></svg>{t('Trend med 95 % band', 'Trend with 95% band')}</li>
    <li className="flex items-center gap-1.5"><svg width="18" height="12" aria-hidden="true">
      <line x1="0" y1="6" x2="18" y2="6" stroke={ACCENT} strokeWidth="1.5" strokeDasharray="5 4" /></svg>{t('Utanför uppmätta förlopp', 'Beyond measured runs')}</li>
  </ul>;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
    <dt className="text-muted-foreground">{term}</dt><dd className="text-right font-medium tabular-nums">{children}</dd>
  </div>;
}

function RunDetail({ point, onClose }: { point: RoomRunPoint; onClose: () => void }) {
  const { language, t } = useLanguage();
  const format = (value: number, digits = 1) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const temp = (value: number | null) => value === null ? '—' : `${format(value)} °C`;
  const date = (ms: number) => new Date(ms).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = (ms: number) => new Date(ms).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(point.fromMs).toDateString() === new Date(point.toMs).toDateString();
  const status: Record<RoomRunDisposition, string> = {
    fitted: t('Ingår i den publicerade anpassningen: det överensstämmer med minst två andra nya förlopp.',
      'Part of the published fit: it agrees with at least two other recent runs.'),
    provisional: t('Trovärdigt, men inte i gruppen av förlopp som stämmer överens med varandra.',
      'Credible, but not in the group of runs that agree with each other.'),
    older_response: t('Trovärdigt, men äldre än responsen som nu används.', 'Credible, but older than the response now in use.'),
    uninformative: t('Värmen var för liten eller för kort jämfört med mätbruset för att bedöma rummets respons.',
      'Too little or too brief heating against the measurement noise to judge the room’s response.'),
    suspect_change: t('Värme från en annan källa verkar ha ändrats under förloppet, så det används inte.',
      'Heat from another source appears to have changed during the run, so it is not used.'),
  };
  const hold = point.cooldown && point.gain && point.gain > 0 && point.cooldown.c_per_h > 0 ? point.cooldown.c_per_h / point.gain : null;
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
      <Row term={t('Avsvalning', 'Cool-down')}>{point.cooldown
        ? `${format(point.cooldown.c_per_h, 2)} °C/h · ${format(point.cooldown.hours)} h ${t('vid', 'at')} ${temp(point.cooldown.room_c)}`
        : t('För kort för att mäta', 'Too short to measure')}</Row>
      {hold !== null && <Row term={t('Effekt som skulle stoppa avsvalningen', 'Power that would stop the cool-down')}>{format(hold, 2)} kW</Row>}
      <Row term={t('Anpassade övergångar', 'Fitted transitions')}>{point.transitions.toLocaleString(language)}</Row>
      <Row term={t('Bedömt mot', 'Assessed against')}>{point.scope === 'general' ? t('Allmän respons', 'General response')
        : `${format(Number(point.scope))} – ${format(Number(point.scope) + 5)} °C`}</Row>
    </dl>
  </section>;
}

export default function RoomRunCharts({ homeId, roomId }: { homeId: string; roomId: string }) {
  const { language, t } = useLanguage();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['room-run-evidence', homeId, roomId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_energy_room_run_evidence', { p_home_id: homeId, p_room_key: roomId });
      if (error) throw error;
      return data;
    },
  });
  const format = (value: number, digits = 1) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const view = useMemo(() => {
    const { points } = roomRunPoints(query.data);
    const date = (ms: number) => new Date(ms).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' });
    const heating = points.filter(p => p.outdoorC !== null && p.gain !== null);
    const cooling = points.filter(p => p.cooldown !== null);
    const heatingFit = heating.filter(trendRun);
    const coolingFit = cooling.filter(trendCooldown);
    const heaterTrend = heatingFit.length >= MIN_ROOM_HEATING_RUNS
      ? fitTrend(heatingFit.map(p => ({ x: p.outdoorC!, y: p.gain!, se: p.gainSe })), 'response') : null;
    const coolingTrend = coolingFit.length >= MIN_ROOM_HEATING_RUNS
      ? fitTrend(coolingFit.map(p => ({ x: p.cooldown!.outdoor_c, y: p.cooldown!.c_per_h })), 'cooling') : null;
    const xs = [...heating.map(p => p.outdoorC!), ...cooling.map(p => p.cooldown!.outdoor_c)];
    const xDomain: [number, number] = xs.length ? niceDomain(xs, 5) : [-15, 15];
    if (xDomain[1] - xDomain[0] < 15) xDomain[1] = xDomain[0] + 15;
    // Scale to the credible runs; very noisy estimates are drawn at the edge.
    const scaleFrom = heatingFit.length ? heatingFit : heating;
    const heaterTop = scaleFrom.length ? Math.max(...scaleFrom.map(p => p.gain! + Math.min(p.gainSe ?? 0, p.gain!))) * 1.15 : 1;
    const yHeat: [number, number] = [0, Math.max(niceDomain([heaterTop], 1)[1], 1)];
    const coolRates = cooling.map(p => p.cooldown!.c_per_h);
    const yCool: [number, number] = coolRates.length ? niceDomain([...coolRates, 0], 0.1) : [0, 1];
    const clamp = (value: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, value));
    const heaterDots: Dot[] = heating.map(p => {
      const y = clamp(p.gain!, yHeat), se = p.gainSe ?? 0;
      return { id: p.id, x: p.outdoorC!, y, kind: kindOf(p.disposition),
        err: [y - clamp(p.gain! - se, yHeat), clamp(p.gain! + se, yHeat) - y],
        label: `${date(p.fromMs)} · ${format(p.outdoorC!)} °C · ${format(p.gain!, 2)} ± ${format(se, 2)} °C/kWh` };
    });
    const coolingDots: Dot[] = cooling.map(p => ({ id: p.id, x: p.cooldown!.outdoor_c, y: clamp(p.cooldown!.c_per_h, yCool),
      kind: p.disposition === 'suspect_change' ? 'suspect' : 'credible',
      label: `${date(p.fromMs)} · ${format(p.cooldown!.outdoor_c)} °C · ${format(p.cooldown!.c_per_h, 2)} °C/h` }));
    const offScale = heating.filter(p => p.gain! < yHeat[0] || p.gain! > yHeat[1]).length;
    return { points, heating, cooling, heaterTrend, coolingTrend, xDomain, yHeat, yCool, heaterDots, coolingDots, offScale,
      unplaced: points.filter(p => p.outdoorC === null).length };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- format derives from language
  }, [query.data, language]);
  const point = view.points.find(p => p.id === selected) ?? null;
  const select = (id: string) => setSelected(current => current === id ? null : id);
  const heaterTitle = t('Värmerespons per förlopp', 'Heating response per run');
  const coolingTitle = t('Avsvalning per förlopp', 'Cool-down per run');
  const balance = view.coolingTrend ? trendZero(view.coolingTrend, view.coolingTrend.minX, view.coolingTrend.maxX + 3) : null;
  const holdTemps = view.heaterTrend && view.coolingTrend ? [-20, -15, -10, -5, 0, 5, 10, 15].filter(c =>
    c >= view.coolingTrend!.minX - 1 && c <= view.coolingTrend!.maxX + 1) : [];
  const hold = holdTemps.flatMap(c => {
    const gain = trendAt(view.heaterTrend!, c).y, cool = trendAt(view.coolingTrend!, c).y;
    return gain > 0 && cool > 0 ? [{ c, kw: cool / gain }] : [];
  });
  const shape = (trend: Trend | null) => !trend ? null : trend.degree === 0 ? t('platt', 'flat')
    : trend.degree === 1 ? t('rak', 'straight') : t('brantare i kyla', 'steeper in the cold');

  if (query.isPending) return <p role="status" className="text-muted-foreground">{t('Laddar förlopp…', 'Loading runs…')}</p>;
  if (query.isError) return <p role="alert" className="text-muted-foreground">{t('Förloppen kunde inte läsas.', 'The runs could not be loaded.')}</p>;
  if (!view.points.length) return <p role="status" className="text-muted-foreground">{t(
    'Inga uppvärmningsförlopp har bedömts för rummet ännu.', 'No heating runs have been assessed for this room yet.')}</p>;

  return <section className="space-y-3" aria-label={t('Uppvärmningsförlopp efter utetemperatur', 'Heating runs by outdoor temperature')}>
    <h4 className="font-semibold">{t('Uppvärmningsförlopp efter utetemperatur', 'Heating runs by outdoor temperature')}</h4>
    <p className="text-xs text-muted-foreground">{t(
      'Varje punkt är ett uppmätt förlopp där värmaren slogs på och sedan av. Välj en punkt för detaljer.',
      'Each point is one measured run where the heater switched on and then off. Select a point for details.',
    )}</p>
    {view.heating.length === 0 && <p role="status" className="text-xs text-muted-foreground">{t(
      `${view.unplaced} förlopp saknar utetemperatur. De placeras efter nästa modelluppdatering.`,
      `${view.unplaced} runs have no outdoor temperature yet. They are placed after the next model update.`,
    )}</p>}
    <div className="grid gap-5">
      <section className="min-w-0 space-y-1">
        <h5 className="font-medium">{heaterTitle}</h5>
        <p className="text-xs text-muted-foreground">{t(
          'Temperaturökning per tillförd kWh, med värmeförluster räknade separat. Den beror på rummets värmekapacitet och inte på utetemperaturen, så linjen är platt.',
          'Temperature rise per kWh delivered, with heat losses counted separately. It depends on the room’s heat capacity, not the outdoor temperature, so the line is flat.',
        )}</p>
        <RunScatter label={heaterTitle} unit="°C/kWh" dots={view.heaterDots} trend={view.heaterTrend}
          xDomain={view.xDomain} yDomain={view.yHeat} selected={selected} onSelect={select} />
        <p className="text-xs tabular-nums" aria-live="polite">{view.heaterTrend ? t(
          `Trend: ${shape(view.heaterTrend)} · ${format(trendAt(view.heaterTrend, 0).y, 2)} °C/kWh · ${view.heaterTrend.n} förlopp`,
          `Trend: ${shape(view.heaterTrend)} · ${format(trendAt(view.heaterTrend, 0).y, 2)} °C/kWh · ${view.heaterTrend.n} runs`,
        ) + (view.heaterTrend.excessScatter !== undefined && view.heaterTrend.excessScatter >= 2 ? ` · ${t(
          `förloppen spretar ${format(view.heaterTrend.excessScatter)} gånger mer än sin egen osäkerhet`,
          `runs scatter ${format(view.heaterTrend.excessScatter)}× more than their own uncertainty`)}` : '')
          : t(`Minst ${MIN_ROOM_HEATING_RUNS} trovärdiga förlopp behövs för en trend.`, `At least ${MIN_ROOM_HEATING_RUNS} credible runs are needed for a trend.`)}
          {view.offScale > 0 && ` · ${view.offScale} ${t('utanför skalan', 'off scale')}`}</p>
      </section>
      <section className="min-w-0 space-y-1">
        <h5 className="font-medium">{coolingTitle}</h5>
        <p className="text-xs text-muted-foreground">{t(
          'Hur snabbt rummet svalnar under de första timmarna efter att värmaren stängts av och dess eftervärme har avtagit. Fysiken förväntar sig en linje som faller när det blir varmare ute och aldrig stiger.',
          'How fast the room cools in the first hours after the heater stops and its stored heat has passed. Physics expects a line that falls as it gets warmer outside and never rises.',
        )}</p>
        {view.cooling.length ? <>
          <RunScatter label={coolingTitle} unit="°C/h" dots={view.coolingDots} trend={view.coolingTrend} zeroLine
            xDomain={view.xDomain} yDomain={view.yCool} selected={selected} onSelect={select} />
          <p className="text-xs tabular-nums" aria-live="polite">{view.coolingTrend
            ? `${t('Trend', 'Trend')}: ${shape(view.coolingTrend)} · ${view.coolingTrend.n} ${t('förlopp', 'runs')}` +
              (view.coolingTrend.constrained ? ` · ${t('förloppen visar ännu inget beroende av utetemperaturen', 'the runs show no dependence on outdoor temperature yet')}` : '') +
              (balance !== null ? ` · ${t('svalnar inte utan värme över', 'stops cooling unheated above')} ${format(balance)} °C` : '')
            : t(`Minst ${MIN_ROOM_HEATING_RUNS} avsvalningar behövs för en trend.`, `At least ${MIN_ROOM_HEATING_RUNS} cool-downs are needed for a trend.`)}</p>
        </> : <p role="status" className="text-xs text-muted-foreground">{t(
          'Inga avsvalningar har mätts ännu. De registreras från nästa modelluppdatering.',
          'No cool-downs have been measured yet. They are recorded from the next model update.',
        )}</p>}
      </section>
    </div>
    <Key />
    {point && <RunDetail point={point} onClose={() => setSelected(null)} />}
    {hold.length > 0 && <section className="space-y-1">
      <h5 className="font-medium">{t('Effekt som håller rummets temperatur (uppskattning)', 'Power that holds the room temperature (estimate)')}</h5>
      <p className="text-xs text-muted-foreground">{t('Avsvalningstrenden delad med värmeresponstrenden.', 'The cool-down trend divided by the heating response trend.')}</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">{hold.map(({ c, kw }) => <div key={c} className="flex gap-1.5">
        <dt className="text-muted-foreground">{format(c)} °C</dt><dd className="font-medium">{format(kw, 2)} kW</dd>
      </div>)}</dl>
    </section>}
  </section>;
}
