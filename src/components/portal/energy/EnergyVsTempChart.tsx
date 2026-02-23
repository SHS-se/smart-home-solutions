import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergyVsTempChartProps {
  title: string;
  data: Array<{ tempC: number; dailyKwh: number }>;
  currentTemp?: number;
  height?: number;
}

const EnergyVsTempChart: React.FC<EnergyVsTempChartProps> = ({
  title,
  data,
  currentTemp,
  height = 300,
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
            <XAxis
              dataKey="tempC"
              className="text-xs"
              label={{ value: '°C', position: 'insideBottomRight', offset: -5 }}
            />
            <YAxis
              className="text-xs"
              label={{ value: 'kWh/day', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              formatter={(value: number) => [`${value} kWh`, 'Daily Energy']}
              labelFormatter={(label: number) => `${label} °C`}
            />
            {currentTemp !== undefined && (
              <ReferenceLine
                x={currentTemp}
                stroke="hsl(var(--destructive))"
                strokeDasharray="5 5"
                label={{ value: `${currentTemp}°C`, position: 'top', fill: 'hsl(var(--destructive))' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="dailyKwh"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
};

export default EnergyVsTempChart;
