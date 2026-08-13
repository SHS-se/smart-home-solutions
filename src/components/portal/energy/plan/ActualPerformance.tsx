// Plan-versus-actual reporting. Lives on the Plan tab.
//
// Moved verbatim out of the former LoadShiftTab on 2026-08-13.

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
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { COLORS, DEVICE_COLORS, type ActualSeriesKey, type EmpiricalDeviceSlotMatrix } from './types';
import { SeriesToggleLegend, useSeriesVisibility } from './ui';

const ActualPerformance: React.FC<{
  actuals: ActualEnergySlot[];
  devices: EmpiricalEnergyDevice[];
  deviceActuals: EmpiricalDeviceSlotMatrix[];
}> = ({ actuals, devices, deviceActuals }) => {
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
  const ticks = data.filter((_, index) => index % 12 === 0).map(value => value.i);
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
        <CardTitle className="text-base">{t('Uppmätt prestanda — senaste 72 timmarna', 'Measured performance — last 72 hours')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('Inga kompletta 15-minutersvärden har tagits emot ännu.', 'No complete 15-minute actuals have been received yet.')}
          </p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="i" type="number" domain={[0, data.length - 1]} ticks={ticks} tickFormatter={index => data[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={watts => `${(Number(watts) / 1_000).toFixed(0)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                {series.map(item => !hidden.has(item.key) && (
                  <Line
                    key={item.key}
                    type="stepAfter"
                    dataKey={'dataKey' in item ? item.dataKey : item.key}
                    name={item.label}
                    stroke={item.color}
                    strokeWidth={item.key === 'load' || item.key === 'pv' ? 2 : 1.5}
                    dot={false}
                    connectNulls={false}
                  />
                ))}
                <Tooltip labelFormatter={index => data[index as number]?.label ?? ''} formatter={(value, name) => [`${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
              </ComposedChart>
            </ResponsiveContainer>
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
