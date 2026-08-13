// The measured power chart. Lives on the History tab.
//
// Moved verbatim out of the former LoadShiftTab on 2026-08-13, then moved again
// from the Plan tab to History later the same day
// (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7). The caller now slices the
// window, so this component draws whatever it is given.

import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  effectiveControlType,
  effectivePlanningRole,
  type ActualEnergySlot,
} from '@/lib/energy-shift/contracts';
import type { EmpiricalEnergyDevice } from '../EmpiricalDeviceModelsCard';
import {
  Area, Line,
} from 'recharts';
import {
  COLORS,
  DEVICE_COLORS,
  type ActualSeriesKey,
  type EmpiricalDeviceSlotMatrix,
  type WindowDays,
} from './types';
import { SeriesToggleLegend } from './ui';
import EnergyPowerChart from './EnergyPowerChart';

const ActualPerformance: React.FC<{
  actuals: ActualEnergySlot[];
  devices: EmpiricalEnergyDevice[];
  deviceActuals: EmpiricalDeviceSlotMatrix[];
  windowDays: WindowDays;
}> = ({ actuals, devices, deviceActuals, windowDays }) => {
  const { t } = useLanguage();
  const [hidden, setHidden] = useState<Set<ActualSeriesKey>>(() => new Set());
  const controllableDevices = useMemo(
    () => devices.filter(device => effectivePlanningRole(device) === 'controllable'),
    [devices],
  );
  const actualByDeviceAndStart = useMemo(() => {
    const rows = new Map<string, number>();
    for (const slot of deviceActuals) {
      for (const [deviceId, energyKwh] of Object.entries(slot.device_energy_kwh)) {
        rows.set(`${deviceId}:${slot.start_ts}`, energyKwh * 4_000);
      }
    }
    return rows;
  }, [deviceActuals]);
  const data = useMemo(() => actuals.map((slot, index) => ({
    i: index,
    label: new Date(slot.start_ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    load: slot.total_load_kwh == null ? null : slot.total_load_kwh * 4_000,
    pv: slot.solar_production_kwh == null ? null : slot.solar_production_kwh * 4_000,
    gridImport: slot.grid_import_kwh == null ? null : slot.grid_import_kwh * 4_000,
    gridExport: slot.grid_export_kwh == null ? null : slot.grid_export_kwh * 4_000,
    batteryCharge: slot.battery_charge_kwh == null ? null : slot.battery_charge_kwh * 4_000,
    batteryDischarge: slot.battery_discharge_kwh == null ? null : slot.battery_discharge_kwh * 4_000,
    ...Object.fromEntries(controllableDevices.map((device, deviceIndex) => [
      `device${deviceIndex}`,
      actualByDeviceAndStart.get(`${device.id}:${slot.start_ts}`) ?? null,
    ])),
  })), [actualByDeviceAndStart, actuals, controllableDevices]);
  // A tick every six hours on one day, every twelve on three, so the axis stays
  // legible as the window grows.
  const tickEvery = windowDays === 1 ? 24 : windowDays * 24;
  const ticks = data.filter((_, index) => index % tickEvery === 0).map(value => value.i);
  const series = [
    { key: 'load' as const, label: t('Faktisk last', 'Actual load'), color: COLORS.actual },
    { key: 'pv' as const, label: t('Faktisk sol', 'Actual PV'), color: COLORS.pv },
    { key: 'gridImport' as const, label: t('Faktisk import', 'Actual import'), color: COLORS.import },
    { key: 'gridExport' as const, label: t('Faktisk export', 'Actual export'), color: COLORS.export },
    { key: 'batteryCharge' as const, label: t('Faktisk batteriladdning', 'Actual battery charge'), color: COLORS.batteryCharge },
    { key: 'batteryDischarge' as const, label: t('Faktisk batteriurladdning', 'Actual battery discharge'), color: COLORS.batteryDischarge },
    ...controllableDevices.map((device, index) => ({
      key: `device:${device.id}` as const,
      dataKey: `device${index}`,
      label: `${device.name} · ${effectiveControlType(device)?.replace(/_/g, ' ')}`,
      color: DEVICE_COLORS[index % DEVICE_COLORS.length],
    })),
  ];
  const toggle = (key: ActualSeriesKey) => setHidden(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">
          {t(
            `Uppmätt prestanda — senaste ${windowDays * 24} timmarna`,
            `Measured performance — last ${windowDays * 24} hours`,
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('Samma 15-minuterslayout och kW-axel som planen ovan.', 'The same 15-minute layout and kW axis as the plan above.')}
        </p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('Inga kompletta 15-minutersvärden har tagits emot ännu.', 'No complete 15-minute actuals have been received yet.')}
          </p>
        ) : (
          <>
            <EnergyPowerChart data={data} ticks={ticks}>
              {!hidden.has('load') && (
                <Area yAxisId="power" type="stepAfter" dataKey="load" name={series[0].label} stroke={COLORS.actual} fill={COLORS.actual} fillOpacity={0.22} strokeWidth={1.5} dot={false} connectNulls={false} />
              )}
              {!hidden.has('pv') && (
                <Area yAxisId="power" type="stepAfter" dataKey="pv" name={series[1].label} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} strokeWidth={1.5} dot={false} connectNulls={false} />
              )}
              {controllableDevices.map((device, index) => {
                const item = series[6 + index];
                return !hidden.has(item.key) && (
                  <Area key={item.key} yAxisId="power" type="stepAfter" dataKey={`device${index}`} name={item.label} stroke={item.color} fill={item.color} fillOpacity={0.16} strokeWidth={1} dot={false} connectNulls={false} />
                );
              })}
              {series.slice(2, 6).map(item => !hidden.has(item.key) && (
                <Line key={item.key} yAxisId="power" type="stepAfter" dataKey={item.key} name={item.label} stroke={item.color} strokeWidth={1.5} dot={false} connectNulls={false} />
              ))}
            </EnergyPowerChart>
            <SeriesToggleLegend
              series={series}
              hidden={hidden}
              onToggle={toggle}
              ariaLabel={t('Uppmätta serier', 'Measured series')}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Varje punkt är energi från Home Assistants recorder summerad i en komplett kvart och visad som medeleffekt; råa sekundvärden lagras inte på webbplatsen.', 'Each point is Home Assistant recorder energy summed into one complete quarter and shown as average power; raw per-second values are not stored by the website.')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default ActualPerformance;
