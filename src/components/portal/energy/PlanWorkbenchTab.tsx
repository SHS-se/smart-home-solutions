// Build a plan by hand, and let the planner's own objective judge it.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.12 asks whether the operating
// heuristics emerge from the objective rather than from rules. When a shipped
// plan contradicts one, the finding is ambiguous in a way that matters: either
// the search failed to find the best schedule the objective allows, or the
// objective prefers the wrong schedule. Those need opposite fixes — a different
// solver versus a different utility curve — and nothing in a plan distinguishes
// them, because the planner's own schedule is the only one ever priced.
//
// This prices a second one. The household edits the auction's schedule, the
// edit is expanded back into quarters, and `scoreDispatch` — the same function
// `planDispatch` selects on — scores both. A hand-built plan that scores better
// is proof the search left money on the table. One that scores worse while
// still reading better to the household is a curve that needs correcting. The
// answer is a number either way, which is the point.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  dispatchWorkbench,
  type DispatchWorkbench,
  type OptimisationPlan,
  type OptimisationSnapshot,
} from '../../../../supabase/functions/_shared/energy-optimisation';
import type { DispatchInfeasibility } from '../../../../supabase/functions/_shared/dispatch-plan';
import {
  buildWorkbenchChart,
  buildWorkbenchExport,
  buildWorkbenchModel,
  curvesBeyondReach,
  gridWattsAt,
  compareWorkbench,
  executableKw,
  scheduleFromDraft,
  type Granularity,
  type WorkbenchComparison,
  type WorkbenchDraft,
  type WorkbenchModel,
  type SlotRange,
  exportFreeCeilingKw,
  storeLabel,
  storeValueSeries,
  type WorkbenchRow,
} from '@/lib/energy-shift/plan-workbench';
import PlanPanels from './plan/PlanPanels';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import {
  formatHomeDayMonth,
  formatHomeDayMonthTime,
  formatHomeTime,
} from '@/lib/energy-shift/home-time';

interface Props {
  homeId: string | null;
}

const signed = (value: number, digits: number, unit: string): string => {
  const rounded = Number(value.toFixed(digits));
  const body = `${Math.abs(rounded).toFixed(digits)} ${unit}`;
  if (rounded === 0) return body;
  return `${rounded > 0 ? '+' : '−'}${body}`;
};

/** The state units the planner works in, said the way a household reads them. */
const stateLabel = (unit: string, value: number): string => {
  if (unit === 'km') return `${Math.round(value)} km`;
  if (unit === 'celsius') return `${value.toFixed(1)} °C`;
  if (unit === 'kwh') return `${value.toFixed(1)} kWh`;
  return `${value.toFixed(1)} ${unit}`;
};


/**
 * Broken rules, each a link to the quarter it happens in.
 *
 * "slot 58" is a number nobody holds. A reader fixes a plan by looking at 10:30
 * in the schedule, so the quarter is printed as a time and clicking it takes
 * them there — the same gesture the chart offers.
 */
const Issues: React.FC<{
  title: string;
  entries: DispatchInfeasibility[];
  tone: 'destructive' | 'default';
  more: string;
  footer?: string;
  timeOf: (slot: number) => string;
  onGo: (slot: number) => void;
}> = ({ title, entries, tone, more, footer, timeOf, onGo }) => (
  <Alert variant={tone === 'destructive' ? 'destructive' : undefined}>
    <AlertTriangle className="h-4 w-4" />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription>
      <ul className="text-xs space-y-0.5">
        {entries.slice(0, 8).map(entry => (
          <li key={`${entry.slot}|${entry.message}`}>
            <button
              type="button"
              onClick={() => onGo(entry.slot)}
              className="underline underline-offset-2 font-medium tabular-nums hover:opacity-70"
            >
              {timeOf(entry.slot)}
            </button>
            {` · ${entry.message}`}
          </li>
        ))}
        {entries.length > 8 && <li>{more} ({entries.length})</li>}
      </ul>
      {footer && <p className="text-[11px] mt-2 opacity-80">{footer}</p>}
    </AlertDescription>
  </Alert>
);

const PlanWorkbenchTab: React.FC<Props> = ({ homeId }) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bench, setBench] = useState<DispatchWorkbench | null>(null);
  /** Whether the curves in play came from settings or from the snapshot. */
  const [curveSource, setCurveSource] = useState<'settings' | 'snapshot'>('snapshot');
  // Quarters by default: that is the planner's own resolution, so the editor
  // opens showing exactly what it chose, with the two scores identical and
  // nothing flagged. Anything coarser is already an edit.
  const [granularity, setGranularity] = useState<Granularity>('quarter');
  const [draft, setDraft] = useState<WorkbenchDraft>({});
  /** Quarters the household has opened to selling from store, by column. */
  const [allowExport, setAllowExport] = useState<boolean[]>([]);
  // `'all'` is the whole horizon; a number indexes `days`. Focusing on one day
  // narrows the chart and the table together — they are two views of the same
  // quarters, and letting them disagree about which quarters is how a reader
  // ends up editing one afternoon while looking at another.
  const [day, setDay] = useState<number | 'all'>(0);
  /** Absolute quarter index the reader has pointed at, from either view. */
  const [selected, setSelected] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const headerCells = useRef(new Map<number, HTMLTableCellElement>());

  const model: WorkbenchModel | null = useMemo(
    () => (bench ? buildWorkbenchModel(bench, granularity) : null),
    [bench, granularity],
  );

  /**
   * Every column, including the ones the day tabs are not showing.
   *
   * A plan is scored over the whole 72 hours or it is not comparable, so the
   * draft is horizon-wide and the day selector only ever narrows what is drawn.
   */
  const values = useCallback(
    (rowId: string): number[] => draft[rowId] ?? model?.planned[rowId] ?? [],
    [draft, model],
  );

  // Days are cut on the home's own clock, not the reader's: a plan for a house
  // in Stockholm read from a laptop in another zone must still break at that
  // house's midnight.
  const days = useMemo(() => {
    if (!model || !bench) {
      return [] as { label: string; columns: number[]; range: SlotRange }[];
    }
    const grouped = new Map<string, number[]>();
    model.columns.forEach((column, index) => {
      const key = formatHomeDayMonth(column.startMs, homeTimeZone);
      grouped.set(key, [...(grouped.get(key) ?? []), index]);
    });
    return [...grouped.entries()].map(([label, columns]) => {
      const slots = columns.flatMap(index => model.columns[index].slots);
      return {
        label,
        columns,
        range: { from: Math.min(...slots), to: Math.max(...slots) + 1 },
      };
    });
  }, [model, bench, homeTimeZone]);

  // Memoised so the chart's own memo can depend on the range itself: a fresh
  // object every render would rebuild 288 quarters on every keystroke.
  const view: SlotRange = useMemo(
    () => (day === 'all' || !days[day]
      ? { from: 0, to: bench?.slots.length ?? 0 }
      : days[day].range),
    [day, days, bench],
  );
  const shown = day === 'all'
    ? (model?.columns ?? []).map((_column, index) => index)
    : days[day]?.columns ?? [];

  /** Which editable column holds the pointed-at quarter, if any. */
  const selectedColumn = useMemo(() => {
    if (selected === null || !model) return -1;
    return model.columns.findIndex(column => column.slots.includes(selected));
  }, [selected, model]);

  // Bring the pointed-at column into view rather than leaving the reader to
  // hunt for it: a day is 96 columns at quarter resolution, most of them off
  // screen. Measured against the live boxes so the sticky label column and any
  // page scrolling are already accounted for.
  useEffect(() => {
    if (selectedColumn < 0) return;
    // Measured after the browser has laid the table out, not during the commit
    // that changed it. Clicking a quarter while looking at the whole horizon
    // switches the day in the same render, and a rect read before that relayout
    // describes the table that is being replaced — which scrolled to roughly
    // the right fraction of the wrong width.
    const frame = requestAnimationFrame(() => {
      const container = gridRef.current;
      const cell = headerCells.current.get(selectedColumn);
      if (!container || !cell) return;
      const cellBox = cell.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      if (cellBox.width === 0) return;
      const delta = cellBox.left - box.left - box.width / 2 + cellBox.width / 2;
      container.scrollTo({ left: container.scrollLeft + delta, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedColumn, granularity, day]);

  const manual = useMemo(
    () => (bench && model ? scheduleFromDraft(bench, model, draft, allowExport) : null),
    [bench, model, draft, allowExport],
  );

  const comparison: WorkbenchComparison | null = useMemo(
    () => (bench && manual ? compareWorkbench(bench, manual) : null),
    [bench, manual],
  );

  const [charted, setCharted] = useState<'manual' | 'planner'>('manual');

  const values$ = useMemo(
    () => (bench && comparison ? storeValueSeries(bench, comparison.manual) : []),
    [bench, comparison],
  );

  /** Curves whose top the hardware will not let the store reach. */
  const beyondReach = useMemo(
    () => (bench ? curvesBeyondReach(bench) : []),
    [bench],
  );

  /** The store whose contract the export row is asking the reader to relax. */
  const gated = bench?.stores.find(
    store => store.discharge !== undefined && !store.discharge.export_allowed,
  );

  const chart = useMemo(() => {
    if (!bench || !comparison || !manual) return null;
    const showing = charted === 'manual' ? manual : bench.planned;
    const score = charted === 'manual' ? comparison.manual : comparison.planner;
    return buildWorkbenchChart(
      bench,
      showing,
      score,
      startMs => formatHomeDayMonthTime(startMs, homeTimeZone),
      storeLabel,
      view,
    );
  }, [bench, comparison, manual, charted, homeTimeZone, view]);

  /**
   * Both schedules, their inputs and their scores, as one file.
   *
   * A score settles which plan is better; the reason is in the quarters, and
   * they have to leave this machine for anyone else to look at them.
   */
  const exportPlan = () => {
    if (!bench || !manual || !comparison) return;
    const payload = buildWorkbenchExport(bench, manual, comparison);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `plan-${bench.captured_at.slice(0, 16).replace(/[:T]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /** A quarter's own clock time, for naming one in a sentence. */
  const timeOf = useCallback(
    (slot: number): string => (bench
      ? formatHomeDayMonthTime(bench.slot_start_ms[slot], homeTimeZone)
      : String(slot)),
    [bench, homeTimeZone],
  );

  const load = async () => {
    if (!homeId) return;
    setLoading(true);
    setError(null);
    const [{ data, error: queryError }, { data: curveRows }] = await Promise.all([
      supabase
        .from('energy_optimisation_current')
        .select('snapshot, plan')
        .eq('home_id', homeId)
        .maybeSingle(),
      // The curves as they are *now*, not as they were when the plan was made.
      //
      // A snapshot carries the value curves it was captured with, so editing a
      // threshold and coming here showed the old one: the worth row said 4.87
      // SEK/kWh while the curve editor's own chart said 2.05 for the same 239
      // km. Worse than a stale number, it made the question the editor exists
      // to answer — does this threshold stop the car outbidding the grid? —
      // unanswerable until a replan happened to land.
      supabase
        .from('energy_optimisation_value_curves')
        .select('store_key, unit, points')
        .eq('home_id', homeId),
    ]);
    if (queryError || !data?.snapshot) {
      setLoading(false);
      setError(t(
        'Ingen sparad ögonblicksbild att bygga mot.',
        'No stored snapshot to build against.',
      ));
      return;
    }
    try {
      // Solved against the prices the deployed plan actually used, not against
      // a fresh estimate. Two thirds of a 72-hour horizon is modelled rather
      // than quoted (§1.4.3), and everything derived from it moves with it —
      // including the battery's value curve, which is built from the shaped
      // tail. Re-estimating here with no price archive produced a curve with a
      // handful of breakpoints where the plan's had dozens, so the workbench
      // was pricing stored energy against a different day from the one the
      // household was reading.
      const stored = data.plan as unknown as OptimisationPlan | null;
      const snapshot = data.snapshot as unknown as OptimisationSnapshot;
      // Merged rather than replaced: a row exists only for a curve the
      // household has edited, and the rest of the snapshot's curves are still
      // the right answer for the stores they describe.
      const edited = Object.fromEntries(
        (curveRows ?? [])
          .filter(row => Array.isArray(row.points))
          .map(row => [row.store_key, { unit: row.unit, points: row.points }]),
      );
      setCurveSource(Object.keys(edited).length > 0 ? 'settings' : 'snapshot');
      const built = dispatchWorkbench(
        {
          ...snapshot,
          value_curves: { ...snapshot.value_curves, ...edited },
        } as OptimisationSnapshot,
        [],
        stored?.price_outlook,
      );
      if (!built) {
        setError(t(
          'Ögonblicksbilden har inga lager att planera — ingen bil, pool eller batteri är kopplad till planeraren.',
          'This snapshot has no stores to plan — no car, pool or battery is routed to the planner.',
        ));
      } else {
        setBench(built);
        setDraft({});
        setAllowExport([]);
        setDay(0);
      }
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
    setLoading(false);
  };

  /**
   * The ceiling a store that may not sell is held under, in this column.
   *
   * Infinity when the quarter is open to selling, or when the store's contract
   * already allows it — there is nothing to hold it under then.
   */
  const ceilingFor = useCallback(
    (row: WorkbenchRow, columnIndex: number): number => {
      if (!bench || !model || !manual) return Infinity;
      if (row.direction !== 'discharge' || row.storeKey !== gated?.key) return Infinity;
      if (allowExport[columnIndex]) return Infinity;
      return exportFreeCeilingKw(bench, model.columns[columnIndex], manual, row.storeKey);
    },
    [bench, model, manual, gated, allowExport],
  );

  const setCell = (rowId: string, columnIndex: number, kw: number) => {
    if (!model) return;
    const row = model.rows.find(entry => entry.id === rowId);
    if (!row) return;
    setDraft(current => {
      const next = [...(current[rowId] ?? model.planned[rowId] ?? [])];
      next[columnIndex] = row.direction === 'charge'
        ? executableKw(row, kw)
        : Math.max(0, Math.min(row.maxKw, ceilingFor(row, columnIndex), kw));
      return { ...current, [rowId]: next };
    });
  };

  /**
   * Open or close one quarter to selling from store.
   *
   * Closing it brings any figure already typed back under the cap, so the box
   * agrees with the plan rather than showing a number the schedule has quietly
   * dropped.
   */
  const togglePermit = (columnIndex: number) => {
    const opening = !allowExport[columnIndex];
    setAllowExport(current => {
      const next = [...current];
      next[columnIndex] = opening;
      return next;
    });
    if (opening || !model || !bench || !manual || !gated) return;
    const row = model.rows.find(
      entry => entry.direction === 'discharge' && entry.storeKey === gated.key,
    );
    if (!row) return;
    const ceiling = exportFreeCeilingKw(bench, model.columns[columnIndex], manual, gated.key);
    setDraft(current => {
      const values = current[row.id] ?? model.planned[row.id];
      if (!values || (values[columnIndex] ?? 0) <= ceiling) return current;
      const next = [...values];
      next[columnIndex] = ceiling;
      return { ...current, [row.id]: next };
    });
  };

  /**
   * Point both views at one quarter, wherever the request came from.
   *
   * Selecting is not enough on its own: a quarter in another day is off the
   * table entirely until the day follows it, which is what makes a breach in
   * the list reachable at all.
   */
  const goToQuarter = useCallback((quarter: number) => {
    setSelected(quarter);
    const containing = days.findIndex(
      entry => quarter >= entry.range.from && quarter < entry.range.to,
    );
    if (containing >= 0 && containing !== day) setDay(containing);
  }, [days, day]);

  /** Tint marking the quarter the reader pointed at, in either view. */
  const column = (index: number): string =>
    index === selectedColumn ? 'bg-primary/10' : '';

  if (!bench) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('Bygg en plan själv', 'Build a plan yourself')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t(
              'Hämtar planerarens egna indata — priser, solprognos, laster och lager — och låter dig skriva in ditt eget schema. Båda planerna får poäng av exakt samma målfunktion som planeraren väljer med, så skillnaden är i kronor och går att lita på.',
              'Loads the planner’s own inputs — prices, solar forecast, loads and stores — and lets you type your own schedule. Both plans are scored by exactly the objective the planner selects on, so the difference is in kronor and means something.',
            )}
          </p>
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{t('Kunde inte läsa in', 'Could not load')}</AlertTitle>
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}
          <Button onClick={load} disabled={loading || !homeId}>
            {loading
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <Sparkles className="w-4 h-4 mr-2" />}
            {t('Läs in planerarens plan', 'Load the planner’s plan')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const better = comparison ? comparison.totalDeltaSek < -0.005 : false;
  const worse = comparison ? comparison.totalDeltaSek > 0.005 : false;
  const blocked = (comparison?.introduced.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t('Poäng', 'Score')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">
                {t('Planerarens plan', 'The planner’s plan')}
              </div>
              <div className="text-2xl font-medium tabular-nums">
                {comparison?.planner.total_sek.toFixed(2)} SEK
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {t('Din plan', 'Your plan')}
              </div>
              <div className="text-2xl font-medium tabular-nums">
                {comparison?.manual.total_sek.toFixed(2)} SEK
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {t('Skillnad', 'Difference')}
              </div>
              <div
                className={`text-2xl font-medium tabular-nums ${
                  blocked
                    ? 'text-muted-foreground'
                    : better
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : worse
                    ? 'text-rose-600 dark:text-rose-400'
                    : ''
                }`}
              >
                {comparison ? signed(comparison.totalDeltaSek, 2, 'SEK') : '—'}
              </div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3 border-t pt-4">
            <div>
              <div className="text-xs text-muted-foreground">
                {t('Vad planeraren kostar dig', 'What the planner costs you')}
              </div>
              <div className="text-xl font-medium tabular-nums">
                {comparison?.planner.billable_sek.toFixed(2)} SEK
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {t('Vad din plan kostar dig', 'What your plan costs you')}
              </div>
              <div className="text-xl font-medium tabular-nums">
                {comparison?.manual.billable_sek.toFixed(2)} SEK
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {t('Skillnad på räkningen', 'Difference on the bill')}
              </div>
              <div
                className={`text-xl font-medium tabular-nums ${
                  (comparison?.billableDeltaSek ?? 0) < -0.005
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : (comparison?.billableDeltaSek ?? 0) > 0.005
                      ? 'text-rose-600 dark:text-rose-400'
                      : ''
                }`}
              >
                {comparison ? signed(comparison.billableDeltaSek, 2, 'SEK') : '—'}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'Räkningen är köpt el minus såld el och inget annat — inga värdekurvor, inget slitage, ingen effektavgift (den är en styrsignal, inte en tariff). Den säger vad planen kostar, inte om den var värd det: en plan som inte laddar bilen är alltid billigare. Två tredjedelar av horisonten är modellerade priser, så bara den kvoterade delen är riktiga pengar.',
              'The bill is energy bought minus energy sold and nothing else — no value curves, no wear, no peak charge (that is a shaping signal, not a tariff). It says what a plan costs, not whether it was worth it: a plan that never charges the car is always cheaper. Two thirds of the horizon is modelled prices, so only the quoted part is real money.',
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'Lägre är bättre: talet är kostnad minus levererad nytta, så det är ofta negativt. Är din plan lägre hittade planeraren inte den bästa lösningen som målfunktionen tillåter — felet sitter i sökningen. Är den högre men känns bättre är det en värdekurva som är fel.',
              'Lower is better: the number is cost minus the service delivered, so it is often negative. If yours is lower, the planner failed to find the best schedule its own objective allows — the fault is in the search. If yours is higher but still reads better to you, a value curve is wrong.',
            )}
          </p>
          {blocked && (
            <Issues
              title={t('Din plan går inte att köra', 'Your plan cannot be run')}
              entries={comparison!.introduced}
              tone="destructive"
              more={t('… och fler', '… and more')}
              timeOf={timeOf}
              onGo={goToQuarter}
            />
          )}
          {beyondReach.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>
                {t(
                  'En värdekurva ber om mer än hårdvaran tillåter',
                  'A value curve asks for more than the hardware allows',
                )}
              </AlertTitle>
              <AlertDescription>
                <ul className="text-xs list-disc pl-4 space-y-0.5">
                  {beyondReach.map(entry => (
                    <li key={entry.key}>
                      {t(
                        `${entry.label}: kurvan slutar värdera vid ${Math.round(entry.ratio * 100)}% av vad lagret kan hålla`,
                        `${entry.label}: the curve stops valuing at ${Math.round(entry.ratio * 100)}% of what the store can hold`,
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] mt-2 opacity-80">
                  {t(
                    'Den punkten nås aldrig, så lagret slutar aldrig vara värt att ladda och vinner mot nätpriset varje timme. Andelen är årstidsoberoende: gångra den med laddgränsen för att läsa den som SOC — 128% mot en gräns på 80% är en kurva som ber om 102% SOC. Ställ om trösklarna i Ekonomi, eller höj laddgränsen.',
                    'That point is never reached, so the store never stops being worth charging and beats the grid price every hour. The fraction is season-independent: multiply it by the charge limit to read it as SOC — 128% against an 80% limit is a curve asking for 102% SOC. Restate the thresholds under Economics, or raise the charge limit.',
                  )}
                </p>
              </AlertDescription>
            </Alert>
          )}
          {(comparison?.planner.infeasibilities.length ?? 0) > 0 && (
            <Issues
              title={t(
                'Planerarens egen plan bryter mot sina egna regler',
                'The planner’s own plan breaks its own rules',
              )}
              entries={comparison!.planner.infeasibilities}
              tone="default"
              more={t('… och fler', '… and more')}
              footer={t(
                'Det här är ett fynd, inte ett fel i verktyget: målfunktionen underkänner ett schema planeraren själv skickade. Jämförelsen ovan gäller ändå — båda planerna räknas med samma regler.',
                'This is a finding, not a fault in the tool: the objective refuses a schedule the planner itself issued. The comparison above still holds — both plans are scored by the same rules.',
              )}
              timeOf={timeOf}
              onGo={goToQuarter}
            />
          )}
          {comparison && (
            <div className="overflow-x-auto">
              <table className="text-xs w-full min-w-[520px]">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal py-1">{t('Post', 'Line')}</th>
                    <th className="text-right font-normal py-1">{t('Planeraren', 'Planner')}</th>
                    <th className="text-right font-normal py-1">{t('Du', 'You')}</th>
                    <th className="text-right font-normal py-1">{t('Skillnad', 'Diff')}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {([
                    [t('Köpt el', 'Energy bought'), comparison.planner.import_sek, comparison.manual.import_sek],
                    [t('Effekttillägg', 'Peak charge'), comparison.planner.peak_sek, comparison.manual.peak_sek],
                    [t('Såld el', 'Energy sold'), -comparison.planner.export_sek, -comparison.manual.export_sek],
                    [t('Slitage', 'Wear'), comparison.planner.wear_sek, comparison.manual.wear_sek],
                    [t('Starter', 'Starts'), comparison.planner.start_sek, comparison.manual.start_sek],
                    [t('Levererad nytta', 'Service delivered'), -comparison.planner.service_value_sek, -comparison.manual.service_value_sek],
                    ...comparison.planner.stores.map((store, at): [string, number, number] => [
                      `${storeLabel(store.key)} — ${t('nytta', 'service')}`,
                      -store.service_value_sek,
                      -(comparison.manual.stores[at]?.service_value_sek ?? 0),
                    ]),
                  ] as [string, number, number][]).map(([label, left, right]) => (
                    <tr key={label} className="border-t border-border/50">
                      <td className="py-1">{label}</td>
                      <td className="text-right py-1">{left.toFixed(2)}</td>
                      <td className="text-right py-1">{right.toFixed(2)}</td>
                      <td className="text-right py-1">{signed(right - left, 2, '')}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-medium">
                    <td className="py-1">{t('På räkningen', 'On the bill')}</td>
                    <td className="text-right py-1">{comparison.planner.billable_sek.toFixed(2)}</td>
                    <td className="text-right py-1">{comparison.manual.billable_sek.toFixed(2)}</td>
                    <td className="text-right py-1">{signed(comparison.billableDeltaSek, 2, '')}</td>
                  </tr>
                  <tr className="border-t border-border/50">
                    <td className="py-1">{t('därav kvoterat pris', 'of that, at quoted prices')}</td>
                    <td className="text-right py-1">{comparison.planner.billable_quoted_sek.toFixed(2)}</td>
                    <td className="text-right py-1">{comparison.manual.billable_quoted_sek.toFixed(2)}</td>
                    <td className="text-right py-1">
                      {signed(
                        comparison.manual.billable_quoted_sek -
                          comparison.planner.billable_quoted_sek,
                        2,
                        '',
                      )}
                    </td>
                  </tr>
                  <tr className="border-t border-border">
                    <td className="py-1">{t('Köpt från nätet', 'Bought from grid')}</td>
                    <td className="text-right py-1">{comparison.planner.grid_import_kwh.toFixed(1)} kWh</td>
                    <td className="text-right py-1">{comparison.manual.grid_import_kwh.toFixed(1)} kWh</td>
                    <td className="text-right py-1">{signed(comparison.importDeltaKwh, 1, '')}</td>
                  </tr>
                  <tr className="border-t border-border/50">
                    <td className="py-1">{t('Sålt till nätet', 'Sold to grid')}</td>
                    <td className="text-right py-1">{comparison.planner.grid_export_kwh.toFixed(1)} kWh</td>
                    <td className="text-right py-1">{comparison.manual.grid_export_kwh.toFixed(1)} kWh</td>
                    <td className="text-right py-1">{signed(comparison.exportDeltaKwh, 1, '')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {chart && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {t('Planerad förbrukning', 'Planned consumption')}
              </CardTitle>
              <div className="flex items-center gap-1">
                {([
                  ['manual', t('Din plan', 'Your plan')],
                  ['planner', t('Planerarens', 'The planner’s')],
                ] as const).map(([option, label]) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === charted ? 'default' : 'outline'}
                    onClick={() => setCharted(option)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <PlanPanels
              rows={chart.rows}
              series={chart.series}
              baseValues={chart.baseValues}
              dividerIndex={0}
              hasBattery={chart.hasBattery}
              hasEvBattery={chart.hasEvBattery}
              selectedIndex={
                selected !== null && selected >= view.from && selected < view.to
                  ? selected - view.from
                  : -1
              }
              // Clicking a quarter while looking at the whole horizon is a
              // request to go and look at it, so the table follows.
              onQuarterClick={index => goToQuarter(view.from + index)}
            />
            <p className="text-[11px] text-muted-foreground mt-2">
              {t(
                'Samma panelerna som planvyn, ritade från schemat nedan. Ändra en ruta och kurvan följer med — flytta mellan din plan och planerarens för att se skillnaden i form, inte bara i kronor.',
                'The same panels as the plan view, drawn from the schedule below. Change a cell and the curves follow — flip between yours and the planner’s to see the difference in shape, not only in kronor.',
              )}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {t('Ditt schema', 'Your schedule')}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1">
              {days.map((entry, index) => (
                <Button
                  key={entry.label}
                  size="sm"
                  variant={index === day ? 'default' : 'outline'}
                  onClick={() => setDay(index)}
                >
                  {entry.label}
                </Button>
              ))}
              <Button
                size="sm"
                variant={day === 'all' ? 'default' : 'outline'}
                onClick={() => setDay('all')}
              >
                {t('Alla', 'All')}
              </Button>
              <span className="mx-1 h-4 w-px bg-border" />
              {(['hour', 'quarter'] as Granularity[]).map(option => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === granularity ? 'default' : 'outline'}
                  onClick={() => {
                    setGranularity(option);
                    setDraft({});
                    setAllowExport([]);
                  }}
                >
                  {option === 'hour' ? t('1 tim', '1 hour') : t('15 min', '15 min')}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setDraft({}); setAllowExport([]); }}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                {t('Återställ', 'Reset')}
              </Button>
              <Button size="sm" variant="ghost" onClick={exportPlan} disabled={!comparison}>
                <Download className="w-3.5 h-3.5 mr-1" />
                {t('Exportera', 'Export')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            {t(
              'Skriv effekt i kW. På 15 min ser du exakt planerarens plan. På 1 tim är rutan ett snitt för timmen: ligger den under vad enheten kan köra blir den i stället full effekt under en del av timmen, precis som planeraren gör.',
              'Type power in kW. At 15 min you see the planner’s plan exactly. At 1 hour a cell is an average for that hour: below what the device can run at, it becomes full power for part of the hour instead — the same trade the planner makes.',
            )}
          </p>
          <div className="overflow-x-auto" ref={gridRef} data-testid="workbench-grid">
            <table className="text-xs border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-background text-left font-normal text-muted-foreground py-1 pr-3 min-w-[132px]">
                    {t('Tid', 'Time')}
                  </th>
                  {shown.map(index => (
                    <th
                      key={index}
                      ref={element => {
                        if (element) headerCells.current.set(index, element);
                        else headerCells.current.delete(index);
                      }}
                      data-selected={index === selectedColumn ? 'true' : undefined}
                      className={`font-normal text-muted-foreground py-1 px-1 text-center min-w-[52px] ${column(index)}`}
                    >
                      {formatHomeTime(model!.columns[index].startMs, homeTimeZone)}
                      {!model!.columns[index].binding && (
                        <div className="text-[9px] opacity-60">
                          {t('prognos', 'forecast')}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                <tr>
                  <td className="sticky left-0 z-10 bg-background py-1 pr-3 text-muted-foreground">
                    {t('Pris in / ut', 'Price in / out')}
                  </td>
                  {shown.map(index => (
                    <td key={index} className={`py-1 px-1 text-center whitespace-nowrap ${column(index)}`}>
                      <div>{model!.columns[index].importSekPerKwh.toFixed(2)}</div>
                      <div className="opacity-50">
                        {model!.columns[index].exportSekPerKwh.toFixed(2)}
                      </div>
                    </td>
                  ))}
                </tr>
                <tr className="border-t">
                  <td className="sticky left-0 z-10 bg-background py-1 pr-3 text-muted-foreground">
                    {t('Sol / husets last', 'Solar / house load')}
                  </td>
                  {shown.map(index => (
                    <td key={index} className={`py-1 px-1 text-center whitespace-nowrap ${column(index)}`}>
                      <div className="text-amber-600 dark:text-amber-400">
                        {model!.columns[index].solarKw.toFixed(1)}
                      </div>
                      <div className="opacity-50">
                        {model!.columns[index].fixedLoadKw.toFixed(1)}
                      </div>
                    </td>
                  ))}
                </tr>
                {values$.map(series => (
                  <tr key={`${series.key}-value`} className="border-t">
                    <td className="sticky left-0 z-10 bg-background py-1 pr-3 text-muted-foreground">
                      <div>{series.label} — {t('värde', 'worth')}</div>
                      <div className="text-[10px]">{t('SEK/kWh lagrad', 'SEK/kWh stored')}</div>
                    </td>
                    {shown.map(index => {
                      const slots = model!.columns[index].slots;
                      const sek = slots.reduce(
                        (total, slot) => total + (series.sekPerKwh[slot] ?? 0),
                        0,
                      ) / slots.length;
                      // Above what the quarter costs, another kWh pays for
                      // itself; below what the grid charges, spending one does.
                      const dear = sek > model!.columns[index].importSekPerKwh;
                      return (
                        <td
                          key={index}
                          className={`py-1 px-1 text-center whitespace-nowrap tabular-nums ${column(index)} ${
                            dear ? 'text-sky-600 dark:text-sky-400 font-medium' : ''
                          }`}
                        >
                          {sek.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {model!.rows.map(row => (
                  <tr key={row.id} className="border-t">
                    <td className="sticky left-0 z-10 bg-background py-1 pr-3">
                      <div>{row.label}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t('max', 'max')} {row.maxKw.toFixed(1)} kW
                        {row.stepKw > 0 && ` · ${row.minKw.toFixed(2)}–${row.stepKw.toFixed(2)}`}
                      </div>
                    </td>
                    {shown.map(index => (
                      <td key={index} className={`py-0.5 px-0.5 ${column(index)}`}>
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={row.maxKw}
                          step={row.stepKw > 0 ? row.stepKw : 0.1}
                          value={Number((values(row.id)[index] ?? 0).toFixed(2))}
                          onChange={event =>
                            setCell(row.id, index, Number(event.target.value.replace(',', '.')))}
                          className="h-7 w-[52px] px-1 text-center text-xs tabular-nums"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                {gated && (
                  <tr className="border-t">
                    <td className="sticky left-0 z-10 bg-background py-1 pr-3">
                      <div>{t('Tillåt export från batteri', 'Allow battery export')}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t('per kvart', 'per quarter')}
                      </div>
                    </td>
                    {shown.map(index => (
                      <td key={index} className={`py-0.5 px-0.5 text-center ${column(index)}`}>
                        <button
                          type="button"
                          aria-pressed={allowExport[index] === true}
                          onClick={() => togglePermit(index)}
                          className={`h-6 w-[52px] rounded border text-[10px] ${
                            allowExport[index]
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-background text-muted-foreground'
                          }`}
                        >
                          {allowExport[index] ? t('på', 'on') : t('av', 'off')}
                        </button>
                      </td>
                    ))}
                  </tr>
                )}
                {comparison && (
                  <tr className="border-t">
                    <td className="sticky left-0 z-10 bg-background py-1 pr-3">
                      <div>{t('Nätet in / ut', 'Grid in / out')}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t('plus = köpt, minus = sålt', 'plus = bought, minus = sold')}
                      </div>
                    </td>
                    {shown.map(index => {
                      const slots = model!.columns[index].slots;
                      const kw = slots.reduce(
                        (total, slot) => total + gridWattsAt(comparison.manual, slot),
                        0,
                      ) / slots.length / 1_000;
                      return (
                        <td
                          key={index}
                          className={`py-1 px-1 text-center whitespace-nowrap font-medium ${column(index)} ${
                            kw > 0.05
                              ? 'text-rose-600 dark:text-rose-400'
                              : kw < -0.05
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-muted-foreground'
                          }`}
                        >
                          {kw > 0.05 ? '+' : ''}{kw.toFixed(1)}
                        </td>
                      );
                    })}
                  </tr>
                )}
                {comparison && model!.rows.filter(row => row.direction === 'charge').map(row => (
                  <tr key={`${row.id}-state`} className="border-t">
                    <td className="sticky left-0 z-10 bg-background py-1 pr-3 text-muted-foreground">
                      {row.label} — {t('slutläge', 'ends at')}
                    </td>
                    {shown.map(index => {
                      const trajectory = comparison.manual.state[row.storeKey];
                      const slots = model!.columns[index].slots;
                      const lastSlot = slots.at(-1)!;
                      if (!trajectory) {
                        return (
                          <td key={index} className={`py-1 px-1 text-center ${column(index)}`}>—</td>
                        );
                      }
                      // The change, not only the level: a quarter of 5 kW into
                      // the pack moves it by 1.19 kWh, and without the delta
                      // beside it the level reads as though nothing landed.
                      const moved = trajectory[lastSlot + 1] - trajectory[slots[0]];
                      return (
                        <td key={index} className={`py-1 px-1 text-center whitespace-nowrap ${column(index)}`}>
                          <div>{stateLabel(row.stateUnit, trajectory[lastSlot + 1])}</div>
                          {Math.abs(moved) > 0.005 && (
                            <div className={`text-[10px] ${
                              moved > 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-muted-foreground'
                            }`}>
                              {moved > 0 ? '+' : '−'}{Math.abs(moved).toFixed(2)}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Badge variant="outline" className="text-[10px]">
              {t('Planeraren stannade på', 'Planner stopped on')}: {bench.stopped_because}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {bench.iterations} {t('iterationer', 'iterations')}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {bench.slots.length} {t('kvartar', 'quarters')}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {curveSource === 'settings'
                ? t('värdekurvor från inställningar', 'curves from settings')
                : t('värdekurvor från ögonblicksbilden', 'curves from the snapshot')}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default PlanWorkbenchTab;
