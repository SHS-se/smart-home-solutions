import React, { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import {
  buildEnergyPriceInflation,
  type EnergyPriceInflationPoint,
  type EnergyPriceInflationSourceSummary,
} from '@/lib/energy-price-inflation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergyPriceInflationCardProps {
  months: EnergyBillingMonth[];
}

interface InflationTooltipProps {
  active?: boolean;
  label?: string;
  payload?: Array<{ payload?: EnergyPriceInflationPoint }>;
  formatMonth: (monthKey: string) => string;
  formatPrice: (value: number) => string;
  formatIndex: (value: number) => string;
  gridLabel: string;
  electricityLabel: string;
}

const GRID_COLOR = '#0d9488';
const ELECTRICITY_COLOR = '#f97316';

function InflationTooltip({
  active,
  label,
  payload,
  formatMonth,
  formatPrice,
  formatIndex,
  gridLabel,
  electricityLabel,
}: InflationTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !label || !point) return null;

  const rows = [
    {
      label: gridLabel,
      color: GRID_COLOR,
      index: point.gridIndex,
      price: point.gridSekPerKwh,
    },
    {
      label: electricityLabel,
      color: ELECTRICITY_COLOR,
      index: point.electricityIndex,
      price: point.electricitySekPerKwh,
    },
  ].filter((row) => row.index !== null && row.price !== null);

  return (
    <div className="rounded-xl border border-border/80 bg-background/95 p-3 shadow-xl backdrop-blur">
      <p className="mb-2 font-medium capitalize">{formatMonth(label)}</p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-6 text-xs">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
              {row.label}
            </span>
            <span className="text-right font-medium tabular-nums">
              {formatIndex(row.index!)}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {formatPrice(row.price!)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function sourceTone(changeRatio: number | null): string {
  if (changeRatio === null || changeRatio === 0) return 'text-foreground';
  return changeRatio > 0
    ? 'text-rose-600 dark:text-rose-400'
    : 'text-emerald-600 dark:text-emerald-400';
}

const EnergyPriceInflationCard: React.FC<EnergyPriceInflationCardProps> = ({ months }) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const inflation = useMemo(() => buildEnergyPriceInflation(months), [months]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }), [locale]);
  const priceFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }), [locale]);
  const percentFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  }), [locale]);
  const indexFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);
  const formatMonth = (monthKey: string) => monthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );
  const formatPrice = (value: number) => (
    `${priceFormatter.format(value)} ${t('kr/kWh', 'SEK/kWh')}`
  );
  const formatIndex = (value: number) => `${t('Index', 'Index')} ${indexFormatter.format(value)}`;

  const renderSummary = (
    label: string,
    color: string,
    summary: EnergyPriceInflationSourceSummary,
  ) => (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </div>
      {summary.changeRatio === null ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {t('Ingen komplett prisperiod', 'No complete price period')}
        </p>
      ) : (
        <>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${sourceTone(summary.changeRatio)}`}>
            {percentFormatter.format(summary.changeRatio)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatPrice(summary.latestSekPerKwh!)}
            {' · '}
            {formatMonth(summary.baselineMonth!)} → {formatMonth(summary.latestMonth!)}
          </p>
        </>
      )}
    </div>
  );

  return (
    <Card className="overflow-hidden border-border/70 shadow-sm">
      <CardHeader className="border-b border-border/60 bg-gradient-to-r from-teal-500/5 to-orange-500/5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-teal-600 p-2 text-white shadow-sm">
            <TrendingUp className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">
              {t('Energiprisinflation', 'Energy price inflation')}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'Index 100 är den första kompletta månaden i visad period. Elnät och elhandel beräknas separat per importerad kWh.',
                'Index 100 is the first complete month in the displayed period. Grid and electricity supplier prices are calculated separately per imported kWh.',
              )}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {renderSummary(t('Elnät', 'Grid'), GRID_COLOR, inflation.grid)}
          {renderSummary(t('Elhandel', 'Electricity supplier'), ELECTRICITY_COLOR, inflation.electricity)}
        </div>

        {inflation.points.length === 0 ? (
          <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed px-6 text-center text-sm text-muted-foreground">
            {t(
              'Kompletta fakturamånader med specificerade rörliga avgifter krävs för att visa prisutvecklingen.',
              'Complete billing months with itemised variable charges are needed to show the price trend.',
            )}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={inflation.points} margin={{ top: 12, right: 12, bottom: 24, left: 8 }}>
              <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
              <XAxis
                dataKey="monthKey"
                minTickGap={24}
                tickFormatter={formatMonth}
                angle={inflation.points.length <= 18 ? -25 : 0}
                textAnchor={inflation.points.length <= 18 ? 'end' : 'middle'}
                height={inflation.points.length <= 18 ? 62 : 32}
                className="text-xs"
              />
              <YAxis
                tickFormatter={(value) => indexFormatter.format(value)}
                label={{ value: t('Prisindex', 'Price index'), angle: -90, position: 'insideLeft' }}
                className="text-xs"
              />
              <Tooltip
                content={(
                  <InflationTooltip
                    formatMonth={formatMonth}
                    formatPrice={formatPrice}
                    formatIndex={formatIndex}
                    gridLabel={t('Elnät', 'Grid')}
                    electricityLabel={t('Elhandel', 'Electricity supplier')}
                  />
                )}
              />
              <Legend />
              <ReferenceLine y={100} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
              <Line
                dataKey="gridIndex"
                name={t('Elnät', 'Grid')}
                type="monotone"
                connectNulls={false}
                stroke={GRID_COLOR}
                strokeWidth={2.5}
                dot={{ r: 3, fill: GRID_COLOR }}
                activeDot={{ r: 5 }}
              />
              <Line
                dataKey="electricityIndex"
                name={t('Elhandel', 'Electricity supplier')}
                type="monotone"
                connectNulls={false}
                stroke={ELECTRICITY_COLOR}
                strokeWidth={2.5}
                dot={{ r: 3, fill: ELECTRICITY_COLOR }}
                activeDot={{ r: 5 }}
              />
              {inflation.points.length > 18 && (
                <Brush
                  dataKey="monthKey"
                  height={26}
                  stroke="#0d9488"
                  tickFormatter={formatMonth}
                  travellerWidth={8}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}

        <p className="text-xs text-muted-foreground">
          {t(
            'Förbrukning och utomhustemperatur påverkar inte indexet. Fasta abonnemangsavgifter, effektavgifter och exportersättning är exkluderade; moms på rörliga avgifter ingår.',
            'Consumption and outdoor temperature do not affect the index. Fixed subscription fees, peak-demand charges, and export credits are excluded; VAT on variable charges is included.',
          )}
        </p>
      </CardContent>
    </Card>
  );
};

export default EnergyPriceInflationCard;
