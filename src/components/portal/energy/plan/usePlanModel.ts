// Everything the plan sections derive from one plan row.
//
// Extracted from PlanView on 2026-08-13 so each section can be its own
// component (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.5a). The bodies are
// unchanged; only the surrounding function moved.
//
// Series *visibility* deliberately did not come with it: that is per-section UI
// state and now lives in the section that owns the chart, so toggling a series
// on Power cannot re-render Storage.

import { useMemo, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { comparePlans } from '@/lib/energy-shift/plan-comparison';
import {
  foldDevicePowerIntoBase,
  reconcilePlanDeviceRoles,
} from '@/lib/energy-shift/plan-device-roles';
import type { EmpiricalEnergyDevice } from '../EmpiricalDeviceModelsCard';
import {
  COLORS,
  DEVICE_COLORS,
  type CurrentRow,
  type PlanChartSeries,
  type PlanChartSeriesKey,
  type PlanViewMode,
} from './types';

export function usePlanModel(
  current: CurrentRow,
  empiricalDevices: EmpiricalEnergyDevice[],
  stale: boolean,
) {
  const { t } = useLanguage();
  const { plan } = current;
  const [planView, setPlanView] = useState<PlanViewMode>('planned');
  // Home Assistant executes the priority scenario. Baseline is exposed only
  // as a counterfactual chart and cannot change local control.
  const executed = plan.plans.priority;
  const active = planView === 'planned' ? plan.plans.priority : plan.plans.baseline;
  const comparison = useMemo(
    () => comparePlans(plan.plans.priority, plan.plans.baseline),
    [plan],
  );
  const deviceRoleView = useMemo(
    () => reconcilePlanDeviceRoles(plan.device_models, empiricalDevices),
    [empiricalDevices, plan.device_models],
  );
  const chartData = useMemo(() => active.slots.map((slot, index) => {
    return {
      i: index,
      start: slot.start,
      label: new Date(slot.start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      pv: slot.pv_w,
      base: foldDevicePowerIntoBase(
        slot.base_w,
        slot.device_loads_w,
        deviceRoleView.baseLoadModels,
      ),
      boiler: slot.boiler_expected_w,
      pool: slot.pool_w,
      ev: slot.ev_w,
      homeSoc: slot.battery_soc * 100,
      homeTarget: plan.policy.battery_end_of_solar_target_soc * 100,
      evSoc: slot.ev_soc === null ? null : slot.ev_soc * 100,
      evTarget: plan.ev_battery?.departure_target_soc == null
        ? null
        : plan.ev_battery.departure_target_soc * 100,
      evConnected: slot.ev_connected,
      // Charging and export leave the house. The storage chart reads them as
      // stored-versus-released, so they keep their own sign there; the power
      // chart plots them against load, where positive would read as demand.
      homeCharge: slot.battery_charge_w,
      homeDischarge: slot.battery_discharge_w,
      homeExport: slot.battery_export_w,
      evCharge: slot.ev_w,
      gridImport: slot.grid_import_w,
      gridExport: -slot.grid_export_w,
      batteryChargePower: -slot.battery_charge_w,
      importPrice: slot.import_price_sek_per_kwh,
      exportPrice: slot.export_price_sek_per_kwh,
      ...Object.fromEntries(deviceRoleView.visibleModels.map((model, modelIndex) => [
        `device${modelIndex}`,
        slot.device_loads_w[model.key] ?? 0,
      ])),
    };
  }), [active, deviceRoleView, plan.ev_battery, plan.policy.battery_end_of_solar_target_soc]);
  const thermalProjection = plan.thermal_projection;
  const thermalData = useMemo(() => thermalProjection?.starts.map((start, index) => ({
    i: index,
    label: new Date(start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    outdoor: thermalProjection.outdoor_temperature_c[index],
    thermalPower: planView === 'planned'
      ? thermalProjection.planned_total_power_w[index]
      : thermalProjection.unplanned_total_power_w[index],
    ...Object.fromEntries(thermalProjection.zones.flatMap((zone, zoneIndex) => [
      [
        `zoneTemperature${zoneIndex}`,
        planView === 'planned'
          ? zone.planned_temperature_c[index]
          : zone.unplanned_temperature_c[index],
      ],
      [`zoneTarget${zoneIndex}`, zone.target_c[index]],
    ])),
  })) ?? [], [planView, thermalProjection]);
  const firstAdvisory = active.slots.findIndex(slot => !slot.binding);
  const bindingIndex = firstAdvisory < 0 ? active.slots.length : firstAdvisory;
  const ticks = active.slots.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => new Date(slot.start).getMinutes() === 0 && new Date(slot.start).getHours() % 6 === 0)
    .map(({ index }) => index);
  const hasBattery = plan.capabilities.battery && plan.battery !== null;
  const hasEvBattery = plan.capabilities.ev && plan.ev_battery != null;
  const hasPv = plan.capabilities.pv;
  const sourceStale = Object.entries(plan.sources)
    .filter(([, source]) => source !== null && Date.parse(source.valid_until) < Date.now())
    .map(([name]) => name);
  const bindingExpired = Date.now() >= Date.parse(plan.binding_until);
  const ready = !stale && !bindingExpired && plan.status === 'ready' && executed.status === 'ready' && sourceStale.length === 0;
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  const seriesByKey: Record<Exclude<PlanChartSeriesKey, `device:${string}`>, PlanChartSeries> = {
    pv: { key: 'pv', label: t('Solprognos', 'Solar forecast'), color: COLORS.pv },
    base: { key: 'base', label: t('Baslast', 'Base load'), color: COLORS.base },
    boiler: { key: 'boiler', label: t('Förväntat varmvatten', 'Expected hot water'), color: COLORS.boiler },
    pool: { key: 'pool', label: t('Pool', 'Pool'), color: COLORS.pool },
    ev: { key: 'ev', label: t('Bil', 'EV'), color: COLORS.ev },
    gridImport: { key: 'gridImport', label: t('Importeffekt', 'Grid import'), color: COLORS.import },
    gridExport: { key: 'gridExport', label: t('Exporteffekt (negativ)', 'Grid export (negative)'), color: COLORS.export },
    batteryChargePower: { key: 'batteryChargePower', label: t('Batteriladdning (negativ)', 'Battery charge (negative)'), color: COLORS.batteryCharge },
  };
  const deviceSeries: PlanChartSeries[] = deviceRoleView.visibleModels.map((model, index) => ({
    key: `device:${model.key}`,
    dataKey: `device${index}`,
    label: `${model.name} · ${model.control_type.replace(/_/g, ' ')}`,
    color: DEVICE_COLORS[index % DEVICE_COLORS.length],
  }));
  const representedCategories = new Set(plan.device_models.map(model => model.category));
  const showBoilerAggregate = plan.capabilities.boiler && !representedCategories.has('hot_water');
  const showPoolAggregate = plan.capabilities.pool && !representedCategories.has('pool_heating');
  const showEvAggregate = plan.capabilities.ev && !representedCategories.has('ev_charging');
  const planChartSeries: PlanChartSeries[] = [
    ...(hasPv ? [seriesByKey.pv] : []),
    seriesByKey.base,
    ...(showBoilerAggregate ? [seriesByKey.boiler] : []),
    ...(showPoolAggregate ? [seriesByKey.pool] : []),
    ...(showEvAggregate ? [seriesByKey.ev] : []),
    ...deviceSeries,
    seriesByKey.gridImport,
    seriesByKey.gridExport,
    ...(hasBattery ? [seriesByKey.batteryChargePower] : []),
  ];
  const thermalSeries = [
    { key: 'outdoor' as const, label: t('Utomhus', 'Outdoor'), color: '#475569' },
    { key: 'thermalPower' as const, label: t('Samordnad värmeeffekt', 'Coordinated heat power'), color: '#f97316' },
    ...(thermalProjection?.zones.flatMap((zone, index) => [
      {
        key: `zoneTemperature:${zone.key}` as const,
        dataKey: `zoneTemperature${index}`,
        label: `${zone.name} · ${t('temperatur', 'temperature')}`,
        color: DEVICE_COLORS[index % DEVICE_COLORS.length],
      },
      {
        key: `zoneTarget:${zone.key}` as const,
        dataKey: `zoneTarget${index}`,
        label: `${zone.name} · ${t('börvärde', 'target')}`,
        color: DEVICE_COLORS[index % DEVICE_COLORS.length],
      },
    ]) ?? []),
  ];
  const storageSeries = [
    ...(hasBattery ? [
      { key: 'homeSoc' as const, label: t('Hembatteri SOC', 'Home battery SOC'), color: COLORS.soc },
      { key: 'homeTarget' as const, label: t('Hembatteriets mål', 'Home battery target'), color: '#fb7185' },
      { key: 'homeCharge' as const, label: t('Batteriladdning', 'Battery charge'), color: COLORS.batteryCharge },
      { key: 'homeDischarge' as const, label: t('Total batteriurladdning', 'Total battery discharge'), color: COLORS.batteryDischarge },
      { key: 'homeExport' as const, label: t('Batteriexport till nätet', 'Battery-to-grid export'), color: COLORS.batteryExport },
    ] : []),
    ...(hasEvBattery ? [
      { key: 'evSoc' as const, label: t('Bilbatteri SOC', 'EV battery SOC'), color: COLORS.ev },
      { key: 'evTarget' as const, label: t('Bilens SOC-mål', 'EV target SOC'), color: '#c084fc' },
      { key: 'evCharge' as const, label: t('Billaddning', 'EV charge'), color: '#7c3aed' },
    ] : []),
  ];
  const connectedIndices = chartData
    .filter(row => row.evConnected)
    .map(row => row.i);
  const evConnectedStart = connectedIndices.at(0);
  const evConnectedEnd = connectedIndices.at(-1);
  const costDelta = comparison.terminalAdjustedCostSekDelta;
  const costTone: 'good' | 'bad' | undefined = costDelta < -0.005 ? 'good' : costDelta > 0.005 ? 'bad' : undefined;
  const costMeaning = costDelta < -0.005
    ? t('uppskattad besparing', 'estimated saving')
    : costDelta > 0.005
      ? t('uppskattad merkostnad', 'estimated added cost')
      : t('ingen uppskattad förändring', 'no estimated change');
  const validationMessages = [...new Set(
    plan.validation_errors.length > 0
      ? plan.validation_errors
      : executed.validation_errors,
  )];

  return {
    plan,
    planView,
    setPlanView,
    executed,
    active,
    comparison,
    deviceRoleView,
    chartData,
    thermalProjection,
    thermalData,
    bindingIndex,
    ticks,
    hasBattery,
    hasEvBattery,
    hasPv,
    sourceStale,
    bindingExpired,
    ready,
    pct,
    seriesByKey,
    deviceSeries,
    showBoilerAggregate,
    showPoolAggregate,
    showEvAggregate,
    planChartSeries,
    thermalSeries,
    storageSeries,
    evConnectedStart,
    evConnectedEnd,
    costDelta,
    costTone,
    costMeaning,
    validationMessages,
  };
}

export type PlanModel = ReturnType<typeof usePlanModel>;
