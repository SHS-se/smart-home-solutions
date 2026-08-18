// Why each store got what it got, in one table.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.9: priority is an *output*, obtained
// by sorting marginal values, so the only way to read a plan is to see what
// every store was worth against what its energy cost. The planner has always
// published exactly that in `store_diagnostics` and nothing rendered it, which
// is how a connected car below its own charge limit sat unplanned for two days
// behind a plan reporting "ready" with no errors.
//
// The table's second job is the one that failure actually needed: **an absent
// store must occupy a row**. A store that loses says what it was worth; a store
// that was never built used to say nothing at all, and "considered and
// declined" looked identical to "this household owns no car".

import React from 'react';
import { AlertTriangle, Check, Minus } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import type { TimelineRange, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import type { PlanModel } from './usePlanModel';

interface GridFlow {
  kwh: number;
  pricedKwh: number;
  sek: number;
  /** Weighted average over the priced part only, or null when none is priced. */
  averageSekPerKwh: number | null;
}

/**
 * What crossed the meter, and at what price.
 *
 * Read from the timeline rather than the plan, so a past day reports what the
 * meter actually recorded instead of what was once forecast for it, and the
 * figures agree with the chart directly above them.
 *
 * The stores explain what the house *kept*; this explains what it bought and
 * sold, which is the other half of the same decision. Every export is energy no
 * store bid above the price it earned, so the export price is the floor a bid
 * has to clear before keeping a kWh beats selling it — the comparison that
 * makes "why was 28 kWh exported" answerable at all.
 */
function gridFlows(rows: readonly TimelineRow[]): {
  imported: GridFlow;
  exported: GridFlow;
  fullyPriced: boolean;
  measuredShare: number;
} {
  const empty = (): GridFlow => ({ kwh: 0, pricedKwh: 0, sek: 0, averageSekPerKwh: null });
  const imported = empty();
  const exported = empty();
  let unpriced = 0;
  let measured = 0;
  for (const row of rows) {
    if (row.measured) measured += 1;
    const inKwh = (row.gridImportW ?? 0) / 4_000;
    // Export is stored negative — energy leaving the house — and read here as
    // a positive quantity sold.
    const outKwh = Math.abs(row.gridExportW ?? 0) / 4_000;
    imported.kwh += inKwh;
    exported.kwh += outKwh;
    if (row.importPriceSekPerKwh !== null) {
      imported.pricedKwh += inKwh;
      imported.sek += inKwh * row.importPriceSekPerKwh;
    } else if (inKwh > 0) unpriced += 1;
    if (row.exportPriceSekPerKwh !== null) {
      exported.pricedKwh += outKwh;
      exported.sek += outKwh * row.exportPriceSekPerKwh;
    } else if (outKwh > 0) unpriced += 1;
  }
  for (const flow of [imported, exported]) {
    flow.averageSekPerKwh = flow.pricedKwh > 0.0001 ? flow.sek / flow.pricedKwh : null;
  }
  return {
    imported,
    exported,
    fullyPriced: unpriced === 0,
    measuredShare: rows.length === 0 ? 0 : measured / rows.length,
  };
}

/** Which per-slot column carries each store's scheduled power. */
const POWER_FIELD: Record<string, 'pool_w' | 'ev_w' | 'battery_charge_w'> = {
  pool: 'pool_w',
  ev: 'ev_w',
  battery: 'battery_charge_w',
};

/**
 * What each store is scheduled to take inside the selected window.
 *
 * The diagnostics' own `planned_kwh` covers the whole horizon, because the
 * decision was made once for all 72 hours. The *consequence* is per-day, and a
 * table that reports a three-day total while the chart above it shows one
 * Tuesday is telling the reader two different things at once.
 */
function windowedEnergy(
  slots: PlanModel['executed']['slots'],
): Record<string, { kwh: number; hours: number }> {
  const totals: Record<string, { kwh: number; hours: number }> = {};
  for (const [key, field] of Object.entries(POWER_FIELD)) {
    let kwh = 0;
    let running = 0;
    for (const slot of slots) {
      const watts = (slot[field] ?? 0) as number;
      if (watts > 0) {
        kwh += watts / 4_000;
        running += 1;
      }
    }
    totals[key] = { kwh, hours: running * 0.25 };
  }
  return totals;
}

type Reason =
  | 'scheduled'
  | 'state_above_curve'
  | 'value_below_price'
  | 'outbid'
  | 'not_controllable'
  | 'disconnected'
  | 'state_unavailable'
  | 'no_price_reference';

interface Row {
  key: string;
  unit: string;
  state: number | null;
  marginal_value_sek_per_kwh: number | null;
  cheapest_energy_sek_per_kwh: number | null;
  planned_kwh: number;
  returned_kwh: number;
  reason: Reason;
}

/** Reasons that mean the store never entered the auction at all. */
const UNCONSIDERED: ReadonlySet<Reason> = new Set<Reason>([
  'not_controllable',
  'disconnected',
  'state_unavailable',
  'no_price_reference',
]);

const STORE_LABEL: Record<string, [string, string]> = {
  pool: ['Pool', 'Pool'],
  ev: ['Bil', 'Car'],
  battery: ['Hembatteri', 'Home battery'],
  hot_water: ['Varmvatten', 'Hot water'],
};

/**
 * How each state is written, in the unit the household thinks in.
 *
 * The curve's own unit, never kWh: a pool is a temperature and a car is a
 * range. Converting them to energy here would undo the whole point of §8.3.
 */
const formatState = (unit: string, state: number | null): string => {
  if (state === null) return '—';
  if (unit === 'celsius') return `${state.toFixed(1)} °C`;
  if (unit === 'km') return `${Math.round(state)} km`;
  if (unit === 'kwh') return `${state.toFixed(1)} kWh`;
  return String(state);
};

const sek = (value: number | null): string =>
  value === null ? '—' : value.toFixed(2);

/**
 * The sentence a household should read, plus what to do about it.
 *
 * The four "never considered" reasons each name a different thing to change,
 * which is the entire value of separating them: an unplugged car and an
 * unrouted charger look the same in a schedule and need opposite responses.
 */
const REASON_TEXT: Record<Reason, { sv: [string, string]; en: [string, string] }> = {
  scheduled: {
    sv: ['Schemalagd', 'Värd mer än energin kostar'],
    en: ['Scheduled', 'Worth more than the energy costs'],
  },
  state_above_curve: {
    sv: ['Redan mättad', 'Ytterligare energi är värd noll här'],
    en: ['Already satisfied', 'Another kWh is worth nothing at this state'],
  },
  value_below_price: {
    sv: ['Avstod', 'Värd mindre än den billigaste energin i perioden'],
    en: ['Declined', 'Worth less than the cheapest energy in the horizon'],
  },
  outbid: {
    sv: ['Överbjuden', 'En annan lagring värderade samma energi högre'],
    en: ['Outbid', 'Another store valued the same energy more highly'],
  },
  not_controllable: {
    sv: ['Planeras inte', 'Ingen mätare är satt till styrbar för den här tjänsten'],
    en: ['Not planned', 'No meter is set to controllable for this service'],
  },
  disconnected: {
    sv: ['Inte ansluten', 'Ingenting är inkopplat att ladda'],
    en: ['Not connected', 'Nothing is plugged in to charge'],
  },
  state_unavailable: {
    sv: ['Saknar mätvärde', 'Sensorn som kurvan mäts mot saknas eller är otillgänglig'],
    en: ['No measured state', 'The sensor the curve is defined over is missing'],
  },
  no_price_reference: {
    sv: ['Inget prisunderlag', 'Inga priser att värdera lagrad energi mot'],
    en: ['No price reference', 'No prices to value stored energy against'],
  },
};

const StoreDecisions: React.FC<{
  model: PlanModel;
  /** The same timeline window the chart above is showing, so the two agree. */
  rows: TimelineRow[];
  range: TimelineRange;
}> = ({ model, rows: timeline, range }) => {
  const { t, language } = useLanguage();
  const rows = (model.executed.store_diagnostics ?? []) as Row[];

  const windowRows = React.useMemo(
    () => timeline.slice(range.from, range.to),
    [range.from, range.to, timeline],
  );

  // Plan slots inside the same window. A day earlier than the plan's issue time
  // has no overlap at all, which is not an empty result but a different
  // statement: what happened then was measured, not decided by this plan.
  const inWindow = React.useMemo(() => {
    const first = windowRows[0]?.startMs;
    const last = windowRows.at(-1)?.startMs;
    if (first === undefined || last === undefined) return [];
    return model.executed.slots.filter(slot => {
      const at = Date.parse(slot.start);
      return at >= first && at <= last;
    });
  }, [model.executed.slots, windowRows]);

  const grid = gridFlows(windowRows);
  const energy = windowedEnergy(inWindow);
  const partial = inWindow.length < model.executed.slots.length;

  // A plan with no dispatched stores still bought and sold energy, so the grid
  // half is rendered either way. Returning early here dropped it for every
  // schema 5 plan, which is exactly the reader who most needs it.
  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t(
            'Den här planen styr inga lagringar som fysiska tillstånd, så det finns inga bud att visa.',
            'This plan controls no stores as physical states, so there are no bids to show.',
          )}
        </p>
        <GridDecisions grid={grid} />
      </div>
    );
  }

  // Scheduled first, then declined, then everything that never bid — which is
  // the order a reader wants: what happened, what was weighed, what was absent.
  const ordered = [...rows].sort((left, right) => {
    const rank = (row: Row) =>
      row.reason === 'scheduled' ? 0 : UNCONSIDERED.has(row.reason) ? 2 : 1;
    return rank(left) - rank(right) || left.key.localeCompare(right.key);
  });
  const unconsidered = ordered.filter(row => UNCONSIDERED.has(row.reason));

  // A window with no planned quarters still bought and sold energy, and those
  // are measured facts worth reporting. Only the *decisions* are absent, so
  // only the bid table goes away.
  if (inWindow.length === 0) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">
          {t('Vad planen beslutade, och varför', 'What the plan decided, and why')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'Den här perioden ligger före den aktuella planen, så det finns inga beslut att förklara. Siffrorna nedan är uppmätta.',
            'This period is before the current plan, so there are no decisions to explain. The figures below are measured.',
          )}
        </p>
        <GridDecisions grid={grid} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">
          {t('Vad planen beslutade, och varför', 'What the plan decided, and why')}
        </h3>
        <p className="text-[11px] text-muted-foreground">
          {t(
            'Varje lagring bjuder vad en kWh är värd för just den. Den som bjuder över priset får energin — det finns ingen fast prioritetsordning.',
            'Each store bids what a kWh is worth to it. Whichever bid beats the price gets the energy; there is no fixed priority order.',
          )}
          {partial && ` ${t(
            'Tillstånd, värde och pris gäller hela planen — beslutet fattades en gång för alla 72 timmarna. Planerat och nätet nedan gäller den valda perioden.',
            'State, worth and price describe the whole plan: the decision was made once for all 72 hours. Planned, and the grid below, cover the selected period.',
          )}`}
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Lagring', 'Store')}</TableHead>
            <TableHead className="text-right">{t('Tillstånd', 'State')}</TableHead>
            <TableHead className="text-right">{t('Värd', 'Worth')}</TableHead>
            <TableHead className="text-right">{t('Billigaste energi', 'Cheapest energy')}</TableHead>
            <TableHead className="text-right">{t('Planerat', 'Planned')}</TableHead>
            <TableHead>{t('Utfall', 'Outcome')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map(row => {
            const text = REASON_TEXT[row.reason] ?? REASON_TEXT.outbid;
            const [headline, detail] = language === 'sv' ? text.sv : text.en;
            const absent = UNCONSIDERED.has(row.reason);
            const label = STORE_LABEL[row.key] ?? [row.key, row.key];
            return (
              <TableRow key={row.key} className={absent ? 'bg-amber-50/60 dark:bg-amber-950/20' : undefined}>
                <TableCell className="font-medium">
                  {language === 'sv' ? label[0] : label[1]}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatState(row.unit, row.state)}
                </TableCell>
                {/*
                  Both prices are SEK per kWh of *electricity*, which is the
                  only footing on which a pool degree, a kilometre of range and
                  a stored kWh can be compared at all.
                */}
                <TableCell className="text-right tabular-nums">
                  {sek(row.marginal_value_sek_per_kwh)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {sek(row.cheapest_energy_sek_per_kwh)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {(energy[row.key]?.kwh ?? 0) > 0.05
                    ? `${energy[row.key].kwh.toFixed(1)} kWh`
                    : '—'}
                  {(energy[row.key]?.hours ?? 0) > 0 && (
                    <span className="block text-[11px] text-muted-foreground">
                      {energy[row.key].hours.toFixed(1)} {t('h', 'h')}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-start gap-1.5">
                    {absent
                      ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
                      : row.reason === 'scheduled'
                        ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
                        : <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                    <span>
                      <span className="font-medium">{headline}</span>
                      <span className="block text-[11px] text-muted-foreground">{detail}</span>
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <GridDecisions grid={grid} />

      {unconsidered.length > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50/70 p-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-200">
          {t(
            'Markerade rader deltog aldrig i avvägningen. De vann alltså inte "för lite värde" — de fanns inte med alls, och det är en inställning att rätta snarare än ett utfall att acceptera.',
            'Highlighted rows never entered the trade-off at all. They did not lose on value — they were not present, which is a setting to correct rather than an outcome to accept.',
          )}
        </p>
      )}
    </div>
  );
};

/**
 * The two decisions the store table cannot show.
 *
 * Buying and selling are not services with a curve, so they hold no row above —
 * but they are the counterparty to every bid made there. Exported energy is
 * precisely the energy no store outbid, which makes the export price the floor
 * every bid has to clear before keeping a kWh beats selling it. Reading the
 * store table without this leaves the obvious question — "why was all that
 * exported?" — with no answer anywhere on the page.
 */
const GridDecisions: React.FC<{ grid: ReturnType<typeof gridFlows> }> = ({ grid }) => {
  const { t } = useLanguage();
  const { imported, exported, fullyPriced, measuredShare } = grid;
  /**
   * Quantity, then money — and never a price that fails to multiply.
   *
   * Nord Pool prices about a day of a three-day horizon, so most windows are
   * part-priced. Printing the total kWh beside an average and a total that
   * cover only the priced share reads as arithmetic and is not: 23.6 kWh at
   * 2.44 SEK/kWh is 57 SEK, not the 21 SEK actually shown. The priced quantity
   * has to appear next to the money it explains.
   */
  const moneyOf = (flow: GridFlow) => {
    if (flow.averageSekPerKwh === null) {
      return t('inget publicerat pris ännu', 'no published price yet');
    }
    const allPriced = flow.kwh - flow.pricedKwh < 0.05;
    const priced = allPriced
      ? `${flow.averageSekPerKwh.toFixed(2)} SEK/kWh ${t('i snitt', 'average')}`
      : `${flow.pricedKwh.toFixed(1)} kWh ${t('prissatt till', 'priced at')} ${
        flow.averageSekPerKwh.toFixed(2)
      } SEK/kWh`;
    return `${priced} · ${flow.sek.toFixed(2)} SEK`;
  };

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <h4 className="text-sm font-medium">{t('Och nätet', 'And the grid')}</h4>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="w-14 shrink-0 text-muted-foreground">{t('Köpt', 'Bought')}</dt>
          <dd className="tabular-nums">
            {imported.kwh.toFixed(1)} kWh · {moneyOf(imported)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="w-14 shrink-0 text-muted-foreground">{t('Sålt', 'Sold')}</dt>
          <dd className="tabular-nums">
            {exported.kwh.toFixed(1)} kWh · {moneyOf(exported)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {exported.kwh <= 0.05
          ? t(
            'Ingenting exporterades: varje kWh gick till huset eller till en lagring som värderade den högre än nätet.',
            'Nothing was exported: every kWh went to the house or to a store that valued it above what the grid would pay.',
          )
          : exported.averageSekPerKwh !== null
          ? t(
            `Allt som säljs är energi ingen lagring bjöd över ${exported.averageSekPerKwh.toFixed(2)} SEK/kWh för. Säljpriset är alltså golvet varje bud måste klara innan det lönar sig att behålla en kWh i stället för att sälja den — solel är inte gratis så länge den kan säljas.`,
            `Everything sold is energy no store bid above ${exported.averageSekPerKwh.toFixed(2)} SEK/kWh for. The export price is therefore the floor every bid must clear before keeping a kWh beats selling it — solar is not free while it can be sold.`,
          )
          // Exported, but into quarters the market has not priced yet. The
          // floor still exists; it is modelled rather than quoted, so naming a
          // figure here would dress an estimate up as a receipt.
          : t(
            'Allt som säljs är energi ingen lagring värderade över säljpriset. De här kvartarna har ännu inget marknadspris, så golvet planeraren jämförde mot kommer från husets egen uppmätta priskurva.',
            'Everything sold is energy no store valued above the export price. These quarters have no market price yet, so the floor the planner compared against came from this home’s own measured price shape.',
          )}
        {measuredShare > 0 && measuredShare < 1 && ` ${t(
          'Perioden är delvis uppmätt och delvis planerad, så summorna blandar verkligt utfall med plan.',
          'This period is part measured and part planned, so the totals mix real outturn with the plan.',
        )}`}
        {!fullyPriced && ` ${t(
          'Nord Pool publicerar bara ett dygn i taget, så resten av horisonten har inget marknadspris. Planeraren är inte blind där — den använder husets egen uppmätta priskurva — men kronorna ovan gäller bara de kvartar som har ett publicerat pris.',
          'Nord Pool publishes only a day at a time, so the rest of the horizon has no market price. The planner is not blind there — it uses this home\u2019s own measured price shape — but the kronor above cover only the quarters with a published price.',
        )}`}
      </p>
    </div>
  );
};

export default StoreDecisions;
