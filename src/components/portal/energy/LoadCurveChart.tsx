import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Line, ComposedChart } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPower } from '@/lib/energy-units';

interface LoadPoint {
  time: string;
  total: number;
  heating?: number;
  shiftable?: number;
  fixedActive?: number;
  base?: number;
}

interface MeasuredOverlayPoint {
  time: string;
  power: number;
}

interface LoadCurveChartProps {
  title: string;
  data: LoadPoint[];
  peakW?: number;
  height?: number;
  measuredOverlay?: MeasuredOverlayPoint[];
}

const LoadCurveChart: React.FC<LoadCurveChartProps> = ({
  title,
  data,
  peakW,
  height = 300,
  measuredOverlay,
}) => {
  // Merge measured overlay into chart data if provided
  const chartData = React.useMemo(() => {
    if (!measuredOverlay || measuredOverlay.length === 0) return data;
    const measuredMap = new Map(measuredOverlay.map(p => [p.time, p.power]));
    return data.map(d => ({
      ...d,
      measured: measuredMap.get(d.time) ?? undefined,
    }));
  }, [data, measuredOverlay]);

  const hasMeasured = measuredOverlay && measuredOverlay.length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis dataKey="time" className="text-xs" />
            <YAxis
              tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}` : `${v}`}
              label={{ value: chartData.some(d => d.total >= 1000) ? 'kW' : 'W', angle: -90, position: 'insideLeft' }}
              className="text-xs"
            />
            <Tooltip formatter={(value: number, name: string) => [formatPower(value).display, name === 'measured' ? 'Measured' : name]} />
            {peakW && (
              <ReferenceLine y={peakW} stroke="hsl(var(--destructive))" strokeDasharray="5 5" label={`Peak: ${formatPower(peakW).display}`} />
            )}
            <Area type="monotone" dataKey="base" stackId="1" fill="hsl(var(--muted))" stroke="hsl(var(--muted-foreground))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="heating" stackId="1" fill="hsl(var(--primary))" stroke="hsl(var(--primary))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="shiftable" stackId="1" fill="hsl(var(--accent))" stroke="hsl(var(--accent-foreground))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="fixedActive" stackId="1" fill="hsl(var(--secondary))" stroke="hsl(var(--secondary-foreground))" fillOpacity={0.4} />
            <Area type="monotone" dataKey="total" fill="none" stroke="hsl(var(--foreground))" strokeWidth={2} />
            {hasMeasured && (
              <Line type="monotone" dataKey="measured" stroke="hsl(var(--destructive))" strokeWidth={2} strokeDasharray="6 3" dot={false} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
};

export default LoadCurveChart;
