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
import { DayWindowToggle } from '../ui';
import type { PlanModel } from '../usePlanModel';
import DeviceEnergyTable from '../DeviceEnergyTable';
import StoreDecisions from '../StoreDecisions';
import PlanPanels, { type PlanPanelDevice, type PlanPanelRow } from '../PlanPanels';

const QUARTER_W_TO_KWH = 4_000;

/**
 * A quoted price if there is one, otherwise what the planner valued the
 * quarter at (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.4.2). The plan acts on the
 * modelled number, so a chart that omitted it would show the plan spending
 * against a blank stretch of axis.
 */
const priced = (quoted: number | null, modelled: number | null): number | null =>
  quoted !== null && Number.isFinite(quoted) ? quoted
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
  hasBattery,
  hasEvBattery,
}) => {
  const { t } = useLanguage();
  const [selectedQuarterStart, setSelectedQuarterStart] = useState<string | null>(null);
  const [selectionRequest, setSelectionRequest] = useState(0);

  const view = useMemo(() => rows.slice(range.from, range.to), [range.from, range.to, rows]);

  const panelRows = useMemo<PlanPanelRow[]>(() => {
    let running = 0;
    return view.map(row => {
      running += row.costSek ?? 0;
      return {
        startMs: row.startMs,
        label: new Date(row.start).toLocaleString([], {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }),
        measured: row.measured,
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
        cumulativeCostSek: running,
      };
    });
  }, [view]);

  /**
   * One row per meter that actually ran, largest first. Meters are never
   * bucketed: the planner dispatches individual devices, so a chart that
   * grouped them would describe something the plan cannot act on.
   */
  const devices = useMemo<PlanPanelDevice[]>(() => {
    const active = activeDeviceKeys(rows, range);
    return [...active]
      .map(key => {
        const values = view.map(row => row.deviceW[key] ?? 0);
        return {
          key,
          name: deviceNameByKey.get(key) ?? key,
          values,
          kwh: values.reduce((total, watts) => total + watts / QUARTER_W_TO_KWH, 0),
        };
      })
      .sort((left, right) => right.kwh - left.kwh || left.name.localeCompare(right.name));
  }, [deviceNameByKey, range, rows, view]);

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
        devices={devices}
        dividerIndex={divider}
        hasBattery={hasBattery}
        hasEvBattery={hasEvBattery}
        selectedIndex={selectedIndex}
        onQuarterClick={index => {
          const row = view[index];
          if (row && plannedStarts.has(Date.parse(row.start))) {
            setSelectedQuarterStart(row.start);
            setSelectionRequest(current => current + 1);
          }
        }}
      />
      <PanelLegend hasBattery={hasBattery} hasEvBattery={hasEvBattery} />
      {/*
        Above the per-device table on purpose. The device table says how much
        each thing used; this says why the plan chose that at all, and a reader
        working down the page wants the reason before the arithmetic.
      */}
      <div className="mt-6 border-t pt-6">
        <StoreDecisions
          model={model}
          rows={rows}
          range={range}
          selectedStart={selectedQuarterStart}
          selectionRequest={selectionRequest}
          onSelectedStartChange={setSelectedQuarterStart}
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

/** What each colour means. Informational: the panels have nothing to declutter. */
const PanelLegend: React.FC<{ hasBattery: boolean; hasEvBattery: boolean }> = ({
  hasBattery, hasEvBattery,
}) => {
  const { t } = useLanguage();
  const keys: Array<{ label: string; colour: string; shape: 'box' | 'line' }> = [
    { label: t('Sol', 'Solar'), colour: 'var(--plan-solar)', shape: 'box' },
    { label: t('Nät', 'Grid'), colour: 'var(--plan-grid)', shape: 'box' },
    ...(hasBattery
      ? [{ label: t('Batteri', 'Battery'), colour: 'var(--plan-battery)', shape: 'box' as const }]
      : []),
    ...(hasEvBattery
      ? [{ label: t('Bilbatteri', 'Car battery'), colour: 'var(--plan-ev)', shape: 'line' as const }]
      : []),
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {keys.map(key => (
        <span key={key.label} className="inline-flex items-center gap-1.5">
          <span
            className={key.shape === 'box' ? 'h-2.5 w-2.5 rounded-sm' : 'h-0.5 w-3.5 rounded-full'}
            style={{ backgroundColor: key.colour }}
            aria-hidden="true"
          />
          {key.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="flex" aria-hidden="true">
          {[1, 3, 5, 7].map(step => (
            <span
              key={step}
              className="h-2.5 w-2.5"
              style={{ backgroundColor: `var(--plan-price-${step})` }}
            />
          ))}
        </span>
        {t('Köppris, billigt → dyrt', 'Buy price, cheap → dear')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="flex" aria-hidden="true">
          {[0, 2, 4, 6].map(step => (
            <span
              key={step}
              className="h-2.5 w-2.5"
              style={{ backgroundColor: `var(--plan-cell-${step})` }}
            />
          ))}
        </span>
        {t('Enhetseffekt', 'Device power')}
      </span>
    </div>
  );
};

export default PowerSection;
