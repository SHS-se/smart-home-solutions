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
  xLabel: string;
  yLabel: string;
  dataKey?: string;
  color?: string;
  height?: number;
}

const PerformanceCurveChart: React.FC<PerformanceCurveChartProps> = ({
  title,
  data,
  xLabel,
  yLabel,
  color = 'hsl(var(--primary))',
  height = 250,
}) => {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="x" label={{ value: xLabel, position: 'insideBottom', offset: -5 }} className="text-xs" />
            <YAxis label={{ value: yLabel, angle: -90, position: 'insideLeft' }} className="text-xs" />
            <Tooltip />
            <Line type="monotone" dataKey="y" stroke={color} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
};

export default PerformanceCurveChart;
