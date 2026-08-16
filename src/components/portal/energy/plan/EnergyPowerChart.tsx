import React from 'react';
import {
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface EnergyChartRow {
  i: number;
  label: string;
}

// Room for the "now" divider's label, which sits above the plot area.
const CHART_MARGIN = { top: 22, right: 10, left: 0, bottom: 4 };

/** Series drawn against the right-hand percentage axis rather than kW. */
const PERCENT_SERIES = new Set(['homeSoc', 'evSoc']);

/** Only the real range is labelled; the domain may reach below zero. */
const SOC_TICKS = [0, 25, 50, 75, 100];

/** Below this a device is off, matching the threshold the legend filters on. */
const ACTIVE_POWER_W = 0.5;

interface TooltipEntry {
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
  dataKey?: string | number;
}

/**
 * The default tooltip lists every series in the chart, so a house with twenty
 * meters produced twenty lines to read, nearly all of them "0.00 kW", and the
 * two or three that were actually running were lost among them. Only series
 * carrying something are worth a line.
 *
 * A state of charge is kept whenever it is known, including a genuine zero: an
 * empty battery is a reading, not an absence.
 */
const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  rows: EnergyChartRow[];
}> = ({ active, payload, label, rows }) => {
  if (!active) return null;
  const heading = rows[Number(label)]?.label ?? '';
  const entries = (payload ?? []).filter(entry => {
    const value = Number(entry.value);
    if (!Number.isFinite(value)) return false;
    return PERCENT_SERIES.has(String(entry.dataKey))
      ? true
      : Math.abs(value) >= ACTIVE_POWER_W;
  });
  return (
    <div className="rounded-lg border bg-background px-2.5 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{heading}</div>
      {entries.length === 0
        ? <div className="text-muted-foreground">—</div>
        : entries.map(entry => (
          <div key={String(entry.dataKey)} className="flex items-baseline justify-between gap-4">
            <span style={{ color: entry.color }}>{entry.name}</span>
            <span className="tabular-nums">
              {PERCENT_SERIES.has(String(entry.dataKey))
                ? `${Number(entry.value).toFixed(0)} %`
                : `${(Number(entry.value) / 1_000).toFixed(2)} kW`}
            </span>
          </div>
        ))}
    </div>
  );
};

const EnergyPowerChart = <Row extends EnergyChartRow>({
  data,
  ticks,
  showPercentAxis = false,
  powerDomain,
  socDomain,
  children,
}: {
  data: Row[];
  ticks: number[];
  /** State of charge shares the chart but not the unit. */
  showPercentAxis?: boolean;
  /** Both domains are fixed by the caller so their zeros coincide. */
  powerDomain?: [number, number];
  socDomain?: [number, number];
  children: React.ReactNode;
}) => (
  <ResponsiveContainer width="100%" height={360}>
    <ComposedChart data={data} margin={CHART_MARGIN}>
      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
      <XAxis
        dataKey="i"
        type="number"
        domain={[0, Math.max(0, data.length - 1)]}
        ticks={ticks}
        tickFormatter={index => data[index]?.label ?? ''}
        tick={{ fontSize: 11 }}
        interval={0}
      />
      <YAxis
        yAxisId="power"
        domain={powerDomain ?? ['auto', 'auto']}
        allowDataOverflow={powerDomain !== undefined}
        tick={{ fontSize: 11 }}
        tickFormatter={watts => `${(Number(watts) / 1_000).toFixed(0)}`}
        label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }}
      />
      {showPercentAxis && (
        <YAxis
          yAxisId="soc"
          orientation="right"
          domain={socDomain ?? [0, 100]}
          ticks={SOC_TICKS}
          allowDataOverflow
          tick={{ fontSize: 11 }}
          tickFormatter={value => `${Number(value).toFixed(0)}%`}
        />
      )}
      {children}
      <Tooltip content={<ChartTooltip rows={data} />} />
    </ComposedChart>
  </ResponsiveContainer>
);

export default EnergyPowerChart;
