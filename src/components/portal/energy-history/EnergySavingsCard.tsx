import React, { useMemo } from 'react';
import {
  ArrowDownRight,
  PiggyBank,
  Sun,
  Zap,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import {
  buildMonthlyEnergySavings,
  summariseEnergySavings,
  type MonthlyEnergySaving,
} from '@/lib/energy-savings';
import type { ResolvedUsageReading } from '@/lib/energy-usage-resolution';
import {
  buildMonthlyEnergyFlows,
  toDailyEnergyReadings,
} from '@/lib/energy-usage-series';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface EnergySavingsCardProps {
  /** The billing months currently on screen. */
  months: EnergyBillingMonth[];
  readings: ResolvedUsageReading[];
  periodLabel?: string;
  isSample?: boolean;
  onUploadClick?: () => void;
}

const SAVING_COLORS = {
  avoidedImportSek: '#d97706',
  exportIncomeSek: '#8b5cf6',
};

interface SavingsTooltipProps {
  active?: boolean;
  label?: string;
  savingsByMonth: Map<string, MonthlyEnergySaving>;
  formatMonth: (monthKey: string) => string;
  formatMoney: (value: number) => string;
  formatNumber: (value: number) => string;
  labels: {
    avoided: string;
    export: string;
    saving: string;
    billed: string;
    counterfactual: string;
    measuredDays: string;
    selfConsumed: string;
  };
}

function SavingsTooltip({
  active,
  label,
  savingsByMonth,
  formatMonth,
  formatMoney,
  formatNumber,
  labels,
}: SavingsTooltipProps) {
  const saving = label ? savingsByMonth.get(label) : undefined;
  if (!active || !saving) return null;
  const counterfactual = saving.billedCostSek !== null && saving.savingSek !== null
    ? saving.billedCostSek + saving.savingSek
    : null;
  const rows: Array<{ name: string; value: string; color?: string }> = [];
  if (saving.avoidedImportSek !== null) {
    rows.push({
      name: labels.avoided,
      value: formatMoney(saving.avoidedImportSek),
      color: SAVING_COLORS.avoidedImportSek,
    });
  }
  if (saving.exportIncomeSek !== null) {
    rows.push({
      name: labels.export,
      value: formatMoney(saving.exportIncomeSek),
      color: SAVING_COLORS.exportIncomeSek,
    });
  }
  if (saving.savingSek !== null) {
    rows.push({ name: labels.saving, value: formatMoney(saving.savingSek) });
  }

  return (
    <div className="max-w-xs rounded-xl border border-border/80 bg-background/95 p-3 shadow-xl backdrop-blur">
      <p className="mb-2 font-medium capitalize">{formatMonth(saving.monthKey)}</p>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-5 text-xs">
            <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: row.color ?? 'transparent' }}
              />
              <span className="truncate">{row.name}</span>
            </span>
            <span className="font-medium tabular-nums">{row.value}</span>
          </div>
        ))}
      </div>
      {(saving.billedCostSek !== null || saving.selfConsumedKwh !== null) && (
        <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
          {saving.billedCostSek !== null && (
            <p className="flex items-center justify-between gap-5">
              <span>{labels.billed}</span>
              <span className="tabular-nums">{formatMoney(saving.billedCostSek)}</span>
            </p>
          )}
          {counterfactual !== null && (
            <p className="flex items-center justify-between gap-5">
              <span>{labels.counterfactual}</span>
              <span className="tabular-nums">{formatMoney(counterfactual)}</span>
            </p>
          )}
          {saving.selfConsumedKwh !== null && (
            <p className="flex items-center justify-between gap-5">
              <span>{labels.selfConsumed}</span>
              <span className="tabular-nums">
                {formatNumber(saving.selfConsumedKwh)} kWh
                {' · '}
                {saving.measuredDays} {labels.measuredDays}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The money side of what sits behind the meter.
 *
 * Solar and a battery are sold on a bill that never arrives, which is exactly
 * the thing a chart of kWh cannot show. This card prices the energy the home
 * used without buying it, adds what the grid paid for the surplus, and says
 * plainly how much of the window it could actually measure — an installation
 * commissioned in May has nothing to claim for January, and inventing it would
 * be the fastest way to lose the customer's trust in every other number here.
 */
const EnergySavingsCard: React.FC<EnergySavingsCardProps> = ({
  months,
  readings,
  periodLabel,
  isSample = false,
  onUploadClick,
}) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const moneyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }), [locale]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }), [locale]);
  const rateFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }), [locale]);
  const percentFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }), [locale]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }), [locale]);
  const formatMonthKey = (monthKey: string) => monthFormatter.format(
    new Date(`${monthKey}-01T00:00:00Z`),
  );

  const savings = useMemo(
    () => buildMonthlyEnergySavings(
      months,
      buildMonthlyEnergyFlows(toDailyEnergyReadings(readings)),
    ),
    [months, readings],
  );
  const summary = useMemo(() => summariseEnergySavings(savings), [savings]);
  const savingsByMonth = useMemo(
    () => new Map(savings.map((saving) => [saving.monthKey, saving])),
    [savings],
  );

  const formatMoney = (value: number) => moneyFormatter.format(value);
  const measuredRange = summary.firstMeasuredMonth && summary.lastMeasuredMonth
    ? summary.firstMeasuredMonth === summary.lastMeasuredMonth
      ? formatMonthKey(summary.firstMeasuredMonth)
      : `${formatMonthKey(summary.firstMeasuredMonth)} – ${formatMonthKey(summary.lastMeasuredMonth)}`
    : null;

  return (
    <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="energy-savings">
      <CardHeader className="border-b border-border/60 bg-gradient-to-r from-amber-500/5 via-background to-emerald-500/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <PiggyBank className="h-4 w-4 text-emerald-600" />
              {t('Vad sol och batteri sparade', 'What solar and battery saved')}
            </CardTitle>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {t(
                'Energi som huset använde utan att köpa den, värderad till det pris den hade kostat, plus vad nätet betalade för överskottet.',
                'Energy the home used without buying it, valued at the price it would have cost, plus what the grid paid for the surplus.',
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isSample && (
              <Badge variant="secondary">{t('Exempel', 'Sample')}</Badge>
            )}
            {summary.measuredDays > 0 && (
              <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300">
                {summary.measuredDays} {t('värderade dagar', 'valued days')}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        {summary.savingSek === null ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed px-6 text-center">
            <Sun className="mb-3 h-9 w-9 text-muted-foreground" />
            <p className="text-sm font-medium">
              {t('Ingen besparing kan värderas ännu', 'Nothing can be valued yet')}
            </p>
            <p className="mt-1 max-w-lg text-xs text-muted-foreground">
              {t(
                'Besparingen behöver både en faktura eller tariffberäkning och husets totalförbrukning för samma månad.',
                'Valuing a saving needs both a bill or tariff calculation and the home’s whole-home consumption for the same month.',
              )}
            </p>
            {onUploadClick && (
              <Button type="button" size="sm" className="mt-4" onClick={onUploadClick}>
                {t('Ladda upp energidata', 'Upload energy data')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500/10 via-background to-amber-500/5 p-5 dark:border-emerald-900/70">
              <p className="text-xs text-muted-foreground">
                {t('Sparat under perioden', 'Saved in this period')}
                {periodLabel ? ` · ${periodLabel}` : ''}
              </p>
              <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                {formatMoney(summary.savingSek)}
              </p>
              {summary.savedShare !== null && summary.costWithoutSelfSupplySek !== null && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowDownRight className="h-3.5 w-3.5 text-emerald-600" />
                  {t(
                    `${percentFormatter.format(summary.savedShare)} lägre än de ${formatMoney(summary.costWithoutSelfSupplySek)} samma månader hade kostat utan sol och batteri`,
                    `${percentFormatter.format(summary.savedShare)} below the ${formatMoney(summary.costWithoutSelfSupplySek)} those same months would have cost without solar and battery`,
                  )}
                </p>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-amber-200/80 bg-amber-500/5 p-4 dark:border-amber-900/70">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Sun className="h-4 w-4 text-amber-600" />
                  {t('Undvikna elköp', 'Purchases avoided')}
                </p>
                <p className="mt-2 text-xl font-semibold tabular-nums">
                  {summary.avoidedImportSek === null
                    ? '–'
                    : formatMoney(summary.avoidedImportSek)}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {summary.selfConsumedKwh === null || measuredRange === null
                    ? t(
                        'Ingen månad har både kostnadsunderlag och totalförbrukning',
                        'No month has both a cost record and whole-home consumption',
                      )
                    : t(
                        `${numberFormatter.format(summary.selfConsumedKwh)} kWh bakom mätaren, ${measuredRange}`,
                        `${numberFormatter.format(summary.selfConsumedKwh)} kWh behind the meter, ${measuredRange}`,
                      )}
                </p>
              </div>
              <div className="rounded-xl border border-violet-200/80 bg-violet-500/5 p-4 dark:border-violet-900/70">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Zap className="h-4 w-4 text-violet-600" />
                  {t('Exportersättning', 'Export income')}
                </p>
                <p className="mt-2 text-xl font-semibold tabular-nums">
                  {summary.exportIncomeSek === null
                    ? '–'
                    : formatMoney(summary.exportIncomeSek)}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {summary.exportedKwh === null
                    ? t('Ingen exportdata i perioden', 'No export data in this period')
                    : t(
                        `${numberFormatter.format(summary.exportedKwh)} kWh såld till nätet, netto efter exportavgifter`,
                        `${numberFormatter.format(summary.exportedKwh)} kWh sold to the grid, net of export fees`,
                      )}
                </p>
              </div>
              <div className="rounded-xl border border-blue-200/80 bg-blue-500/5 p-4 dark:border-blue-900/70">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ArrowDownRight className="h-4 w-4 text-blue-600" />
                  {t('Undviket pris', 'Avoided price')}
                </p>
                <p className="mt-2 text-xl font-semibold tabular-nums">
                  {summary.averageAvoidedRateSekPerKwh === null
                    ? '–'
                    : `${rateFormatter.format(summary.averageAvoidedRateSekPerKwh)} ${t('kr/kWh', 'SEK/kWh')}`}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t(
                    'Rörliga avgifter per köpt kWh: elenergi, påslag, överföring, energiskatt och moms',
                    'Variable charges per imported kWh: energy, markups, transfer, energy tax, and VAT',
                  )}
                </p>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={savings} margin={{ top: 12, right: 8, bottom: 24, left: 8 }}>
                <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                <XAxis
                  dataKey="monthKey"
                  minTickGap={24}
                  tickFormatter={formatMonthKey}
                  className="text-xs"
                />
                <YAxis
                  tickFormatter={(value: number) => numberFormatter.format(value)}
                  label={{ value: 'SEK', angle: -90, position: 'insideLeft' }}
                  className="text-xs"
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
                  content={(
                    <SavingsTooltip
                      savingsByMonth={savingsByMonth}
                      formatMonth={formatMonthKey}
                      formatMoney={formatMoney}
                      formatNumber={(value) => numberFormatter.format(value)}
                      labels={{
                        avoided: t('Undvikna elköp', 'Purchases avoided'),
                        export: t('Exportersättning', 'Export income'),
                        saving: t('Total besparing', 'Total saving'),
                        billed: t('Fakturerat', 'Billed'),
                        counterfactual: t('Utan sol och batteri', 'Without solar and battery'),
                        measuredDays: t('värderade dagar', 'valued days'),
                        selfConsumed: t('Bakom mätaren', 'Behind the meter'),
                      }}
                    />
                  )}
                />
                <Legend />
                <Bar
                  dataKey="avoidedImportSek"
                  stackId="saving"
                  name={t('Undvikna elköp', 'Purchases avoided')}
                  fill={SAVING_COLORS.avoidedImportSek}
                  radius={[0, 0, 0, 0]}
                  animationDuration={800}
                />
                <Bar
                  dataKey="exportIncomeSek"
                  stackId="saving"
                  name={t('Exportersättning', 'Export income')}
                  fill={SAVING_COLORS.exportIncomeSek}
                  radius={[3, 3, 0, 0]}
                  animationDuration={900}
                />
                {savings.length > 18 && (
                  <Brush
                    dataKey="monthKey"
                    height={26}
                    stroke="#7c3aed"
                    tickFormatter={formatMonthKey}
                    travellerWidth={8}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>

            <p className="text-xs text-muted-foreground">
              {t(
                'Fasta nätavgifter, abonnemangsavgifter och effektavgiften räknas inte bort, eftersom de betalas oavsett hur många kWh som köps — besparingen är alltså det som panelerna och batteriet faktiskt tog bort från elräkningen.',
                'Fixed grid charges, subscription fees, and the peak-demand charge are not deducted, because they are owed no matter how many kWh are bought — so the saving is what the panels and battery actually took off the bill.',
              )}
              {' '}
              {summary.unmeasuredMonths > 0 && t(
                `${summary.unmeasuredMonths} ${summary.unmeasuredMonths === 1 ? 'månad har' : 'månader har'} kostnadsunderlag men ingen totalförbrukning att värdera mot, och bidrar därför bara med exportersättning.`,
                `${summary.unmeasuredMonths} ${summary.unmeasuredMonths === 1 ? 'month has' : 'months have'} a bill but no whole-home reading to value against it, and contribute export income only.`,
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergySavingsCard;
