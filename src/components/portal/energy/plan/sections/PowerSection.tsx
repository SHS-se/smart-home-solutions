// The live power chart shown in the Plan workspace.

import React from 'react';
import {
  Area, Line, ReferenceArea,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import { COLORS } from '../types';
import { SeriesToggleLegend, useSeriesVisibility } from '../ui';
import type { PlanModel } from '../usePlanModel';
import type { PlanChartSeriesKey } from '../types';
import EnergyPowerChart from '../EnergyPowerChart';

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
      <EnergyPowerChart data={chartData} ticks={ticks}>
        {bindingIndex < chartData.length && <ReferenceArea yAxisId="power" x1={bindingIndex} x2={chartData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
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
    </>
  );
};

export default PowerSection;
