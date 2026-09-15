// One continuous chart: measured history to the left of now, plan to the right.
//
// History and the plan were separate tabs with separate windows, so "today"
// existed in neither. They are the same quantities on the same grid; the only
// difference is which side of now they fall on.
//
// The chart itself is five panels sharing one time axis (PlanPanels). It
// replaced a single plot that carried kilowatts, per cent and SEK/kWh against
// three y-axes, with nineteen device meters stacked underneath in a palette of
// eight cycled colours. Both problems were structural rather than cosmetic:
// nothing said which axis a curve belonged to, and no band in that stack could
// be looked up.

import React, { useMemo, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  attributeEnergy,
  type SupplySlotInput,
} from '@/lib/energy-shift/energy-attribution';
import {
  activeDeviceKeys,
  nowDividerIndex,
  type DayWindow,
  type TimelineRange,
  type TimelineRow,
} from '@/lib/energy-shift/energy-timeline';
import {
  splitConsumption, type ConsumptionSeries,
} from '@/lib/energy-shift/consumption-series';
import { DayWindowToggle } from '../ui';
import type { PlanModel } from '../usePlanModel';
import DeviceEnergyTable from '../DeviceEnergyTable';
import PlanReplayDownload from '../PlanReplayDownload';
import PlanPanels, { type PlanPanelRow } from '../PlanPanels';
import { loadColour, PLAN_COLOURS } from '../types';
import { useHomeTimeZone } from '../../HomeTimeZoneContext';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';

const QUARTER_W_TO_KWH = 4_000;

/**
 * A quoted price if there is one, otherwise what the planner valued the
 * quarter at (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.4.2). The plan acts on the
 * modelled number, so a chart that omitted it would show the plan spending
 * against a blank stretch of axis.
 *
 * The two are drawn, but never merged silently. Nord Pool publishes one day
 * ahead and the horizon is three, so most of a plan is priced by the shape
 * estimator rather than by the market — and an estimate presented as a quote
 * does not read as an estimate, it reads as the market being wrong. Whether a
 * quarter was actually quoted therefore travels beside the number, so the
 * chart can say which of the two a reader is looking at.
 */
const isQuoted = (quoted: number | null): boolean =>
  quoted !== null && Number.isFinite(quoted);

const priced = (quoted: number | null, modelled: number | null): number | null =>
  isQuoted(quoted) ? quoted
    : modelled !== null && Number.isFinite(modelled) ? modelled
      : null;

const PowerSection: React.FC<{
  model: PlanModel;
  rows: TimelineRow[];
  range: TimelineRange;
  dayWindow: DayWindow;
  dayWindowOptions: DayWindow[];
  onDayWindowChange: (value: DayWindow) => void;
  deviceNameByKey: ReadonlyMap<string, string>;
  /** Meters the plan is allowed to move. Only these earn a band of their own. */
  schedulableKeys: ReadonlySet<string>;
  hasBattery: boolean;
  hasEvBattery: boolean;
}> = ({
  model,
  rows,
  range,
  dayWindow,
  dayWindowOptions,
  onDayWindowChange,
  deviceNameByKey,
  schedulableKeys,
  hasBattery,
  hasEvBattery,
}) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const [selectedQuarterStart, setSelectedQuarterStart] = useState<string | null>(null);

  const view = useMemo(() => rows.slice(range.from, range.to), [range.from, range.to, rows]);

  const panelRows = useMemo<PlanPanelRow[]>(() => {
    let running = 0;
    return view.map(row => {
      running += row.costSek ?? 0;
      return {
        startMs: row.startMs,
        label: formatHomeDayMonthTime(row.start, homeTimeZone),
        measured: row.measured,
        missing: row.missing,
        solarW: row.solarW,
        loadW: row.loadW,
        gridImportW: row.gridImportW,
        gridExportW: row.gridExportW,
        batteryChargeW: row.batteryChargeW,
        batteryDischargeW: row.batteryDischargeW,
        homeSoc: row.batterySoc === null ? null : row.batterySoc * 100,
        evSoc: row.evSoc === null ? null : row.evSoc * 100,
        importPriceSekPerKwh: priced(row.importPriceSekPerKwh, row.shadowImportSekPerKwh),
        exportPriceSekPerKwh: priced(row.exportPriceSekPerKwh, row.shadowExportSekPerKwh),
        importPriceQuoted: isQuoted(row.importPriceSekPerKwh),
        cumulativeCostSek: running,
      };
    });
  }, [homeTimeZone, view]);

  /**
   * Individual meters, never categories — the plan dispatches devices, so a
   * band labelled by category would describe something no schedule can act on.
   * Small Planned meters share Other planned devices; Monitoring stays in base.
   */
  const consumption = useMemo(() => {
    const active = new Set([...activeDeviceKeys(rows, range), ...schedulableKeys]);
    const candidates = [...active].map(key => ({
      key,
      name: deviceNameByKey.get(key) ?? key,
      values: view.map(row => row.deviceW[key] ?? NaN),
      schedulable: schedulableKeys.has(key),
    }));
    return splitConsumption(candidates, view.map(row => row.loadW));
  }, [deviceNameByKey, range, rows, schedulableKeys, view]);

  const divider = nowDividerIndex(rows, range);
  const plannedStarts = useMemo(
    () => new Set(model.active.slots.map(slot => Date.parse(slot.start))),
    [model.active.slots],
  );
  const selectedIndex = selectedQuarterStart === null
    ? -1
    : view.findIndex(row => Date.parse(row.start) === Date.parse(selectedQuarterStart));

  const attribution = useMemo(() => {
    const slots: SupplySlotInput[] = view.map(row => ({
      start: row.start,
      loadKwh: (row.loadW ?? 0) / QUARTER_W_TO_KWH,
      solarKwh: (row.solarW ?? 0) / QUARTER_W_TO_KWH,
      gridImportKwh: (row.gridImportW ?? 0) / QUARTER_W_TO_KWH,
      gridExportKwh: Math.abs(row.gridExportW ?? 0) / QUARTER_W_TO_KWH,
      batteryChargeKwh: Math.abs(row.batteryChargeW ?? 0) / QUARTER_W_TO_KWH,
      batteryDischargeKwh: 0,
      deviceKwh: Object.fromEntries(
        Object.entries(row.deviceW).map(([key, value]) => [key, value / QUARTER_W_TO_KWH]),
      ),
      importPriceSekPerKwh: null,
      exportPriceSekPerKwh: null,
    }));
    return attributeEnergy(slots, new Map(deviceNameByKey), {
      baseLoad: t('Baslast — allt övrigt', 'Base load — everything else'),
      batteryCharging: t('Batteriladdning', 'Battery charging'),
    });
  }, [deviceNameByKey, t, view]);

  if (view.length === 0) {
    return (
      <>
        <div className="mb-2 flex justify-end">
          <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
        </div>
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t('Ingen data för den valda dagen.', 'No data for the selected day.')}
        </p>
      </>
    );
  }

  const hasHistory = divider > 0;
  const hasPlan = divider < view.length;
  const title = !hasPlan
    ? t('Uppmätt förbrukning', 'Historical consumption')
    : !hasHistory
      ? t('Planerad förbrukning', 'Planned consumption')
      : t('Uppmätt och planerad förbrukning', 'Historical and planned consumption');

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
      </div>
      <PlanPanels
        rows={panelRows}
        series={consumption.series}
        baseValues={consumption.baseValues}
        dividerIndex={divider}
        hasBattery={hasBattery}
        hasEvBattery={hasEvBattery}
        selectedIndex={selectedIndex}
        onQuarterClick={index => {
          const row = view[index];
          if (row && plannedStarts.has(Date.parse(row.start))) setSelectedQuarterStart(row.start);
        }}
      />
      {hasHistory && <p className="text-xs text-muted-foreground">{t(
        'Historisk förbrukning visas med denna plans enhetsindelning.',
        'Historical consumption is reclassified using this plan’s device roles.')}</p>}
      {consumption.invalidIndices.length > 0 && <p role="status" className="text-xs text-muted-foreground">{t(
        'Luckor betyder att total och enhetsmätningar inte kan stämmas av.',
        'Gaps mean household and device measurements cannot be reconciled.')}</p>}
      <PanelLegend
        series={consumption.series}
        hasBattery={hasBattery}
        hasEvBattery={hasEvBattery}
      />
      <div className="mt-6 border-t pt-6">
        <PlanReplayDownload
          model={model}
          rows={rows}
          range={range}
          selectedStart={selectedQuarterStart}
        />
      </div>
      <div className="mt-6">
        <h3 className="text-sm font-medium">
          {t('Förbrukning per enhet', 'Consumption by device')}
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          {t('Största förbrukaren först, för den valda perioden.', 'Largest consumer first, for the selected period.')}
        </p>
        <DeviceEnergyTable result={attribution} />
      </div>
    </>
  );
};

/**
 * What each colour means. Informational rather than a set of toggles: the
 * panels are single-purpose now, so there is nothing left to declutter.
 */
const PanelLegend: React.FC<{
  series: ConsumptionSeries[];
  hasBattery: boolean;
  hasEvBattery: boolean;
}> = ({ series, hasBattery, hasEvBattery }) => {
  const { t } = useLanguage();
  const flows: Array<{ label: string; colour: string; line?: boolean }> = [
    { label: t('Sol', 'Solar'), colour: PLAN_COLOURS.solar },
    { label: t('Nät', 'Grid'), colour: PLAN_COLOURS.grid },
    ...(hasBattery ? [{ label: t('Batteri', 'Battery'), colour: PLAN_COLOURS.battery }] : []),
    ...(hasEvBattery
      ? [{ label: t('Bilbatteri', 'Car battery'), colour: PLAN_COLOURS.ev, line: true }]
      : []),
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {flows.map(flow => (
        <Key key={flow.label} colour={flow.colour} line={flow.line}>{flow.label}</Key>
      ))}
      <span className="text-border" aria-hidden="true">|</span>
      {series.map(entry => (
        <Key key={entry.key} colour={loadColour(entry.slot)}>{entry.key === '$other_planned' ? t('Övriga planerade enheter', 'Other planned devices') : entry.name}</Key>
      ))}
      <Key colour={PLAN_COLOURS.base}>
        {t('Baslast', 'Base load')}
      </Key>
      <span className="inline-flex items-center gap-1.5">
        <span className="flex" aria-hidden="true">
          {[1, 3, 5, 7].map(step => (
            <span
              key={step} className="h-2.5 w-2.5"
              style={{ backgroundColor: `var(--plan-price-${step})` }}
            />
          ))}
        </span>
        {t('Köppris, billigt → dyrt', 'Buy price, cheap → dear')}
      </span>
    </div>
  );
};

const Key: React.FC<{ colour: string; line?: boolean; children: React.ReactNode }> = ({
  colour, line, children,
}) => (
  <span className="inline-flex items-center gap-1.5">
    <span
      className={line ? 'h-0.5 w-3.5 rounded-full' : 'h-2.5 w-2.5 rounded-sm'}
      style={{ backgroundColor: colour }}
      aria-hidden="true"
    />
    {children}
  </span>
);

export default PowerSection;
