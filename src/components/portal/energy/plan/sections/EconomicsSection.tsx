// The Economics tab's chart.
//
// Split out of PlanView on 2026-08-13, and rebuilt on 2026-08-18 onto the same
// timeline the power chart uses. It used to read the plan alone, which meant a
// historical day had no prices and no flows at all — the two tabs disagreed
// about what a day even was. Both now read `TimelineRow`, so a past day shows
// measured prices against measured flows and the future side shows planned
// ones, with "now" marked between them.
//
// Two conventions are inherited from the power chart deliberately, because a
// reader moving between tabs should not have to relearn the axes: energy
// leaving the house is drawn negative, and every flow is a step rather than a
// curve. Smoothing a line through quarter-hour setpoints invents values between
// the samples that the plan never contained.
//
// The third is new. The price axis and the power axis share a zero: with export
// drawn negative they would otherwise put "nothing" at two different heights,
// and no comparison across the chart would be safe.

import React, { useMemo } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import type { DayWindow, TimelineRange, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import { sharedZeroAxes } from '@/lib/energy-shift/chart-axes';
import { COLORS } from '../types';
import { DayWindowToggle, SeriesToggleLegend, useSeriesVisibility } from '../ui';
import StoreDecisions from '../StoreDecisions';
import type { PlanModel } from '../usePlanModel';
import type { EconomicsSeriesKey } from '../types';

/** Series drawn against the right-hand power axis rather than the price axis. */
const POWER_KEYS: EconomicsSeriesKey[] = ['solarW', 'loadW', 'gridImportW', 'gridExportW'];

const EconomicsSection: React.FC<{
  model: PlanModel;
  rows: TimelineRow[];
  range: TimelineRange;
  dayWindow: DayWindow;
  dayWindowOptions: DayWindow[];
  onDayWindowChange: (value: DayWindow) => void;
}> = ({ model, rows, range, dayWindow, dayWindowOptions, onDayWindowChange }) => {
  const { t } = useLanguage();
  const economicsVisibility = useSeriesVisibility<EconomicsSeriesKey>();
  const { economicsSeries } = model;

  // Looked up by key, never by position. Indexing this array by number is what
  // took the whole tab down when the cumulative-cost series were removed: the
  // chart still asked for `economicsSeries[2].label` and got undefined at run
  // time, which no amount of type checking catches for an array index.
  const labelOf = (key: EconomicsSeriesKey) =>
    economicsSeries.find(series => series.key === key)?.label ?? key;

  const windowed = useMemo(() => rows.slice(range.from, range.to).map((row, index) => ({
    i: index,
    startMs: row.startMs,
    measured: row.measured,
    label: new Date(row.startMs).toLocaleString([], {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }),
    importPrice: row.importPriceSekPerKwh,
    exportPrice: row.exportPriceSekPerKwh,
    shadowImportPrice: row.shadowImportSekPerKwh,
    shadowExportPrice: row.shadowExportSekPerKwh,
    solarW: row.solarW,
    loadW: row.loadW,
    gridImportW: row.gridImportW,
    // Already negative on the timeline, exactly as the power chart draws it.
    gridExportW: row.gridExportW,
  })), [range.from, range.to, rows]);

  const ticks = useMemo(
    () => windowed
      .filter(row => {
        const start = new Date(row.startMs);
        return start.getMinutes() === 0
          && start.getHours() % (dayWindow === 'all' ? 6 : 3) === 0;
      })
      .map(row => row.i),
    [dayWindow, windowed],
  );

  const axes = useMemo(() => sharedZeroAxes({
    priceMax: Math.max(
      0,
      ...windowed.map(row => Math.max(row.importPrice ?? 0, row.shadowImportPrice ?? 0)),
    ),
    powerMaxW: Math.max(
      0,
      ...windowed.map(row => Math.max(row.solarW ?? 0, row.loadW ?? 0, row.gridImportW ?? 0)),
    ),
    powerMinW: Math.min(0, ...windowed.map(row => row.gridExportW ?? 0)),
  }), [windowed]);

  // Where measured stops and planned begins, and where quoted prices give out.
  const firstPlanned = windowed.findIndex(row => !row.measured);
  const firstModelled = windowed.findIndex(row => row.shadowImportPrice !== null);
  const windowStart = windowed[0]
    ? new Date(windowed[0].startMs).toISOString()
    : null;
  const last = windowed.at(-1);
  const windowEnd = last ? new Date(last.startMs).toISOString() : null;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(
            'Priser och flöden för den valda perioden. Uppmätta kvartar visar verkliga tal, planerade visar planens.',
            'Prices and flows for the selected period. Measured quarters show actuals; planned quarters show the plan.',
          )}
        </p>
        <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
      </div>

      {windowed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('Inga kvartar i den valda perioden.', 'No quarters in the selected period.')}
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={windowed} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis dataKey="i" type="number" domain={[0, windowed.length - 1]} ticks={ticks} tickFormatter={index => windowed[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
              <YAxis yAxisId="price" domain={axes.price.domain} ticks={axes.price.ticks} interval={0} tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(axes.price.decimals)} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <YAxis yAxisId="power" orientation="right" domain={axes.power.domain} ticks={axes.power.ticks} interval={0} tick={{ fontSize: 11 }} tickFormatter={value => (Number(value) / 1000).toFixed(axes.power.decimals)} label={{ value: 'kW', angle: 90, position: 'insideRight', fontSize: 11 }} />
              <ReferenceLine yAxisId="power" y={0} stroke="currentColor" className="text-muted-foreground" strokeOpacity={0.5} />
              {firstPlanned > 0 && (
                <ReferenceLine yAxisId="price" x={firstPlanned} stroke="currentColor" className="text-foreground" strokeOpacity={0.6} label={{ value: t('nu', 'now'), position: 'insideTopLeft', fontSize: 10 }} />
              )}
              {firstModelled > 0 && (
                <ReferenceLine yAxisId="price" x={firstModelled} stroke="currentColor" className="text-muted-foreground" strokeDasharray="3 3" label={{ value: t('modellerat härifrån', 'modelled from here'), position: 'insideTopRight', fontSize: 10 }} />
              )}
              {economicsVisibility.visible('solarW') && <Area yAxisId="power" type="monotone" dataKey="solarW" name={labelOf('solarW')} stroke={COLORS.pv} strokeWidth={1.5} fill={COLORS.pv} fillOpacity={0.22} dot={false} connectNulls={false} />}
              {economicsVisibility.visible('loadW') && <Area yAxisId="power" type="stepAfter" dataKey="loadW" name={labelOf('loadW')} stroke={COLORS.base} strokeWidth={1.8} fill={COLORS.base} fillOpacity={0.28} dot={false} connectNulls={false} />}
              {economicsVisibility.visible('gridImportW') && <Line yAxisId="power" type="stepAfter" dataKey="gridImportW" name={labelOf('gridImportW')} stroke={COLORS.import} strokeWidth={1.5} strokeOpacity={0.55} dot={false} connectNulls={false} />}
              {economicsVisibility.visible('gridExportW') && <Line yAxisId="power" type="stepAfter" dataKey="gridExportW" name={labelOf('gridExportW')} stroke={COLORS.export} strokeWidth={1.5} strokeOpacity={0.55} dot={false} connectNulls={false} />}
              {economicsVisibility.visible('importPrice') && <Line yAxisId="price" type="stepAfter" dataKey="importPrice" name={labelOf('importPrice')} stroke={COLORS.import} strokeWidth={2} dot={false} connectNulls={false} />}
              {economicsVisibility.visible('exportPrice') && <Line yAxisId="price" type="stepAfter" dataKey="exportPrice" name={labelOf('exportPrice')} stroke={COLORS.export} strokeWidth={2} dot={false} connectNulls={false} />}
              {economicsVisibility.visible('shadowImportPrice') && <Line yAxisId="price" type="stepAfter" dataKey="shadowImportPrice" name={labelOf('shadowImportPrice')} stroke={COLORS.import} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />}
              {economicsVisibility.visible('shadowExportPrice') && <Line yAxisId="price" type="stepAfter" dataKey="shadowExportPrice" name={labelOf('shadowExportPrice')} stroke={COLORS.export} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />}
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                labelFormatter={index => windowed[index as number]?.label ?? ''}
                formatter={(value, name, entry) => [
                  POWER_KEYS.includes((entry?.dataKey ?? '') as EconomicsSeriesKey)
                    ? `${(Number(value) / 1000).toFixed(2)} kW`
                    : `${Number(value).toFixed(3)} SEK/kWh`,
                  name,
                ]}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <SeriesToggleLegend
            series={economicsSeries}
            hidden={economicsVisibility.hidden}
            onToggle={economicsVisibility.toggle}
            ariaLabel={t('Ekonomiserier', 'Economics series')}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'Nätexport ritas negativt: energi som lämnar huset. Pris- och effektaxeln delar nollinje. Heldragna prislinjer är verkliga priser — uppmätta före "nu", publicerade av Nord Pool efter. Streckade linjer är modellerade: Nord Pool publicerar bara ett dygn i taget, så resten av horisonten prissätts med husets egen uppmätta priskurva.',
              'Grid export is drawn negative: energy leaving the house. The price and power axes share a zero line. Solid price lines are real prices — measured before "now", published by Nord Pool after it. Dashed lines are modelled: Nord Pool publishes only a day at a time, so the rest of the horizon is priced from this home’s own measured price shape.',
            )}
          </p>
        </>
      )}

      {/*
        The same explanation the plan tab carries. A reader looking at prices is
        asking what the prices bought, and sending them to another tab for the
        answer is how the two halves of one decision came to live apart.
      */}
      <div className="mt-6 border-t pt-6">
        <StoreDecisions model={model} rows={rows} range={range} />
      </div>
    </>
  );
};

export default EconomicsSection;
