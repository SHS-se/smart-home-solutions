import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface CurvePoint {
  x: number;
  y: number;
}

interface PerformanceCurveChartProps {
  title: string;
  data: CurvePoint[];
  secondaryData?: CurvePoint[];
  xLabel: string;
  yLabel: string;
  secondaryYLabel?: string;
  dataKey?: string;
  color?: string;
  secondaryColor?: string;
  height?: number;
  hideCard?: boolean;
}

const PerformanceCurveChart: React.FC<PerformanceCurveChartProps> = ({
  title,
  data,
  secondaryData,
  xLabel,
  yLabel,
  secondaryYLabel,
  color = 'hsl(var(--primary))',
  secondaryColor = 'hsl(var(--destructive))',
  height = 250,
  hideCard = false,
}) => {
  const hasDualAxis = secondaryData && secondaryData.length > 0;

  // Merge data for dual-axis
  const mergedData = hasDualAxis
    ? data.map((p, i) => ({
        x: p.x,
        y: p.y,
        y2: secondaryData[i]?.y ?? null,
      }))
    : data;

  const chart = (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={mergedData}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="x" label={{ value: xLabel, position: 'insideBottom', offset: -5 }} className="text-xs" />
        <YAxis yAxisId="left" label={{ value: yLabel, angle: -90, position: 'insideLeft' }} className="text-xs" />
        {hasDualAxis && (
          <YAxis yAxisId="right" orientation="right" label={{ value: secondaryYLabel || '', angle: 90, position: 'insideRight' }} className="text-xs" />
        )}
        <Tooltip />
        {hasDualAxis && <Legend />}
        <Line yAxisId="left" type="monotone" dataKey="y" name={yLabel} stroke={color} strokeWidth={2} dot={{ r: 3 }} />
        {hasDualAxis && (
          <Line yAxisId="right" type="monotone" dataKey="y2" name={secondaryYLabel || ''} stroke={secondaryColor} strokeWidth={2} dot={{ r: 3 }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );

  if (hideCard) return chart;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>{chart}</CardContent>
    </Card>
  );
};

export default PerformanceCurveChart;
