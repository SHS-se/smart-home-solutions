// The Economics tab's chart.
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
import type { EconomicsSeriesKey } from '../types';

const EconomicsSection: React.FC<{ model: PlanModel }> = ({ model }) => {
  const { t } = useLanguage();
  const economicsVisibility = useSeriesVisibility<EconomicsSeriesKey>();
  const {
    plan,
    economicsData,
    bindingIndex,
    ticks,
    economicsSeries,
  } = model;

  return (
    <>
      <>
                    <ResponsiveContainer width="100%" height={360}>
                      <ComposedChart data={economicsData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                        <XAxis dataKey="i" type="number" domain={[0, economicsData.length - 1]} ticks={ticks} tickFormatter={index => economicsData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                        <YAxis yAxisId="price" tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(2)} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                        <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(0)} label={{ value: 'SEK', angle: 90, position: 'insideRight', fontSize: 11 }} />
                        {bindingIndex < economicsData.length && <ReferenceArea yAxisId="price" x1={bindingIndex} x2={economicsData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
                        {economicsVisibility.visible('importPrice') && <Line yAxisId="price" type="stepAfter" dataKey="importPrice" name={economicsSeries[0].label} stroke={COLORS.import} dot={false} connectNulls={false} />}
                        {economicsVisibility.visible('exportPrice') && <Line yAxisId="price" type="stepAfter" dataKey="exportPrice" name={economicsSeries[1].label} stroke={COLORS.export} dot={false} connectNulls={false} />}
                        {economicsVisibility.visible('plannedCost') && <Line yAxisId="cost" type="monotone" dataKey="plannedCost" name={economicsSeries[2].label} stroke="#2563eb" strokeWidth={2} dot={false} connectNulls={false} />}
                        {economicsVisibility.visible('unplannedCost') && <Line yAxisId="cost" type="monotone" dataKey="unplannedCost" name={economicsSeries[3].label} stroke="#64748b" strokeWidth={2} dot={false} connectNulls={false} />}
                        {economicsVisibility.visible('costDifference') && <Line yAxisId="cost" type="monotone" dataKey="costDifference" name={economicsSeries[4].label} stroke="#a855f7" strokeDasharray="4 3" dot={false} connectNulls={false} />}
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => economicsData[index as number]?.label ?? ''} formatter={(value, name) => [name === economicsSeries[0].label || name === economicsSeries[1].label ? `${Number(value).toFixed(3)} SEK/kWh` : `${Number(value).toFixed(2)} SEK`, name]} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <SeriesToggleLegend
                      series={economicsSeries}
                      hidden={economicsVisibility.hidden}
                      onToggle={economicsVisibility.toggle}
                      ariaLabel={t('Ekonomiserier', 'Economics series')}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('Priset visas tillsammans med den kostnad det faktiskt skapar i planen. Positiv kostnadsskillnad betyder merkostnad; negativ betyder uppskattad besparing.', 'Price is shown with the cost it actually creates in the plan. A positive cost difference means added cost; a negative value means estimated savings.')}
                    </p>
                  </>
    </>
  );
};

export default EconomicsSection;
