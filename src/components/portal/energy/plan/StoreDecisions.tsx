// The quarter ledger is the plan's audit surface. It renders evidence recorded
// by the optimiser; it never reconstructs explanations from final power flows.

import React from 'react';
import { Download, FileJson, Loader2 } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { PlannedSlot } from '@/lib/energy-shift/contracts';
import type { TimelineRange, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import type { PlanModel } from './usePlanModel';

const ACTIVE_W = 10;
const DEMAND_COLUMNS = 7;

type Allocation = PlannedSlot['decision']['store_allocations'][number];
type BatteryDecision = NonNullable<PlannedSlot['decision']['battery']>;

const rowId = (start: string) => `decision-row-${Date.parse(start)}`;
const kw = (watts: number) => `${(watts / 1_000).toFixed(2)} kW`;
const signedKw = (watts: number) => `${watts >= 0 ? '+' : '−'}${kw(Math.abs(watts))}`;
const price = (value: number | null) => value === null ? '—' : `${value.toFixed(3)} SEK/kWh`;
const money = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(3)} SEK`;

const state = (value: number, unit: string) => {
  if (unit === 'celsius') return `${value.toFixed(2)} °C`;
  if (unit === 'km') return `${value.toFixed(1)} km`;
  if (unit === 'kwh') return `${value.toFixed(2)} kWh`;
  return `${value.toFixed(2)} ${unit}`;
};

const csvCell = (value: unknown) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const HEADER = {
  quarter: 'border-r-2 border-rose-300 bg-rose-200/95 text-rose-950 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100',
  demand: 'border-r border-amber-300 bg-amber-200/95 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
  battery: 'border-r border-emerald-300 bg-emerald-200/95 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
  grid: 'border-r border-sky-300 bg-sky-200/95 text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100',
  prices: 'border-r border-violet-300 bg-violet-200/95 text-violet-950 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-100',
  replay: 'border-l-2 border-slate-300 bg-slate-200/95 text-slate-950 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
} as const;

const BODY = {
  quarter: 'border-r-2 border-rose-200 bg-rose-50/95 group-hover:bg-rose-100/90 dark:border-rose-900 dark:bg-rose-950/45 dark:group-hover:bg-rose-950/65',
  demand: 'border-r border-amber-200 bg-amber-50/65 group-hover:bg-amber-100/75 dark:border-amber-900 dark:bg-amber-950/25 dark:group-hover:bg-amber-950/45',
  battery: 'border-r border-emerald-200 bg-emerald-50/65 group-hover:bg-emerald-100/75 dark:border-emerald-900 dark:bg-emerald-950/25 dark:group-hover:bg-emerald-950/45',
  grid: 'border-r border-sky-200 bg-sky-50/70 group-hover:bg-sky-100/80 dark:border-sky-900 dark:bg-sky-950/25 dark:group-hover:bg-sky-950/45',
  prices: 'border-r border-violet-200 bg-violet-50/60 group-hover:bg-violet-100/75 dark:border-violet-900 dark:bg-violet-950/25 dark:group-hover:bg-violet-950/45',
  replay: 'border-l-2 border-slate-200 bg-slate-50/95 group-hover:bg-slate-100/90 dark:border-slate-800 dark:bg-slate-950/90 dark:group-hover:bg-slate-900',
} as const;

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
  const { toast } = useToast();
  const [openItem, setOpenItem] = React.useState<string>('sequence');
  const [replayLoading, setReplayLoading] = React.useState<string | null>(null);
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
  const hasEvidence = typeof diagnosticsVersion === 'number' && diagnosticsVersion >= 1 && inWindow.every(slot =>
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
    if (allocation.solar_w > ACTIVE_W) sources.push(`${kw(allocation.solar_w)} ${t('sol', 'solar')}`);
    if (allocation.grid_w > ACTIVE_W) sources.push(`${kw(allocation.grid_w)} ${t('nät', 'grid')}`);
    return sources.join(' + ') || '—';
  };

  const batteryReason = (decision: BatteryDecision) => {
    switch (decision.reason) {
      case 'profitable_charge': return t('Lagrat värde översteg kostnaden', 'Stored value exceeded source cost');
      case 'profitable_discharge': return t('Undviken nätkostnad översteg behållet värde', 'Avoided grid cost exceeded retained value');
      case 'retained_value_exceeds_import': return t('Behållet värde översteg undviken import', 'Retained value exceeded avoided import');
      case 'charge_value_below_export': return t('Exportvärdet översteg lagringsvärdet', 'Export value exceeded stored value');
      case 'state_floor': return t('Nedre tillståndsgräns', 'Lower state bound');
      case 'state_ceiling': return t('Övre tillståndsgräns', 'Upper state bound');
      case 'future_state_constraint': return t('Senare tillståndsgräns', 'Later state constraint');
      case 'load_added_after_dispatch': return t('Last tillkom efter batteribeslutet', 'Load added after battery decision');
      case 'balanced': return t('Ingen återstående handel', 'No remaining trade');
    }
  };

  const batteryAction = (decision: BatteryDecision) => {
    if (decision.action === 'charge') return t('Ladda', 'Charge');
    if (decision.action === 'discharge') return t('Ladda ur', 'Discharge');
    return t('Behåll', 'Hold');
  };

  const batteryComparison = (decision: BatteryDecision) => {
    if (decision.action === 'charge' || decision.reason === 'charge_value_below_export') {
      return t('Källkostnad/exportvärde', 'Source cost/export value');
    }
    return t('Undviken import/försäljning', 'Avoided import/sale');
  };

  const batteryRoute = (allocation: Allocation | undefined) => {
    if (!allocation) return '—';
    if (allocation.direction === 'charge') return sourceText(allocation);
    if (allocation.discharge_destination === 'export') return t('Till export', 'To export');
    if (allocation.discharge_destination === 'mixed') return t('Till last + export', 'To load + export');
    return t('Till husets last', 'To home demand');
  };

  const exportCsv = () => {
    const headers = [
      'quarter_start', 'quarter_local',
      'store', 'allocation_direction', 'allocation_trigger', 'allocation_power_kw', 'allocation_energy_kwh',
      'allocation_state_before', 'allocation_state_after', 'allocation_state_unit',
      'curve_value_sek_per_kwh', 'retention_pct', 'energy_cost_sek_per_kwh',
      'wear_cost_sek_per_kwh', 'start_cost_sek', 'source_solar_kw', 'source_grid_kw',
      'allocation_net_value_sek', 'allocation_order', 'run_start_index', 'run_slots', 'run_net_value_sek',
      'battery_action', 'battery_reason', 'battery_power_kw', 'battery_comparison_power_kw',
      'battery_state_before', 'battery_state_after', 'battery_state_unit',
      'battery_comparison_price_sek_per_kwh', 'battery_stored_value_sek_per_kwh',
      'battery_wear_cost_sek_per_kwh', 'battery_net_value_sek', 'battery_route',
      'grid_demand_kw', 'grid_battery_charge_kw', 'grid_battery_discharge_kw', 'grid_solar_kw',
      'grid_residual_kw', 'grid_direction', 'grid_power_kw', 'grid_limit_kw', 'grid_limit_binding',
      'unserved_kw', 'curtailed_kw', 'all_in_import_price_sek_per_kwh', 'import_price_basis',
      'all_in_export_price_sek_per_kwh', 'export_price_basis',
    ];
    const records = inWindow.flatMap(slot => {
      const plannedSlot = slot as PlannedSlot;
      const allocations = plannedSlot.decision.store_allocations;
      const demandAllocations = allocations.filter(allocation => allocation.store_key !== 'battery');
      const displayedAllocations: (Allocation | null)[] = demandAllocations.length > 0
        ? demandAllocations
        : [null];
      const batteryAllocation = allocations.find(allocation => allocation.store_key === 'battery');
      const battery = plannedSlot.decision.battery;
      const balance = plannedSlot.decision.grid_balance;
      return displayedAllocations.map(allocation => [
        slot.start,
        new Date(slot.start).toLocaleString(),
        allocation ? storeLabel(allocation.store_key) : '',
        allocation?.direction,
        allocation?.trigger,
        allocation ? allocation.power_w / 1_000 : null,
        allocation ? allocation.power_w / 4_000 : null,
        allocation?.state_before,
        allocation?.state_after,
        allocation?.state_unit,
        allocation?.average_value_sek_per_kwh,
        allocation ? allocation.retention_factor * 100 : null,
        allocation?.energy_cost_sek_per_kwh,
        allocation?.wear_cost_sek_per_kwh,
        allocation?.start_cost_sek,
        allocation ? allocation.solar_w / 1_000 : null,
        allocation ? allocation.grid_w / 1_000 : null,
        allocation?.net_value_sek,
        allocation?.allocation_order,
        allocation?.run_start_index,
        allocation?.run_slots,
        allocation?.run_net_value_sek,
        battery?.action,
        battery?.reason,
        battery ? battery.power_w / 1_000 : null,
        battery ? battery.comparison_power_w / 1_000 : null,
        battery?.state_before,
        battery?.state_after,
        battery?.state_unit,
        battery?.comparison_price_sek_per_kwh,
        battery?.stored_value_sek_per_kwh,
        battery?.wear_cost_sek_per_kwh,
        battery?.net_value_sek,
        batteryRoute(batteryAllocation),
        balance.load_w / 1_000,
        balance.battery_charge_w / 1_000,
        balance.battery_discharge_w / 1_000,
        balance.pv_w / 1_000,
        balance.residual_w / 1_000,
        balance.direction,
        balance.power_w / 1_000,
        balance.limit_w / 1_000,
        balance.limit_binding,
        slot.unserved_w / 1_000,
        slot.curtailed_w / 1_000,
        slot.shadow_import_sek_per_kwh,
        slot.import_price_sek_per_kwh === null ? 'modelled' : 'published',
        slot.shadow_export_sek_per_kwh,
        slot.export_price_sek_per_kwh === null ? 'modelled' : 'published',
      ]);
    });
    const csv = [headers, ...records].map(record => record.map(csvCell).join(',')).join('\r\n');
    const first = inWindow[0]?.start.slice(0, 10) ?? 'plan';
    const last = inWindow.at(-1)?.start.slice(0, 10) ?? first;
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `plan-decisions-${first}-to-${last}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const canReplay = Boolean(
    model.current.home_id &&
    model.current.generation_request_id &&
    Array.isArray(model.plan.price_outlook.shadow_import_sek_per_kwh) &&
    model.plan.price_outlook.shadow_import_sek_per_kwh.length === model.active.slots.length,
  );

  const downloadReplay = async (slot: PlannedSlot, slotIndex: number) => {
    if (!model.current.home_id || !model.current.generation_request_id || !canReplay) return;
    setReplayLoading(slot.start);
    try {
      // Snapshot is deliberately lazy: it and the plan are the two large JSON
      // values, and the workspace otherwise polls every 30 seconds.
      const { data, error } = await supabase
        .from('energy_optimisation_current')
        .select('snapshot, input_hash, plan_id')
        .eq('home_id', model.current.home_id)
        .eq('plan_id', model.plan.plan_id)
        .eq('generation_request_id', model.current.generation_request_id)
        .maybeSingle();
      if (error || !data?.snapshot) {
        throw new Error(error?.message ?? t(
          'Planen ersattes innan replaydata kunde hämtas.',
          'The plan was replaced before its replay data could be fetched.',
        ));
      }
      const { thermal_projection: thermalProjection, ...plannerOutput } = model.plan;
      const bundle = {
        format: 'shs-energy-optimisation-quarter-replay',
        schema_version: 1,
        entrypoint: {
          module: 'supabase/functions/_shared/energy-optimisation.ts',
          export: 'generateOptimisationPlan',
          argument_order: ['snapshot', 'now', 'price_archive', 'resolved_price_outlook'],
          invocation: 'generateOptimisationPlan(arguments.snapshot, new Date(arguments.now), arguments.price_archive, arguments.resolved_price_outlook)',
          arguments: {
            snapshot: data.snapshot,
            now: model.plan.issued_at,
            price_archive: [],
            resolved_price_outlook: model.plan.price_outlook,
          },
        },
        input_hash: data.input_hash,
        generation_request_id: model.current.generation_request_id,
        selection: {
          scenario: model.active.key,
          quarter_index: slotIndex,
          quarter_start: slot.start,
        },
        expected: {
          planner_output: plannerOutput,
          thermal_projection: thermalProjection ?? null,
          selected_quarter: slot,
        },
      };
      const url = URL.createObjectURL(new Blob(
        [`${JSON.stringify(bundle, null, 2)}\n`],
        { type: 'application/json;charset=utf-8' },
      ));
      const link = document.createElement('a');
      link.href = url;
      link.download = `plan-replay-${model.plan.plan_id}-${slot.start.replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: t('Kunde inte skapa replayfilen', 'Could not create replay file'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setReplayLoading(null);
    }
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
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {inWindow.length} {t('kvartar i vald period', 'quarters in selected period')}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('Exportera CSV', 'Export CSV')}
                </Button>
              </div>
              <div className="[&>div]:max-h-[46rem] [&>div]:overscroll-contain [&>div]:rounded-md [&>div]:border">
                <Table className="min-w-[2720px] border-separate border-spacing-0 text-xs">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead
                        rowSpan={2}
                        scope="col"
                        className={`sticky left-0 top-0 z-40 h-20 min-w-[150px] align-middle font-semibold ${HEADER.quarter}`}
                      >
                        {t('Kvart', 'Quarter')}
                      </TableHead>
                      <TableHead colSpan={DEMAND_COLUMNS} scope="colgroup" className={`sticky top-0 z-30 h-9 px-3 font-semibold ${HEADER.demand}`}>
                        {t('Beslut från efterfrågekurvor', 'Demand-value curve decisions')}
                      </TableHead>
                      <TableHead colSpan={5} scope="colgroup" className={`sticky top-0 z-30 h-9 px-3 font-semibold ${HEADER.battery}`}>
                        {t('Hembatteriets beslut', 'Home-battery decision')}
                      </TableHead>
                      <TableHead colSpan={4} scope="colgroup" className={`sticky top-0 z-30 h-9 px-3 font-semibold ${HEADER.grid}`}>
                        {t('Exakt nätbalans', 'Exact grid balance')}
                      </TableHead>
                      <TableHead colSpan={2} scope="colgroup" className={`sticky top-0 z-30 h-9 px-3 font-semibold ${HEADER.prices}`}>
                        {t('Totalpriser', 'All-in prices')}
                      </TableHead>
                      <TableHead
                        rowSpan={2}
                        scope="col"
                        className={`sticky right-0 top-0 z-40 h-20 min-w-[110px] align-middle font-semibold ${HEADER.replay}`}
                      >
                        {t('Repris', 'Replay')}
                      </TableHead>
                    </TableRow>
                    <TableRow className="hover:bg-transparent">
                      {[
                        t('Lager', 'Store'),
                        t('Energi', 'Energy'),
                        t('Auktionstillstånd', 'Auction state'),
                        t('Kurvvärde', 'Curve value'),
                        t('Total kostnad', 'All-in cost'),
                        t('Källa', 'Source'),
                        t('Nettovärde', 'Net value'),
                      ].map((label, index) => (
                        <TableHead
                          key={label}
                          scope="col"
                          className={`sticky top-9 z-30 h-11 whitespace-normal px-2 py-1.5 text-[11px] font-semibold leading-tight ${HEADER.demand} ${index === 2 ? 'min-w-[170px]' : 'min-w-[120px]'}`}
                        >
                          {label}
                        </TableHead>
                      ))}
                      {[
                        t('Åtgärd', 'Action'),
                        t('Tillstånd', 'State'),
                        t('Marknadsjämförelse', 'Market comparison'),
                        t('Lagrat värde', 'Stored value'),
                        t('Netto / orsak', 'Net / reason'),
                      ].map((label, index) => (
                        <TableHead
                          key={label}
                          scope="col"
                          className={`sticky top-9 z-30 h-11 whitespace-normal px-2 py-1.5 text-[11px] font-semibold leading-tight ${HEADER.battery} ${index === 4 ? 'min-w-[190px]' : 'min-w-[145px]'}`}
                        >
                          {label}
                        </TableHead>
                      ))}
                      {[
                        t('Efterfrågan', 'Demand'),
                        t('Batteri', 'Battery'),
                        t('Sol', 'Solar'),
                        t('Nätresultat', 'Grid result'),
                      ].map((label, index) => (
                        <TableHead
                          key={label}
                          scope="col"
                          className={`sticky top-9 z-30 h-11 whitespace-normal px-2 py-1.5 text-[11px] font-semibold leading-tight ${HEADER.grid} ${index === 3 ? 'min-w-[150px]' : 'min-w-[100px]'}`}
                        >
                          {label}
                        </TableHead>
                      ))}
                      {[t('Köp', 'Buy'), t('Sälj', 'Sell')].map(label => (
                        <TableHead
                          key={label}
                          scope="col"
                          className={`sticky top-9 z-30 h-11 min-w-[130px] whitespace-normal px-2 py-1.5 text-[11px] font-semibold leading-tight ${HEADER.prices}`}
                        >
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inWindow.flatMap(slot => {
                      const plannedSlot = slot as PlannedSlot;
                      const slotIndex = indexByStart.get(Date.parse(slot.start)) ?? 0;
                      const allocations = plannedSlot.decision.store_allocations;
                      const demandAllocations = allocations.filter(allocation => allocation.store_key !== 'battery');
                      const displayedAllocations: (Allocation | null)[] = demandAllocations.length > 0
                        ? demandAllocations
                        : [null];
                      const rowSpan = displayedAllocations.length;
                      const batteryAllocation = allocations.find(allocation => allocation.store_key === 'battery');
                      const battery = plannedSlot.decision.battery;
                      const balance = plannedSlot.decision.grid_balance;
                      const selected = selectedMs === Date.parse(slot.start);
                      const hasLateLoad = battery?.reason === 'load_added_after_dispatch';

                      return displayedAllocations.map((allocation, allocationIndex) => {
                        const firstAllocation = allocationIndex === 0;
                        const runQuarter = allocation
                          ? slotIndex - allocation.run_start_index + 1
                          : 0;
                        const rowClass = [
                          'group',
                          firstAllocation ? 'border-t-2 border-t-border' : '',
                          selected ? 'outline outline-2 -outline-offset-2 outline-sky-500' : '',
                          onSelectedStartChange ? 'cursor-pointer' : '',
                        ].filter(Boolean).join(' ');

                        return (
                          <TableRow
                            id={firstAllocation ? rowId(slot.start) : undefined}
                            key={`${slot.start}:${allocation?.store_key ?? 'none'}:${allocation?.allocation_order ?? 0}`}
                            aria-current={selected || undefined}
                            data-state={selected ? 'selected' : undefined}
                            onClick={() => onSelectedStartChange?.(slot.start)}
                            className={rowClass}
                          >
                            {firstAllocation && (
                              <TableCell
                                rowSpan={rowSpan}
                                className={`sticky left-0 z-10 whitespace-nowrap p-2 align-top font-medium tabular-nums ${BODY.quarter}`}
                              >
                                {new Date(slot.start).toLocaleString([], {
                                  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                                })}
                              </TableCell>
                            )}
                            {allocation ? (
                              <>
                                <TableCell className={`p-2 align-top ${BODY.demand}`}>
                                  <div className="font-semibold text-foreground">{storeLabel(allocation.store_key)}</div>
                                  <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
                                    {allocation.trigger === 'minimum_run_continuation'
                                      ? t('Fortsatt minimikörning', 'Minimum-run continuation')
                                      : t('Accepterat bud', 'Accepted bid')}
                                  </div>
                                </TableCell>
                                <TableCell className={`p-2 align-top tabular-nums ${BODY.demand}`}>
                                  <div className="font-semibold">{(allocation.power_w / 4_000).toFixed(2)} kWh</div>
                                  <div className="text-muted-foreground">{kw(allocation.power_w)}</div>
                                </TableCell>
                                <TableCell className={`p-2 align-top tabular-nums ${BODY.demand}`}>
                                  <div>{state(allocation.state_before, allocation.state_unit)}</div>
                                  <div className="text-muted-foreground">→ {state(allocation.state_after, allocation.state_unit)}</div>
                                </TableCell>
                                <TableCell className={`p-2 align-top tabular-nums ${BODY.demand}`}>
                                  <div className="font-semibold">{price(allocation.average_value_sek_per_kwh)}</div>
                                  <div className="text-muted-foreground">{(allocation.retention_factor * 100).toFixed(1)}% {t('behållet', 'retained')}</div>
                                </TableCell>
                                <TableCell className={`p-2 align-top tabular-nums ${BODY.demand}`}>
                                  <div className="font-semibold">{price(allocation.energy_cost_sek_per_kwh)}</div>
                                  {allocation.wear_cost_sek_per_kwh > 0 && <div className="text-muted-foreground">+ {allocation.wear_cost_sek_per_kwh.toFixed(3)} {t('slitage', 'wear')}</div>}
                                  {allocation.start_cost_sek > 0 && <div className="text-muted-foreground">+ {allocation.start_cost_sek.toFixed(3)} SEK {t('start', 'start')}</div>}
                                </TableCell>
                                <TableCell className={`p-2 align-top tabular-nums ${BODY.demand}`}>
                                  {sourceText(allocation)}
                                </TableCell>
                                <TableCell className={`p-2 align-top tabular-nums ${BODY.demand}`}>
                                  <div className={allocation.net_value_sek >= 0 ? 'font-semibold text-emerald-700 dark:text-emerald-400' : 'font-semibold text-destructive'}>
                                    {money(allocation.net_value_sek)}
                                  </div>
                                  <div className="text-muted-foreground">#{allocation.allocation_order}</div>
                                  {allocation.run_slots > 1 && (
                                    <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
                                      {t('Körning', 'Run')} {runQuarter}/{allocation.run_slots} · {money(allocation.run_net_value_sek)}
                                    </div>
                                  )}
                                </TableCell>
                              </>
                            ) : (
                              <TableCell colSpan={DEMAND_COLUMNS} className={`p-2 text-muted-foreground ${BODY.demand}`}>
                                {t('Ingen pool- eller billaddning accepterades.', 'No Pool or EV allocation was accepted.')}
                              </TableCell>
                            )}

                            {firstAllocation && (
                              <>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top ${BODY.battery}`}>
                                  {battery ? (
                                    <>
                                      <div className="font-semibold text-foreground">{batteryAction(battery)} {battery.action === 'hold' ? '' : kw(battery.power_w)}</div>
                                      {battery.action === 'hold' && battery.comparison_power_w > ACTIVE_W && (
                                        <div className="text-muted-foreground">{t('Test', 'Test')} {kw(battery.comparison_power_w)}</div>
                                      )}
                                      <div className="mt-1 text-[10px] leading-tight text-muted-foreground">{batteryRoute(batteryAllocation)}</div>
                                    </>
                                  ) : '—'}
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.battery}`}>
                                  {battery ? (
                                    <>
                                      <div>{state(battery.state_before, battery.state_unit)}</div>
                                      <div className="text-muted-foreground">→ {state(battery.state_after, battery.state_unit)}</div>
                                    </>
                                  ) : '—'}
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.battery}`}>
                                  {battery ? (
                                    <>
                                      <div className="font-semibold">{price(battery.comparison_price_sek_per_kwh)}</div>
                                      <div className="text-[10px] leading-tight text-muted-foreground">{batteryComparison(battery)}</div>
                                    </>
                                  ) : '—'}
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.battery}`}>
                                  {battery ? (
                                    <>
                                      <div className="font-semibold">{price(battery.stored_value_sek_per_kwh)}</div>
                                      {battery.wear_cost_sek_per_kwh > 0 && <div className="text-muted-foreground">+ {battery.wear_cost_sek_per_kwh.toFixed(3)} {t('slitage', 'wear')}</div>}
                                    </>
                                  ) : '—'}
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.battery}`}>
                                  {battery ? (
                                    <>
                                      <div className={battery.net_value_sek === null
                                        ? 'font-semibold'
                                        : battery.net_value_sek >= 0
                                          ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                                          : 'font-semibold text-destructive'}>
                                        {battery.net_value_sek === null ? '—' : money(battery.net_value_sek)}
                                      </div>
                                      <div className={`mt-1 text-[10px] leading-tight ${hasLateLoad ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}`}>
                                        {batteryReason(battery)}
                                      </div>
                                    </>
                                  ) : t('Inget batteri', 'No battery')}
                                </TableCell>

                                <TableCell rowSpan={rowSpan} className={`p-2 align-top font-semibold tabular-nums ${BODY.grid}`}>
                                  +{kw(balance.load_w)}
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.grid}`}>
                                  {signedKw(balance.battery_charge_w - balance.battery_discharge_w)}
                                  <div className="text-[10px] leading-tight text-muted-foreground">+{t('laddning', 'charge')} / −{t('urladdning', 'discharge')}</div>
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.grid}`}>
                                  −{kw(balance.pv_w)}
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.grid}`}>
                                  <div className="font-semibold">{signedKw(balance.residual_w)}</div>
                                  <div className="text-muted-foreground">
                                    {balance.direction === 'import'
                                      ? t('import', 'import')
                                      : balance.direction === 'export'
                                        ? t('export', 'export')
                                        : t('balans', 'balanced')}
                                  </div>
                                  {balance.limit_binding && (
                                    <div className="mt-1 text-[10px] leading-tight text-destructive">
                                      {t('Gräns', 'Limit')} {kw(balance.limit_w)} · {slot.unserved_w > ACTIVE_W ? `${kw(slot.unserved_w)} ${t('ej levererat', 'unserved')}` : `${kw(slot.curtailed_w)} ${t('begränsat', 'curtailed')}`}
                                    </div>
                                  )}
                                </TableCell>

                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.prices}`}>
                                  <div className="font-semibold">{price(slot.shadow_import_sek_per_kwh)}</div>
                                  <div className="text-muted-foreground">{slot.import_price_sek_per_kwh === null ? t('modellerat', 'modelled') : t('publicerat', 'published')}</div>
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`p-2 align-top tabular-nums ${BODY.prices}`}>
                                  <div className="font-semibold">{price(slot.shadow_export_sek_per_kwh)}</div>
                                  <div className="text-muted-foreground">{slot.export_price_sek_per_kwh === null ? t('modellerat', 'modelled') : t('publicerat', 'published')}</div>
                                </TableCell>
                                <TableCell rowSpan={rowSpan} className={`sticky right-0 z-10 p-2 align-top ${BODY.replay}`}>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={!canReplay || replayLoading !== null}
                                    title={!canReplay
                                      ? t('Nästa plan kommer att innehålla exakta replaydata.', 'The next plan will contain exact replay data.')
                                      : t('Ladda ned alla indata och det förväntade resultatet.', 'Download every input and the expected result.')}
                                    aria-label={`${t('Ladda ned JSON-repris för', 'Download JSON replay for')} ${new Date(slot.start).toLocaleString()}`}
                                    onClick={event => {
                                      event.stopPropagation();
                                      void downloadReplay(plannedSlot, slotIndex);
                                    }}
                                  >
                                    {replayLoading === slot.start
                                      ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                      : <FileJson className="mr-1.5 h-4 w-4" />}
                                    JSON
                                  </Button>
                                </TableCell>
                              </>
                            )}
                          </TableRow>
                        );
                      });
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
};

export default StoreDecisions;
