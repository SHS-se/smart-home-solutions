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
 * The stores explain what the house *kept*; this explains what it bought and
 * sold, which is the other half of the same decision. Every export is energy no
 * store bid above the price it earned, so the export price is the floor a bid
 * has to clear before keeping a kWh beats selling it — the comparison that
 * makes "why was 28 kWh exported" answerable at all.
 */
function gridFlows(slots: PlanModel['executed']['slots']): {
  imported: GridFlow;
  exported: GridFlow;
  curtailedKwh: number;
  fullyPriced: boolean;
} {
  const empty = (): GridFlow => ({ kwh: 0, pricedKwh: 0, sek: 0, averageSekPerKwh: null });
  const imported = empty();
  const exported = empty();
  let curtailedKwh = 0;
  let unpriced = 0;
  for (const slot of slots) {
    const inKwh = slot.grid_import_w / 4_000;
    const outKwh = slot.grid_export_w / 4_000;
    imported.kwh += inKwh;
    exported.kwh += outKwh;
    curtailedKwh += slot.curtailed_w / 4_000;
    if (slot.import_cost_sek !== null && typeof slot.import_price_sek_per_kwh === 'number') {
      imported.pricedKwh += inKwh;
      imported.sek += slot.import_cost_sek;
    } else if (inKwh > 0) unpriced += 1;
    if (slot.export_revenue_sek !== null && typeof slot.export_price_sek_per_kwh === 'number') {
      exported.pricedKwh += outKwh;
      exported.sek += slot.export_revenue_sek;
    } else if (outKwh > 0) unpriced += 1;
  }
  for (const flow of [imported, exported]) {
    flow.averageSekPerKwh = flow.pricedKwh > 0.0001 ? flow.sek / flow.pricedKwh : null;
  }
  return { imported, exported, curtailedKwh, fullyPriced: unpriced === 0 };
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

const StoreDecisions: React.FC<{ model: PlanModel }> = ({ model }) => {
  const { t, language } = useLanguage();
  const rows = (model.executed.store_diagnostics ?? []) as Row[];
  const grid = gridFlows(model.executed.slots);

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
                  {row.planned_kwh > 0 ? `${row.planned_kwh.toFixed(1)} kWh` : '—'}
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
  const { imported, exported, curtailedKwh, fullyPriced } = grid;
  const priceOf = (flow: GridFlow) =>
    flow.averageSekPerKwh === null
      ? t('inget publicerat pris', 'no published price')
      : `${flow.averageSekPerKwh.toFixed(2)} SEK/kWh ${t('i snitt', 'average')}`;

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <h4 className="text-sm font-medium">{t('Och nätet', 'And the grid')}</h4>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="w-14 shrink-0 text-muted-foreground">{t('Köpt', 'Bought')}</dt>
          <dd className="tabular-nums">
            {imported.kwh.toFixed(1)} kWh · {priceOf(imported)}
            {imported.averageSekPerKwh !== null && ` · ${imported.sek.toFixed(2)} SEK`}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="w-14 shrink-0 text-muted-foreground">{t('Sålt', 'Sold')}</dt>
          <dd className="tabular-nums">
            {exported.kwh.toFixed(1)} kWh · {priceOf(exported)}
            {exported.averageSekPerKwh !== null &&
              ` · ${t('gav', 'earned')} ${exported.sek.toFixed(2)} SEK`}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {exported.kwh > 0.05 && exported.averageSekPerKwh !== null
          ? t(
            `Allt som säljs är energi ingen lagring bjöd över ${exported.averageSekPerKwh.toFixed(2)} SEK/kWh för. Säljpriset är alltså golvet varje bud måste klara innan det lönar sig att behålla en kWh i stället för att sälja den — solel är inte gratis så länge den kan säljas.`,
            `Everything sold is energy no store bid above ${exported.averageSekPerKwh.toFixed(2)} SEK/kWh for. The export price is therefore the floor every bid must clear before keeping a kWh beats selling it — solar is not free while it can be sold.`,
          )
          : t(
            'Ingenting exporterades: varje kWh gick till huset eller till en lagring som värderade den högre än nätet.',
            'Nothing was exported: every kWh went to the house or to a store that valued it above what the grid would pay.',
          )}
        {curtailedKwh > 0.05 && ` ${t(
          `${curtailedKwh.toFixed(1)} kWh kapades — mer överskott än vad exportgränsen släpper igenom.`,
          `${curtailedKwh.toFixed(1)} kWh was curtailed: more surplus than the export limit allows through.`,
        )}`}
        {!fullyPriced && ` ${t(
          'Snittpriserna gäller bara de kvartar som har publicerat pris; resten av horisonten planeras mot den modellerade priskurvan.',
          'The averages cover only the quarters with a published price; the rest of the horizon is planned against the modelled price shape.',
        )}`}
      </p>
    </div>
  );
};

export default StoreDecisions;
