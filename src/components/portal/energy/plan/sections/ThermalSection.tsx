// The Thermal tab's chart.
//
// Split out of PlanView on 2026-08-13. The chart markup is unchanged; the
// series-visibility state moved in with it, so this tab owns its own toggles.

import React from 'react';
import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import { COLORS, DEVICE_COLORS } from '../types';
import { SeriesToggleLegend, useSeriesVisibility } from '../ui';
import type { PlanModel } from '../usePlanModel';
import type { ThermalSeriesKey } from '../types';
import type {
  ThermalObservationSummary,
  ThermalZoneModelSummary,
} from '@/lib/energy-shift/thermal-readiness';
import type { EmpiricalEnergyDevice } from '../../EmpiricalDeviceModelsCard';
import ThermalReadinessPanel from '../ThermalReadinessPanel';

const ThermalSection: React.FC<{
  model: PlanModel;
  empiricalDevices: EmpiricalEnergyDevice[];
  thermalObservations: ThermalObservationSummary;
  zoneModels: ThermalZoneModelSummary[];
}> = ({ model, empiricalDevices, thermalObservations, zoneModels }) => {
  const { t } = useLanguage();
  const thermalVisibility = useSeriesVisibility<ThermalSeriesKey>();
  const {
    plan,
    thermalData,
    thermalProjection,
    ticks,
    thermalSeries,
  } = model;

  return (
    <>
      {thermalProjection && thermalProjection.zones.length > 0 && thermalData.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={360}>
                      <ComposedChart data={thermalData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                        <XAxis dataKey="i" type="number" domain={[0, thermalData.length - 1]} ticks={ticks} tickFormatter={index => thermalData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                        <YAxis yAxisId="temperature" tick={{ fontSize: 11 }} tickFormatter={value => `${Number(value).toFixed(0)}°`} label={{ value: '°C', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                        <YAxis yAxisId="power" orientation="right" tick={{ fontSize: 11 }} tickFormatter={value => `${(Number(value) / 1_000).toFixed(1)}`} label={{ value: 'kW', angle: 90, position: 'insideRight', fontSize: 11 }} />
                        {thermalVisibility.visible('thermalPower') && <Area yAxisId="power" type="step" dataKey="thermalPower" name={thermalSeries[1].label} stroke="#f97316" fill="#f97316" fillOpacity={0.16} dot={false} />}
                        {thermalVisibility.visible('outdoor') && <Line yAxisId="temperature" type="monotone" dataKey="outdoor" name={thermalSeries[0].label} stroke="#475569" strokeWidth={2} dot={false} />}
                        {thermalProjection.zones.map((zone, index) => (
                          <React.Fragment key={zone.key}>
                            {thermalVisibility.visible(`zoneTemperature:${zone.key}`) && <Line yAxisId="temperature" type="monotone" dataKey={`zoneTemperature${index}`} name={thermalSeries[2 + index * 2].label} stroke={DEVICE_COLORS[index % DEVICE_COLORS.length]} strokeWidth={2} dot={false} />}
                            {thermalVisibility.visible(`zoneTarget:${zone.key}`) && <Line yAxisId="temperature" type="stepAfter" dataKey={`zoneTarget${index}`} name={thermalSeries[3 + index * 2].label} stroke={DEVICE_COLORS[index % DEVICE_COLORS.length]} strokeDasharray="4 3" strokeOpacity={0.65} dot={false} />}
                          </React.Fragment>
                        ))}
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => thermalData[index as number]?.label ?? ''} formatter={(value, name) => [name === thermalSeries[1].label ? `${(Number(value) / 1_000).toFixed(2)} kW` : `${Number(value).toFixed(1)} °C`, name]} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <SeriesToggleLegend
                      series={thermalSeries}
                      hidden={thermalVisibility.hidden}
                      onToggle={thermalVisibility.toggle}
                      ariaLabel={t('Termiska serier', 'Thermal series')}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {thermalProjection.source === 'synthetic_season_fixture'
                        ? t('Detta är en 72-timmars skuggprojektion för säsongstest. Den visar samordning och komfort men ingår ännu inte i den körbara planen.', 'This is a 72-hour shadow projection for seasonal testing. It shows coordination and comfort but is not yet part of the executable plan.')
                        : t('Värmebehovet beräknas från komfortschemat, väderprognosen, aktuell rumstemperatur och rummets inlärda värmetröghet — inte från vad värmaren drog förra veckan.', 'Heating demand is calculated from the comfort schedule, weather forecast, current room temperature, and the room’s learned thermal response—not from what the heater drew last week.')}
                    </p>
                  </>
                ) : (
                  <ThermalReadinessPanel
                    devices={empiricalDevices}
                    planDevices={plan.device_models}
                    observations={thermalObservations}
                    zoneModels={zoneModels}
                  />
                )}
    </>
  );
};

export default ThermalSection;
