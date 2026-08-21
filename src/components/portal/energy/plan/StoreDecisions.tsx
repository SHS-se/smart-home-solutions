// The quarter ledger is the plan's audit surface.
//
// It deliberately renders evidence recorded by the optimiser. Reconstructing
// a plausible explanation from final power flows produced confident but false
// prose whenever a later scheduling stage changed the load.

import React from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import type { PlannedSlot } from '@/lib/energy-shift/contracts';
import type { TimelineRange, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import type { PlanModel } from './usePlanModel';

const ACTIVE_W = 10;

type Allocation = PlannedSlot['decision']['store_allocations'][number];
type BatteryDecision = NonNullable<PlannedSlot['decision']['battery']>;

const rowId = (start: string) => `decision-row-${Date.parse(start)}`;
const kw = (watts: number) => `${(watts / 1_000).toFixed(2)} kW`;
const price = (value: number | null) => value === null ? '—' : `${value.toFixed(3)} SEK/kWh`;
const money = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(3)} SEK`;

const state = (value: number, unit: string) => {
  if (unit === 'celsius') return `${value.toFixed(2)} °C`;
  if (unit === 'km') return `${value.toFixed(1)} km`;
  if (unit === 'kwh') return `${value.toFixed(2)} kWh`;
  return `${value.toFixed(2)} ${unit}`;
};

const StoreDecisions: React.FC<{
  model: PlanModel;
  /** The same timeline window the chart above is showing, so the two agree. */
  rows: TimelineRow[];
  range: TimelineRange;
  /** A chart click selects the exact planned quarter represented by this row. */
  selectedStart?: string | null;
  selectionRequest?: number;
  onSelectedStartChange?: (start: string) => void;
}> = ({ model, rows: timeline, range, selectedStart, selectionRequest, onSelectedStartChange }) => {
  const { t } = useLanguage();
  const [openItem, setOpenItem] = React.useState<string>('');
  const windowRows = React.useMemo(
    () => timeline.slice(range.from, range.to),
    [range.from, range.to, timeline],
  );
  const inWindow = React.useMemo(() => {
    const first = windowRows[0]?.startMs;
    const last = windowRows.at(-1)?.startMs;
    if (first === undefined || last === undefined) return [];
    return model.active.slots.filter(slot => {
      const at = Date.parse(slot.start);
      return at >= first && at <= last;
    });
  }, [model.active.slots, windowRows]);
  const indexByStart = React.useMemo(
    () => new Map(model.active.slots.map((slot, index) => [Date.parse(slot.start), index])),
    [model.active.slots],
  );
  const selectedMs = selectedStart ? Date.parse(selectedStart) : null;
  const diagnosticsVersion = (model.plan as { decision_diagnostics_version?: number })
    .decision_diagnostics_version;
  const hasEvidence = diagnosticsVersion === 1 && inWindow.every(slot =>
    (slot as PlannedSlot & { decision?: PlannedSlot['decision'] }).decision?.schema_version === 1);

  React.useEffect(() => {
    if (!selectedStart || !inWindow.some(slot => Date.parse(slot.start) === selectedMs)) return;
    setOpenItem('sequence');
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        document.getElementById(rowId(selectedStart))?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [inWindow, selectedMs, selectedStart, selectionRequest]);

  const storeLabel = (key: string) => {
    if (key === 'pool') return t('Pool', 'Pool');
    if (key === 'ev') return model.plan.ev_battery?.name ?? t('Bil', 'EV');
    if (key === 'battery') return t('Hembatteri', 'Home battery');
    return key.replace(/_/g, ' ');
  };

  const sourceText = (allocation: Allocation) => {
    const sources: string[] = [];
    if (allocation.solar_w > ACTIVE_W) {
      sources.push(`${kw(allocation.solar_w)} ${t('sol', 'solar')}`);
    }
    if (allocation.grid_w > ACTIVE_W) {
      sources.push(`${kw(allocation.grid_w)} ${t('nät', 'grid')}`);
    }
    return sources.join(' + ');
  };

  const demandDecision = (allocation: Allocation, slotIndex: number) => {
    const moveKwh = allocation.power_w / 4_000;
    const runQuarter = slotIndex - allocation.run_start_index + 1;
    const runText = allocation.run_slots > 1
      ? allocation.trigger === 'minimum_run_continuation'
        ? t(
          `Obligatorisk kvart ${runQuarter} av ${allocation.run_slots} i minimikörningen; hela körningen gav ${money(allocation.run_net_value_sek)}.`,
          `Required quarter ${runQuarter} of ${allocation.run_slots} in the minimum run; the complete run returned ${money(allocation.run_net_value_sek)}.`,
        )
        : t(
          `Startar en minimikörning på ${allocation.run_slots} kvart; hela körningen gav ${money(allocation.run_net_value_sek)}.`,
          `Starts a ${allocation.run_slots}-quarter minimum run; the complete run returned ${money(allocation.run_net_value_sek)}.`,
        )
      : '';
    const source = sourceText(allocation);
    return (
      <div key={`${allocation.store_key}:${allocation.direction}:${allocation.allocation_order}`} className="space-y-1">
        <div className="font-medium">
          {storeLabel(allocation.store_key)} · {kw(allocation.power_w)} · {moveKwh.toFixed(2)} kWh
        </div>
        <div>
          {t('Auktionstillstånd', 'Auction state')}: {state(allocation.state_before, allocation.state_unit)} → {state(allocation.state_after, allocation.state_unit)}
        </div>
        <div>
          {t('Kurvintegral efter tidsförlust', 'Curve integral after timing loss')}{' '}
          <span className="font-medium text-foreground">{price(allocation.average_value_sek_per_kwh)}</span>
          {' '}({(allocation.retention_factor * 100).toFixed(1)}% {t('kvar vid användning', 'retained at use')})
          {' '}{t('mot total energikostnad', 'versus all-in energy cost')}{' '}
          <span className="font-medium text-foreground">{price(allocation.energy_cost_sek_per_kwh)}</span>
          {allocation.wear_cost_sek_per_kwh > 0
            ? ` + ${price(allocation.wear_cost_sek_per_kwh)} ${t('slitage', 'wear')}`
            : ''}.
        </div>
        {allocation.start_cost_sek > 0 && (
          <div>{t('Startkostnadsandel', 'Start-cost share')}: {allocation.start_cost_sek.toFixed(3)} SEK.</div>
        )}
        {source && <div>{t('Källa', 'Source')}: {source}.</div>}
        <div>
          {t('Nettovärde för kvarten', 'Quarter net value')}{' '}
          <span className={allocation.net_value_sek >= 0 ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'font-medium text-destructive'}>
            {money(allocation.net_value_sek)}
          </span>
          {' '}· {t('allokeringsordning', 'allocation order')} #{allocation.allocation_order}.
        </div>
        {runText && <div className="font-medium text-foreground">{runText}</div>}
      </div>
    );
  };

  const batteryText = (
    decision: BatteryDecision | null,
    allocation: Allocation | undefined,
  ) => {
    if (!decision) return <span className="text-muted-foreground">{t('Inget hembatteri i planen.', 'No home battery in this plan.')}</span>;
    const comparedPower = kw(decision.comparison_power_w);
    const beforeAfter = `${state(decision.state_before, decision.state_unit)} → ${state(decision.state_after, decision.state_unit)}`;
    const net = decision.net_value_sek === null ? null : money(decision.net_value_sek);

    if (decision.action === 'charge') {
      const source = allocation ? sourceText(allocation) : '';
      return (
        <div className="space-y-1">
          <div className="font-medium">{t('Ladda', 'Charge')} {kw(decision.power_w)} · {beforeAfter}</div>
          <div>{t('Lagrad kurvvärde', 'Stored curve value')} {price(decision.stored_value_sek_per_kwh)} {t('mot energikostnad', 'versus energy cost')} {price(decision.comparison_price_sek_per_kwh)}{decision.wear_cost_sek_per_kwh > 0 ? ` + ${price(decision.wear_cost_sek_per_kwh)} ${t('slitage', 'wear')}` : ''}.</div>
          {source && <div>{t('Källa', 'Source')}: {source}.</div>}
          {net && <div>{t('Nettovärde', 'Net value')} <span className="font-medium text-emerald-700 dark:text-emerald-400">{net}</span>.</div>}
        </div>
      );
    }
    if (decision.action === 'discharge') {
      const destination = allocation?.discharge_destination === 'export'
        ? t('export', 'export')
        : allocation?.discharge_destination === 'mixed'
          ? t('last och export', 'load and export')
          : t('husets last', 'home demand');
      return (
        <div className="space-y-1">
          <div className="font-medium">{t('Ladda ur', 'Discharge')} {kw(decision.power_w)} {t('till', 'to')} {destination} · {beforeAfter}</div>
          <div>{t('Undviken import/försäljning', 'Avoided import/sale')} {price(decision.comparison_price_sek_per_kwh)} {t('mot behållet kurvvärde', 'versus retained curve value')} {price(decision.stored_value_sek_per_kwh)}{decision.wear_cost_sek_per_kwh > 0 ? ` + ${price(decision.wear_cost_sek_per_kwh)} ${t('slitage', 'wear')}` : ''}.</div>
          {net && <div>{t('Nettovärde', 'Net value')} <span className="font-medium text-emerald-700 dark:text-emerald-400">{net}</span>.</div>}
        </div>
      );
    }

    if (decision.reason === 'retained_value_exceeds_import') {
      return (
        <div className="space-y-1">
          <div className="font-medium">{t('Behåll laddningen', 'Hold charge')} · {beforeAfter}</div>
          <div>{t(`Testade att ladda ur ${comparedPower}.`, `Tested discharging ${comparedPower}.`)} {t('Undviken import', 'Avoided import')} {price(decision.comparison_price_sek_per_kwh)} {t('var lägre än behållet kurvvärde', 'was below retained curve value')} {price(decision.stored_value_sek_per_kwh)}{decision.wear_cost_sek_per_kwh > 0 ? ` + ${price(decision.wear_cost_sek_per_kwh)} ${t('slitage', 'wear')}` : ''}. {net && `${t('Nettot för urladdning', 'Discharge net')} ${net}.`}</div>
        </div>
      );
    }
    if (decision.reason === 'charge_value_below_export') {
      return (
        <div className="space-y-1">
          <div className="font-medium">{t('Ladda inte', 'Do not charge')} · {beforeAfter}</div>
          <div>{t(`Testade att lagra ${comparedPower}.`, `Tested storing ${comparedPower}.`)} {t('Kurvvärde', 'Curve value')} {price(decision.stored_value_sek_per_kwh)} {t('var lägre än exportvärdet', 'was below export value')} {price(decision.comparison_price_sek_per_kwh)}{decision.wear_cost_sek_per_kwh > 0 ? ` + ${price(decision.wear_cost_sek_per_kwh)} ${t('slitage', 'wear')}` : ''}. {net && `${t('Nettot för laddning', 'Charge net')} ${net}.`}</div>
        </div>
      );
    }
    if (decision.reason === 'load_added_after_dispatch') {
      return (
        <div className="space-y-1 text-amber-800 dark:text-amber-300">
          <div className="font-medium">{t('Last tillkom efter batteriauktionen', 'Load was added after the battery auction')}</div>
          <div>{t(
            'Batteriet såg inget underskott när det fattade sitt beslut. Komfort- eller driftcykellast lades till senare, så den slutliga importen jämfördes aldrig mot urladdning. Detta är schemaläggningsordning, inte ett värdekurvebeslut.',
            'The battery saw no shortfall when it made its decision. Comfort or duty-cycle demand was added later, so the final import was never compared with discharge. This is scheduler ordering, not a value-curve decision.',
          )}</div>
        </div>
      );
    }
    if (decision.reason === 'state_floor' || decision.reason === 'state_ceiling') {
      return <span>{decision.reason === 'state_floor' ? t('Behåll: batteriet är vid sin nedre tillståndsgräns.', 'Hold: the battery is at its lower state limit.') : t('Behåll: batteriet är vid sin övre tillståndsgräns.', 'Hold: the battery is at its upper state limit.')} {beforeAfter}</span>;
    }
    if (decision.reason === 'future_state_constraint') {
      return <span>{t('Behåll: ett drag här skulle bryta en senare fysisk tillståndsgräns.', 'Hold: acting here would violate a later physical state bound.')} {beforeAfter}</span>;
    }
    return <span>{t('Ingen laddnings- eller urladdningsmöjlighet återstod efter lagringsauktionen.', 'No charge or discharge opportunity remained after the store auction.')} {beforeAfter}</span>;
  };

  const gridText = (slot: PlannedSlot) => {
    const balance = slot.decision.grid_balance;
    const signed = balance.residual_w >= 0 ? `+${kw(balance.residual_w)}` : `−${kw(Math.abs(balance.residual_w))}`;
    const result = balance.direction === 'import'
      ? `${t('Nätimport', 'Grid import')} ${kw(balance.power_w)}`
      : balance.direction === 'export'
        ? `${t('Nätexport', 'Grid export')} ${kw(balance.power_w)}`
        : t('Inget nätflöde', 'No grid flow');
    return (
      <div className="space-y-1 tabular-nums">
        <div>{t('Last', 'Demand')} {kw(balance.load_w)} + {t('batteriladdning', 'battery charge')} {kw(balance.battery_charge_w)}</div>
        <div>− {t('sol', 'solar')} {kw(balance.pv_w)} − {t('batteriurladdning', 'battery discharge')} {kw(balance.battery_discharge_w)}</div>
        <div className="font-medium">= {signed} · {result}</div>
        {balance.reason === 'import_limit' && <div className="text-destructive">{t(`Importgränsen ${kw(balance.limit_w)} binder; ${kw(slot.unserved_w)} kan inte levereras.`, `The ${kw(balance.limit_w)} import limit binds; ${kw(slot.unserved_w)} is unserved.`)}</div>}
        {balance.reason === 'export_limit' && <div className="text-amber-700 dark:text-amber-400">{t(`Exportgränsen ${kw(balance.limit_w)} binder; ${kw(slot.curtailed_w)} begränsas.`, `The ${kw(balance.limit_w)} export limit binds; ${kw(slot.curtailed_w)} is curtailed.`)}</div>}
      </div>
    );
  };

  if (inWindow.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'Den valda perioden ligger före den aktuella planen. Grafen visar uppmätta värden där, men planen har inga beslut för perioden.',
          'The selected period predates the current plan. The chart shows measurements there, but the plan has no decisions for this period.',
        )}
      </p>
    );
  }

  return (
    <Accordion type="single" collapsible value={openItem} onValueChange={setOpenItem} className="w-full">
      <AccordionItem value="sequence">
        <AccordionTrigger className="py-3 text-sm hover:no-underline">
          {t('Beslutsföljd per 15 minuter', '15-minute decision sequence')}
        </AccordionTrigger>
        <AccordionContent>
          {!hasEvidence ? (
            <div className="rounded-md border border-amber-300 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-200">
              {t(
                'Den här äldre planen innehåller inte versionsstyrda beslutsbevis. Portalen kommer inte att gissa en förklaring; invänta nästa plan från marginal-value-planner-v11.',
                'This older plan does not contain versioned decision evidence. The portal will not guess an explanation; wait for the next marginal-value-planner-v11 plan.',
              )}
            </div>
          ) : (
            <div className="[&>div]:max-h-[42rem] [&>div]:rounded-md [&>div]:border">
              <Table className="min-w-[1450px]">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>{t('Kvart', 'Quarter')}</TableHead>
                    <TableHead className="min-w-[390px]">{t('Beslut från efterfrågekurvor', 'Demand-value curve decisions')}</TableHead>
                    <TableHead className="min-w-[390px]">{t('Hembatteriets beslut', 'Home-battery decision')}</TableHead>
                    <TableHead className="min-w-[330px]">{t('Exakt nätbalans', 'Exact grid balance')}</TableHead>
                    <TableHead>{t('Totalpriser', 'All-in prices')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inWindow.map(slot => {
                    const plannedSlot = slot as PlannedSlot;
                    const slotIndex = indexByStart.get(Date.parse(slot.start)) ?? 0;
                    const allocations = plannedSlot.decision.store_allocations;
                    const demandAllocations = allocations.filter(allocation => allocation.store_key !== 'battery');
                    const batteryAllocation = allocations.find(allocation => allocation.store_key === 'battery');
                    const selected = selectedMs === Date.parse(slot.start);
                    const hasLateLoad = plannedSlot.decision.battery?.reason === 'load_added_after_dispatch';
                    return (
                      <TableRow
                        id={rowId(slot.start)}
                        key={slot.start}
                        aria-current={selected || undefined}
                        onClick={() => onSelectedStartChange?.(slot.start)}
                        className={selected
                          ? 'bg-sky-100/80 ring-1 ring-inset ring-sky-500 dark:bg-sky-950/40'
                          : hasLateLoad
                            ? 'bg-amber-50/60 dark:bg-amber-950/20'
                            : onSelectedStartChange
                              ? 'cursor-pointer'
                              : undefined}
                      >
                        <TableCell className="whitespace-nowrap align-top tabular-nums">
                          {new Date(slot.start).toLocaleString([], {
                            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                          })}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {demandAllocations.length > 0
                            ? <div className="space-y-3">{demandAllocations.map(allocation => demandDecision(allocation, slotIndex))}</div>
                            : <span>{t('Ingen pool- eller billaddning vann en kurv–kostnadsjämförelse denna kvart.', 'No pool or EV allocation cleared its curve-versus-cost comparison this quarter.')}</span>}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {batteryText(plannedSlot.decision.battery, batteryAllocation)}
                        </TableCell>
                        <TableCell className="align-top text-xs">{gridText(plannedSlot)}</TableCell>
                        <TableCell className="whitespace-nowrap align-top text-xs tabular-nums">
                          <span className="block">{t('Köp', 'Buy')} {price(slot.shadow_import_sek_per_kwh)}</span>
                          <span className="block">{t('Sälj', 'Sell')} {price(slot.shadow_export_sek_per_kwh)}</span>
                          <span className="block text-muted-foreground">
                            {slot.import_price_sek_per_kwh !== null && slot.export_price_sek_per_kwh !== null
                              ? t('publicerat', 'published')
                              : t('modellerat', 'modelled')}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
};

export default StoreDecisions;
