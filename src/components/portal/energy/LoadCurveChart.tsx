import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPower } from '@/lib/energy-units';

interface LoadPoint {
  time: string;
  total: number;
  heating?: number;
  ev?: number;
  appliance?: number;
  base?: number;
}

interface LoadCurveChartProps {
  title: string;
  data: LoadPoint[];
  peakW?: number;
  height?: number;
}

const LoadCurveChart: React.FC<LoadCurveChartProps> = ({
  title,
  data,
  peakW,
  height = 300,
}) => {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="time" className="text-xs" />
            <YAxis
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}` : `${v}`}
              label={{ value: data.some(d => d.total >= 1000) ? 'kW' : 'W', angle: -90, position: 'insideLeft' }}
              className="text-xs"
            />
            <Tooltip formatter={(value: number) => [formatPower(value).display]} />
            {peakW && (
              <ReferenceLine y={peakW} stroke="hsl(var(--destructive))" strokeDasharray="5 5" label={`Peak: ${formatPower(peakW).display}`} />
            )}
            <Area type="monotone" dataKey="base" stackId="1" fill="hsl(var(--muted))" stroke="hsl(var(--muted-foreground))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="heating" stackId="1" fill="hsl(var(--primary))" stroke="hsl(var(--primary))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="ev" stackId="1" fill="hsl(var(--accent))" stroke="hsl(var(--accent-foreground))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="appliance" stackId="1" fill="hsl(var(--secondary))" stroke="hsl(var(--secondary-foreground))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="total" fill="none" stroke="hsl(var(--foreground))" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
};

export default LoadCurveChart;
