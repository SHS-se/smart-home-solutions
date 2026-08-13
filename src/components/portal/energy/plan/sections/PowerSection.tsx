// The Power tab's chart.
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
import type { PlanChartSeriesKey } from '../types';

const PowerSection: React.FC<{ model: PlanModel }> = ({ model }) => {
  const { t } = useLanguage();
  const powerVisibility = useSeriesVisibility<PlanChartSeriesKey>();
  const {
    plan,
    chartData,
    bindingIndex,
    ticks,
    hasPv,
    seriesByKey,
    deviceSeries,
    showBoilerAggregate,
    showPoolAggregate,
    showEvAggregate,
    planChartSeries,
    deviceRoleView,
  } = model;

  return (
    <>
      <>
                    <ResponsiveContainer width="100%" height={360}>
                      <ComposedChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                        <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                        <YAxis yAxisId="power" tick={{ fontSize: 11 }} tickFormatter={watts => `${(Number(watts) / 1_000).toFixed(0)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                        {bindingIndex < chartData.length && <ReferenceArea yAxisId="power" x1={bindingIndex} x2={chartData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
                        {hasPv && powerVisibility.visible('pv') && <Area yAxisId="power" type="monotone" dataKey="pv" name={seriesByKey.pv.label} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} />}
                        {powerVisibility.visible('base') && <Area yAxisId="power" type="step" dataKey="base" stackId="load" name={seriesByKey.base.label} fill={COLORS.base} strokeWidth={0} />}
                        {showBoilerAggregate && powerVisibility.visible('boiler') && <Area yAxisId="power" type="step" dataKey="boiler" stackId="load" name={seriesByKey.boiler.label} fill={COLORS.boiler} strokeWidth={0} />}
                        {showPoolAggregate && powerVisibility.visible('pool') && <Area yAxisId="power" type="step" dataKey="pool" stackId="load" name={seriesByKey.pool.label} fill={COLORS.pool} strokeWidth={0} />}
                        {showEvAggregate && powerVisibility.visible('ev') && <Area yAxisId="power" type="step" dataKey="ev" stackId="load" name={seriesByKey.ev.label} fill={COLORS.ev} strokeWidth={0} />}
                        {deviceSeries.map(series => powerVisibility.visible(series.key) && (
                          <Area key={series.key} yAxisId="power" type="step" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
                        ))}
                        {powerVisibility.visible('gridImport') && <Line yAxisId="power" type="step" dataKey="gridImport" name={seriesByKey.gridImport.label} stroke={COLORS.import} dot={false} />}
                        {powerVisibility.visible('gridExport') && <Line yAxisId="power" type="step" dataKey="gridExport" name={seriesByKey.gridExport.label} stroke={COLORS.export} dot={false} />}
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={(value, name) => [`${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
                      </ComposedChart>
                    </ResponsiveContainer>
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
                  </>
    </>
  );
};

export default PowerSection;
