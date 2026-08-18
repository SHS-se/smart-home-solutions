// The Economics tab's chart.
//
// Split out of PlanView on 2026-08-13. Extended on 2026-08-18 to answer the
// question it was always asked and never could: *which of these prices are
// real?* Nord Pool publishes roughly one day of a 72-hour horizon, so two
// thirds of every plan is decided against the home's own measured price shape
// (§1.4.2). Those modelled prices existed only inside the planner, so the chart
// simply stopped at the day-ahead boundary — leaving the impression that the
// far half of the plan had no prices at all, rather than modelled ones.
//
// They are drawn as separate, dashed series on purpose. A single line that
// silently changes meaning halfway along would be worse than not drawing it.

import React, { useMemo } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import type { DayWindow } from '@/lib/energy-shift/energy-timeline';
import { COLORS } from '../types';
import { DayWindowToggle, SeriesToggleLegend, useSeriesVisibility } from '../ui';
import StoreDecisions from '../StoreDecisions';
import type { PlanModel } from '../usePlanModel';
import type { EconomicsSeriesKey } from '../types';

/** Series drawn against the right-hand power axis rather than the price axis. */
const POWER_KEYS: EconomicsSeriesKey[] = ['solarW', 'loadW', 'gridImportW', 'gridExportW'];

const EconomicsSection: React.FC<{
  model: PlanModel;
  dayWindow: DayWindow;
  dayWindowOptions: DayWindow[];
  onDayWindowChange: (value: DayWindow) => void;
  /** The same window the plan tab is showing, so the two tabs agree. */
  windowStart: string | null;
  windowEnd: string | null;
}> = ({ model, dayWindow, dayWindowOptions, onDayWindowChange, windowStart, windowEnd }) => {
  const { t } = useLanguage();
  const economicsVisibility = useSeriesVisibility<EconomicsSeriesKey>();
  const { economicsData, economicsSeries } = model;

  // Looked up by key, never by position. Indexing this array by number is what
  // took the whole tab down when the cumulative-cost series were removed: the
  // chart still asked for `economicsSeries[2].label` and got undefined at run
  // time, which no amount of type checking catches for an array index.
  const labelOf = (key: EconomicsSeriesKey) =>
    economicsSeries.find(series => series.key === key)?.label ?? key;

  // The plan covers issue time to +72 h, so a day earlier than that has no
  // prices to explain. Re-indexed after filtering because the axis is drawn
  // over positions rather than timestamps.
  const windowed = useMemo(() => {
    const from = windowStart ? Date.parse(windowStart) : null;
    const to = windowEnd ? Date.parse(windowEnd) : null;
    const rows = from === null || to === null
      ? economicsData
      : economicsData.filter(row => row.startMs >= from && row.startMs <= to);
    return rows.map((row, index) => ({ ...row, i: index }));
  }, [economicsData, windowEnd, windowStart]);

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

  // Where the published prices stop and the modelled ones take over, in this
  // window's own coordinates.
  const firstModelled = windowed.findIndex(row => row.modelled);
  const anyPower = POWER_KEYS.some(key => economicsVisibility.visible(key));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(
            'Priser och flöden för den valda perioden.',
            'Prices and flows for the selected period.',
          )}
        </p>
        <DayWindowToggle value={dayWindow} options={dayWindowOptions} onChange={onDayWindowChange} />
      </div>

      {windowed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'Den här perioden ligger före den aktuella planen, så den har inga planerade priser.',
            'This period is before the current plan, so it carries no planned prices.',
          )}
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={windowed} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis dataKey="i" type="number" domain={[0, windowed.length - 1]} ticks={ticks} tickFormatter={index => windowed[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
              <YAxis yAxisId="price" tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(2)} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <YAxis yAxisId="power" orientation="right" tick={{ fontSize: 11 }} tickFormatter={value => `${(Number(value) / 1000).toFixed(1)}`} label={{ value: 'kW', angle: 90, position: 'insideRight', fontSize: 11 }} hide={!anyPower} />
              {/*
                A labelled boundary rather than a shaded band: the dash already
                says "modelled", and this says exactly where the market stopped
                quoting. A faint background wash said neither clearly.
              */}
              {firstModelled > 0 && (
                <ReferenceLine
                  yAxisId="price"
                  x={firstModelled}
                  stroke="currentColor"
                  className="text-muted-foreground"
                  strokeDasharray="3 3"
                  label={{
                    value: t('modellerat härifrån', 'modelled from here'),
                    position: 'insideTopRight',
                    fontSize: 10,
                  }}
                />
              )}
              {economicsVisibility.visible('solarW') && <Area yAxisId="power" type="monotone" dataKey="solarW" name={labelOf('solarW')} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.16} dot={false} />}
              {economicsVisibility.visible('loadW') && <Line yAxisId="power" type="monotone" dataKey="loadW" name={labelOf('loadW')} stroke={COLORS.base} strokeWidth={1.5} dot={false} />}
              {economicsVisibility.visible('gridImportW') && <Line yAxisId="power" type="stepAfter" dataKey="gridImportW" name={labelOf('gridImportW')} stroke={COLORS.import} strokeWidth={1.5} strokeOpacity={0.55} dot={false} />}
              {economicsVisibility.visible('gridExportW') && <Line yAxisId="power" type="stepAfter" dataKey="gridExportW" name={labelOf('gridExportW')} stroke={COLORS.export} strokeWidth={1.5} strokeOpacity={0.55} dot={false} />}
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
              'Heldragna prislinjer är publicerade marknadspriser. Streckade linjer, efter markeringen, är modellerade: Nord Pool publicerar bara ett dygn i taget, så resten av horisonten prissätts med husets egen uppmätta priskurva. Planeraren räknar i kronor hela vägen — men bara den heldragna delen är ett faktiskt marknadspris.',
              'Solid price lines are published market prices. Dashed lines, past the marker, are modelled: Nord Pool publishes only a day at a time, so the rest of the horizon is priced from this home’s own measured price shape. The planner reasons in kronor throughout — but only the solid part is an actual quoted price.',
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
        <StoreDecisions model={model} windowStart={windowStart} windowEnd={windowEnd} />
      </div>
    </>
  );
};

export default EconomicsSection;
