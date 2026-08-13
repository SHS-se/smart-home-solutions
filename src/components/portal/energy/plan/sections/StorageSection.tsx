// The Storage tab's chart.
//
// Split out of PlanView on 2026-08-13. The chart markup is unchanged; the
// series-visibility state moved in with it, so this tab owns its own toggles.

import React from 'react';
import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import { COLORS } from '../types';
import { SeriesToggleLegend, useSeriesVisibility } from '../ui';
import type { PlanModel } from '../usePlanModel';
import type { StorageSeriesKey } from '../types';

const StorageSection: React.FC<{ model: PlanModel }> = ({ model }) => {
  const { t } = useLanguage();
  const storageVisibility = useSeriesVisibility<StorageSeriesKey>();
  const {
    plan,
    chartData,
    ticks,
    hasBattery,
    hasEvBattery,
    pct,
    storageSeries,
    evConnectedStart,
    evConnectedEnd,
  } = model;

  return (
    <>
      hasBattery || hasEvBattery ? (
                  <>
                    <ResponsiveContainer width="100%" height={360}>
                      <ComposedChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                        <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                        <YAxis yAxisId="power" tick={{ fontSize: 11 }} tickFormatter={value => `${(Number(value) / 1_000).toFixed(1)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                        <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={value => `${value}%`} />
                        {evConnectedStart !== undefined && evConnectedEnd !== undefined && <ReferenceArea yAxisId="soc" x1={evConnectedStart} x2={evConnectedEnd + 1} y1={0} y2={100} fill={COLORS.ev} fillOpacity={0.06} />}
                        {storageVisibility.visible('homeCharge') && <Area yAxisId="power" type="step" dataKey="homeCharge" name={storageSeries.find(item => item.key === 'homeCharge')?.label} fill={COLORS.batteryCharge} stroke={COLORS.batteryCharge} fillOpacity={0.18} dot={false} />}
                        {storageVisibility.visible('homeDischarge') && <Area yAxisId="power" type="step" dataKey="homeDischarge" name={storageSeries.find(item => item.key === 'homeDischarge')?.label} fill={COLORS.batteryDischarge} stroke={COLORS.batteryDischarge} fillOpacity={0.18} dot={false} />}
                        {storageVisibility.visible('homeExport') && <Line yAxisId="power" type="step" dataKey="homeExport" name={storageSeries.find(item => item.key === 'homeExport')?.label} stroke={COLORS.batteryExport} strokeWidth={2} strokeDasharray="5 3" dot={false} />}
                        {storageVisibility.visible('evCharge') && <Area yAxisId="power" type="step" dataKey="evCharge" name={storageSeries.find(item => item.key === 'evCharge')?.label} fill="#7c3aed" stroke="#7c3aed" fillOpacity={0.12} dot={false} />}
                        {storageVisibility.visible('homeSoc') && <Line yAxisId="soc" type="monotone" dataKey="homeSoc" name={storageSeries.find(item => item.key === 'homeSoc')?.label} stroke={COLORS.soc} strokeWidth={2} dot={false} />}
                        {storageVisibility.visible('homeTarget') && <Line yAxisId="soc" type="stepAfter" dataKey="homeTarget" name={storageSeries.find(item => item.key === 'homeTarget')?.label} stroke="#fb7185" strokeDasharray="4 3" dot={false} />}
                        {storageVisibility.visible('evSoc') && <Line yAxisId="soc" type="monotone" dataKey="evSoc" name={storageSeries.find(item => item.key === 'evSoc')?.label} stroke={COLORS.ev} strokeWidth={2} dot={false} connectNulls={false} />}
                        {storageVisibility.visible('evTarget') && <Line yAxisId="soc" type="stepAfter" dataKey="evTarget" name={storageSeries.find(item => item.key === 'evTarget')?.label} stroke="#c084fc" strokeDasharray="4 3" dot={false} connectNulls={false} />}
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={(value, name) => [String(name).includes('SOC') || String(name).includes(t('mål', 'target')) ? `${Number(value).toFixed(1)}%` : `${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <SeriesToggleLegend
                      series={storageSeries}
                      hidden={storageVisibility.hidden}
                      onToggle={storageVisibility.toggle}
                      ariaLabel={t('Lagringsserier', 'Storage series')}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {plan.ev_battery
                        ? `${plan.ev_battery.name}: ${pct(plan.ev_battery.soc)} → ${pct(plan.ev_battery.departure_target_soc)} · ${plan.ev_battery.capacity_kwh.toFixed(1)} kWh · ${t('prioritet', 'priority')} ${plan.ev_battery.priority} (${t('1 är högst', '1 is highest')})${plan.ev_battery.departure ? ` · ${t('avgång', 'departure')} ${new Date(plan.ev_battery.departure).toLocaleString()}` : ''}. `
                        : ''}
                      {hasBattery
                        ? plan.policy.battery_export_enabled
                          ? `${t('Planerad batteriexport vid minst', 'Planned battery export at or above')} ${plan.policy.battery_export_min_price_sek_per_kwh.toFixed(2)} SEK/kWh · ${t('exportreserv', 'export reserve')} ${pct(plan.policy.battery_export_reserve_soc)}. ${t('Detta visualiserar en rådgivande preferens; batteriutförande är ännu inte aktiverat.', 'This visualizes an advisory preference; battery execution is not enabled yet.')} `
                          : `${t('Planerad batteriexport är avstängd.', 'Planned battery export is disabled.')} `
                        : ''}
                      {t('Det skuggade intervallet visar när bilen är ansluten och tillgänglig för planerad laddning.', 'The shaded interval shows when the EV is connected and available for planned charging.')}
                    </p>
                  </>
                ) : (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    {t('Detta hem har ingen publicerad batteri- eller EV-modell.', 'This home has no published battery or EV model.')}
                  </p>
                )
    </>
  );
};

export default StorageSection;
