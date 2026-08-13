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
import { COLORS, WINDOW_SLOTS_PER_DAY, type WindowDays } from '../types';
import { SeriesToggleLegend, useSeriesVisibility, WindowDaysToggle } from '../ui';
import type { PlanModel } from '../usePlanModel';
import type { PlanChartSeriesKey } from '../types';
import DeviceEnergyTable from '../DeviceEnergyTable';
import EnergyPowerChart from '../EnergyPowerChart';

/** A quarter of average power in watts is that many watt-hours over four. */
const QUARTER_W_TO_KWH = 4_000;

const PowerSection: React.FC<{
  model: PlanModel;
  windowDays: WindowDays;
  onWindowDaysChange: (value: WindowDays) => void;
}> = ({ model, windowDays, onWindowDaysChange }) => {
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

  const slotLimit = windowDays * WINDOW_SLOTS_PER_DAY;
  const windowed = useMemo(() => chartData.slice(0, slotLimit), [chartData, slotLimit]);
  const ticks = useMemo(
    () => windowed
      .filter(row => {
        const start = new Date(row.start);
        return start.getMinutes() === 0 && start.getHours() % (windowDays === 1 ? 3 : 6) === 0;
      })
      .map(row => row.i),
    [windowDays, windowed],
  );

  // The plan prices its own slots, so the forward table needs no price archive.
  const attribution = useMemo(() => {
    const models = deviceRoleView.visibleModels;
    const slots: SupplySlotInput[] = active.slots.slice(0, slotLimit).map(slot => ({
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
  }, [active.slots, deviceRoleView.visibleModels, slotLimit, t]);

  return (
    <>
      <div className="mb-2 flex justify-end">
        <WindowDaysToggle value={windowDays} onChange={onWindowDaysChange} />
      </div>
      <EnergyPowerChart data={windowed} ticks={ticks}>
        {bindingIndex < windowed.length && <ReferenceArea yAxisId="power" x1={bindingIndex} x2={windowed.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
        {hasPv && powerVisibility.visible('pv') && <Area yAxisId="power" type="monotone" dataKey="pv" name={seriesByKey.pv.label} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} />}
        {powerVisibility.visible('base') && <Area yAxisId="power" type="stepAfter" dataKey="base" stackId="load" name={seriesByKey.base.label} fill={COLORS.base} strokeWidth={0} />}
        {showBoilerAggregate && powerVisibility.visible('boiler') && <Area yAxisId="power" type="stepAfter" dataKey="boiler" stackId="load" name={seriesByKey.boiler.label} fill={COLORS.boiler} strokeWidth={0} />}
        {showPoolAggregate && powerVisibility.visible('pool') && <Area yAxisId="power" type="stepAfter" dataKey="pool" stackId="load" name={seriesByKey.pool.label} fill={COLORS.pool} strokeWidth={0} />}
        {showEvAggregate && powerVisibility.visible('ev') && <Area yAxisId="power" type="stepAfter" dataKey="ev" stackId="load" name={seriesByKey.ev.label} fill={COLORS.ev} strokeWidth={0} />}
        {deviceSeries.map(series => powerVisibility.visible(series.key) && (
          <Area key={series.key} yAxisId="power" type="stepAfter" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
        ))}
        {powerVisibility.visible('gridImport') && <Line yAxisId="power" type="stepAfter" dataKey="gridImport" name={seriesByKey.gridImport.label} stroke={COLORS.import} dot={false} />}
        {powerVisibility.visible('gridExport') && <Line yAxisId="power" type="stepAfter" dataKey="gridExport" name={seriesByKey.gridExport.label} stroke={COLORS.export} dot={false} />}
        {powerVisibility.visible('batteryChargePower') && <Line yAxisId="power" type="stepAfter" dataKey="batteryChargePower" name={seriesByKey.batteryChargePower.label} stroke={COLORS.batteryCharge} strokeDasharray="4 2" dot={false} />}
        <ReferenceLine yAxisId="power" y={0} stroke="currentColor" className="text-muted-foreground" strokeWidth={1} />
      </EnergyPowerChart>
      <SeriesToggleLegend
        series={planChartSeries}
        hidden={powerVisibility.hidden}
        onToggle={powerVisibility.toggle}
        ariaLabel={t('Effektserier', 'Power series')}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {t('Baslasten innehåller varje enhet som inte är markerad som styrbar. Styrbara enheter visas separat och räknas inte dubbelt.', 'Base load contains every device not marked controllable. Controllable devices are shown separately and are not double-counted.')}
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
            `Nästa ${windowDays * 24} timmar enligt ${plan.plans.priority === active ? 'Med plan' : 'Utan plan'}, största förbrukaren först.`,
            `The next ${windowDays * 24} hours under ${plan.plans.priority === active ? 'With plan' : 'Without plan'}, largest consumer first.`,
          )}
        </p>
        <DeviceEnergyTable result={attribution} />
      </div>
    </>
  );
};

export default PowerSection;
