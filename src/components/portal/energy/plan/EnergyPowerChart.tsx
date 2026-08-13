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

const CHART_MARGIN = { top: 8, right: 10, left: 0, bottom: 4 };

const EnergyPowerChart = <Row extends EnergyChartRow>({
  data,
  ticks,
  children,
}: {
  data: Row[];
  ticks: number[];
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
        tick={{ fontSize: 11 }}
        tickFormatter={watts => `${(Number(watts) / 1_000).toFixed(0)}`}
        label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }}
      />
      {children}
      <Tooltip
        contentStyle={{ fontSize: 12, borderRadius: 8 }}
        labelFormatter={index => data[index as number]?.label ?? ''}
        formatter={(value, name) => [`${(Number(value) / 1_000).toFixed(2)} kW`, name]}
      />
    </ComposedChart>
  </ResponsiveContainer>
);

export default EnergyPowerChart;
