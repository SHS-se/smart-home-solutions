// The live power chart shown in the Plan workspace.

import React, { useMemo } from 'react';
import {
  Area, Line, ReferenceArea, ReferenceLine,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  attributeEnergy,
  type SupplySlotInput,
} from '@/lib/energy-shift/energy-attribution';
import {
  isServiceScheduled,
  planWindowRange,
  scheduledDeviceKeys,
  type PlanWindow,
} from '@/lib/energy-shift/plan-window';
import { COLORS } from '../types';
import { PlanWindowToggle, SeriesToggleLegend, useSeriesVisibility } from '../ui';
import type { PlanModel } from '../usePlanModel';
import type { PlanChartSeriesKey } from '../types';
import DeviceEnergyTable from '../DeviceEnergyTable';
import EnergyPowerChart from '../EnergyPowerChart';

/** A quarter of average power in watts is that many watt-hours over four. */
const QUARTER_W_TO_KWH = 4_000;

/**
 * Grid and battery flows are what the reader is checking the plan against, so
 * they are drawn heavier than any device series. Eighteen device colours will
 * always out-number them; weight is the only thing that keeps them legible.
 */
const FLOW_STROKE_WIDTH = 2.5;

const PowerSection: React.FC<{
  model: PlanModel;
  planWindow: PlanWindow;
  planWindowOptions: PlanWindow[];
  onPlanWindowChange: (value: PlanWindow) => void;
}> = ({ model, planWindow, planWindowOptions, onPlanWindowChange }) => {
  const { t } = useLanguage();
  const powerVisibility = useSeriesVisibility<PlanChartSeriesKey>();
  const {
    plan,
    active,
    chartData,
    bindingIndex,
    hasPv,
    seriesByKey,
    deviceSeries,
    showBoilerAggregate,
    showPoolAggregate,
    showEvAggregate,
    planChartSeries,
    deviceRoleView,
  } = model;

  const range = useMemo(
    () => planWindowRange(active.slots.length, planWindow),
    [active.slots.length, planWindow],
  );
  // The chart's x-axis reads `i` as the array position, so a window that does
  // not start at slot zero has to be re-indexed. Day 2 and Day 3 would
  // otherwise plot against an axis that stops before their first point.
  const windowed = useMemo(
    () => chartData
      .slice(range.from, range.to)
      .map((row, index) => ({ ...row, i: index })),
    [chartData, range.from, range.to],
  );
  const singleDay = planWindow !== 'all';
  const ticks = useMemo(
    () => windowed
      .filter(row => {
        const start = new Date(row.start);
        return start.getMinutes() === 0 && start.getHours() % (singleDay ? 3 : 6) === 0;
      })
      .map(row => row.i),
    [singleDay, windowed],
  );
  const advisoryFrom = bindingIndex - range.from;

  // A house with eighteen mapped devices puts eighteen entries in the legend,
  // nearly all flat at zero. Only what the plan actually runs in view is worth
  // a colour; the rest is noise over the series that carry the schedule.
  const scheduled = useMemo(
    () => scheduledDeviceKeys(active.slots, range),
    [active.slots, range],
  );
  const visibleDeviceSeries = useMemo(
    () => deviceSeries.filter(series => scheduled.has(series.key.replace(/^device:/, ''))),
    [deviceSeries, scheduled],
  );
  const poolScheduled = showPoolAggregate
    && isServiceScheduled(active.slots, range, slot => slot.pool_w);
  const boilerScheduled = showBoilerAggregate
    && isServiceScheduled(active.slots, range, slot => slot.boiler_expected_w);
  const evScheduled = showEvAggregate
    && isServiceScheduled(active.slots, range, slot => slot.ev_w);
  const legendSeries = useMemo(() => {
    const shown = new Set<PlanChartSeriesKey>([
      ...visibleDeviceSeries.map(series => series.key),
      ...(poolScheduled ? (['pool'] as const) : []),
      ...(boilerScheduled ? (['boiler'] as const) : []),
      ...(evScheduled ? (['ev'] as const) : []),
    ]);
    return planChartSeries.filter(series =>
      !series.key.startsWith('device:')
        && !['pool', 'boiler', 'ev'].includes(series.key)
        ? true
        : shown.has(series.key));
  }, [boilerScheduled, evScheduled, planChartSeries, poolScheduled, visibleDeviceSeries]);
  const idleDeviceCount = deviceSeries.length - visibleDeviceSeries.length;

  // The plan prices its own slots, so the forward table needs no price archive.
  const attribution = useMemo(() => {
    const models = deviceRoleView.visibleModels;
    const slots: SupplySlotInput[] = active.slots.slice(range.from, range.to).map(slot => ({
      start: slot.start,
      loadKwh: slot.load_w / QUARTER_W_TO_KWH,
      solarKwh: slot.pv_w / QUARTER_W_TO_KWH,
      gridImportKwh: slot.grid_import_w / QUARTER_W_TO_KWH,
      gridExportKwh: slot.grid_export_w / QUARTER_W_TO_KWH,
      batteryChargeKwh: slot.battery_charge_w / QUARTER_W_TO_KWH,
      batteryDischargeKwh: slot.battery_discharge_w / QUARTER_W_TO_KWH,
      deviceKwh: Object.fromEntries(models.map(entry => [
        entry.key,
        (slot.device_loads_w[entry.key] ?? 0) / QUARTER_W_TO_KWH,
      ])),
      importPriceSekPerKwh: slot.import_price_sek_per_kwh,
      exportPriceSekPerKwh: slot.export_price_sek_per_kwh,
    }));
    return attributeEnergy(
      slots,
      new Map(models.map(entry => [entry.key, entry.name])),
      {
        baseLoad: t('Baslast — allt övrigt', 'Base load — everything else'),
        batteryCharging: t('Batteriladdning', 'Battery charging'),
      },
    );
  }, [active.slots, deviceRoleView.visibleModels, range.from, range.to, t]);

  return (
    <>
      <div className="mb-2 flex justify-end">
        <PlanWindowToggle
          value={planWindow}
          options={planWindowOptions}
          onChange={onPlanWindowChange}
        />
      </div>
      <EnergyPowerChart data={windowed} ticks={ticks}>
        {advisoryFrom < windowed.length && <ReferenceArea yAxisId="power" x1={Math.max(0, advisoryFrom)} x2={windowed.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
        {hasPv && powerVisibility.visible('pv') && <Area yAxisId="power" type="monotone" dataKey="pv" name={seriesByKey.pv.label} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} />}
        {powerVisibility.visible('base') && <Area yAxisId="power" type="stepAfter" dataKey="base" stackId="load" name={seriesByKey.base.label} fill={COLORS.base} strokeWidth={0} />}
        {boilerScheduled && powerVisibility.visible('boiler') && <Area yAxisId="power" type="stepAfter" dataKey="boiler" stackId="load" name={seriesByKey.boiler.label} fill={COLORS.boiler} strokeWidth={0} />}
        {poolScheduled && powerVisibility.visible('pool') && <Area yAxisId="power" type="stepAfter" dataKey="pool" stackId="load" name={seriesByKey.pool.label} fill={COLORS.pool} strokeWidth={0} />}
        {evScheduled && powerVisibility.visible('ev') && <Area yAxisId="power" type="stepAfter" dataKey="ev" stackId="load" name={seriesByKey.ev.label} fill={COLORS.ev} strokeWidth={0} />}
        {visibleDeviceSeries.map(series => powerVisibility.visible(series.key) && (
          <Area key={series.key} yAxisId="power" type="stepAfter" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
        ))}
        {/*
          Flows, not consumption: they cross the house boundary rather than
          stacking into it, so they stay unfilled lines above the stack. All
          three are solid — a dash on one of the three read as a fourth kind of
          series rather than as a distinction.
        */}
        {powerVisibility.visible('gridImport') && <Line yAxisId="power" type="stepAfter" dataKey="gridImport" name={seriesByKey.gridImport.label} stroke={COLORS.import} strokeWidth={FLOW_STROKE_WIDTH} dot={false} />}
        {powerVisibility.visible('gridExport') && <Line yAxisId="power" type="stepAfter" dataKey="gridExport" name={seriesByKey.gridExport.label} stroke={COLORS.export} strokeWidth={FLOW_STROKE_WIDTH} dot={false} />}
        {powerVisibility.visible('batteryChargePower') && <Line yAxisId="power" type="stepAfter" dataKey="batteryChargePower" name={seriesByKey.batteryChargePower.label} stroke={COLORS.batteryCharge} strokeWidth={FLOW_STROKE_WIDTH} dot={false} />}
        <ReferenceLine yAxisId="power" y={0} stroke="currentColor" className="text-muted-foreground" strokeWidth={1} />
      </EnergyPowerChart>
      <SeriesToggleLegend
        series={legendSeries}
        hidden={powerVisibility.hidden}
        onToggle={powerVisibility.toggle}
        ariaLabel={t('Effektserier', 'Power series')}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          'Fyllda staplar staplas till husets förbrukning. Nätimport, nätexport och batteriladdning är flöden över husets gräns och ritas som kraftigare linjer; export och laddning är negativa.',
          'Filled bars stack into what the house consumes. Grid import, grid export and battery charge are flows across the house boundary and are drawn as heavier lines; export and charging are negative.',
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('Baslasten innehåller varje enhet som inte är markerad som styrbar. Styrbara enheter visas separat och räknas inte dubbelt.', 'Base load contains every device not marked controllable. Controllable devices are shown separately and are not double-counted.')}
        {idleDeviceCount > 0 && ` ${t(
          `${idleDeviceCount} styrbara enheter är dolda eftersom planen aldrig startar dem i den här perioden.`,
          `${idleDeviceCount} controllable device${idleDeviceCount === 1 ? '' : 's'} ${idleDeviceCount === 1 ? 'is' : 'are'} hidden because the plan never runs ${idleDeviceCount === 1 ? 'it' : 'them'} in this period.`,
        )}`}
        {deviceRoleView.requiresPlanRefresh && ` ${t(
          'Den ändrade enhetsrollen visas direkt; schema- och kostnadsberäkningarna uppdateras vid nästa Home Assistant-plan.',
          'The changed device role is shown immediately; schedule and cost calculations update with the next Home Assistant plan.',
        )}`}
      </p>
      <div className="mt-6">
        <h3 className="text-sm font-medium">
          {t('Planerad förbrukning per enhet', 'Planned consumption by device')}
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          {t(
            `${planWindow === 'all' ? 'Hela planen' : `Dag ${planWindow}`} enligt ${plan.plans.priority === active ? 'Med plan' : 'Utan plan'}, största förbrukaren först.`,
            `${planWindow === 'all' ? 'The whole plan' : `Day ${planWindow}`} under ${plan.plans.priority === active ? 'With plan' : 'Without plan'}, largest consumer first.`,
          )}
        </p>
        <DeviceEnergyTable result={attribution} />
      </div>
    </>
  );
};

export default PowerSection;
