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

  // Looked up by key, never by position. Indexing this array by number is what
  // took the whole tab down when the cumulative-cost series were removed: the
  // chart still asked for `economicsSeries[2].label` and got undefined at run
  // time, which no amount of type checking catches for an array index.
  const labelOf = (key: EconomicsSeriesKey) =>
    economicsSeries.find(series => series.key === key)?.label ?? key;

  return (
    <>
      <>
                    <ResponsiveContainer width="100%" height={360}>
                      <ComposedChart data={economicsData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                        <XAxis dataKey="i" type="number" domain={[0, economicsData.length - 1]} ticks={ticks} tickFormatter={index => economicsData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                        <YAxis yAxisId="price" tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(2)} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                        {bindingIndex < economicsData.length && <ReferenceArea yAxisId="price" x1={bindingIndex} x2={economicsData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
                        {economicsVisibility.visible('importPrice') && <Line yAxisId="price" type="stepAfter" dataKey="importPrice" name={labelOf('importPrice')} stroke={COLORS.import} dot={false} connectNulls={false} />}
                        {economicsVisibility.visible('exportPrice') && <Line yAxisId="price" type="stepAfter" dataKey="exportPrice" name={labelOf('exportPrice')} stroke={COLORS.export} dot={false} connectNulls={false} />}
                        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => economicsData[index as number]?.label ?? ''} formatter={(value, name) => [`${Number(value).toFixed(3)} SEK/kWh`, name]} />
                      </ComposedChart>
                    </ResponsiveContainer>
                    <SeriesToggleLegend
                      series={economicsSeries}
                      hidden={economicsVisibility.hidden}
                      onToggle={economicsVisibility.toggle}
                      ariaLabel={t('Ekonomiserier', 'Economics series')}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('Köp- och säljpris per kvart. Kurvorna nedanför visar vad varje lager är värt i samma enhet, så du kan se vilket pris det slår.', 'Import and export price per quarter. The value curves below are drawn in the same unit, so you can see which price each store beats.')}
                    </p>
                  </>
    </>
  );
};

export default EconomicsSection;
