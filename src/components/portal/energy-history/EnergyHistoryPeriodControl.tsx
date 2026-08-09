import React, { useMemo } from 'react';
import { CalendarRange } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  energyHistoryPeriodStart,
  type EnergyHistoryPeriod,
} from '@/lib/energy-history-period';
import { Button } from '@/components/ui/button';

interface EnergyHistoryPeriodControlProps {
  value: EnergyHistoryPeriod;
  onChange: (period: EnergyHistoryPeriod) => void;
  latestMonth: string | null;
}

const PERIOD_OPTIONS: Array<{ value: EnergyHistoryPeriod; sv: string; en: string }> = [
  { value: '12', sv: '12 mån', en: '12 mo' },
  { value: '24', sv: '24 mån', en: '24 mo' },
  { value: '36', sv: '36 mån', en: '36 mo' },
  { value: 'all', sv: 'Allt', en: 'All' },
];

const EnergyHistoryPeriodControl: React.FC<EnergyHistoryPeriodControlProps> = ({
  value,
  onChange,
  latestMonth,
}) => {
  const { t, language } = useLanguage();
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(
    language === 'sv' ? 'sv-SE' : 'en-GB',
    { month: 'long', year: 'numeric', timeZone: 'UTC' },
  ), [language]);
  const firstMonth = energyHistoryPeriodStart(latestMonth, value);
  const periodLabel = latestMonth
    ? firstMonth
      ? `${monthFormatter.format(new Date(`${firstMonth}-01T00:00:00Z`))} – ${monthFormatter.format(new Date(`${latestMonth}-01T00:00:00Z`))}`
      : t('Hela historiken', 'All history')
    : t('Ingen daterad data ännu', 'No dated data yet');

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-gradient-to-r from-primary/5 via-background to-violet-500/5 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
      data-testid="energy-history-period"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <CalendarRange className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('Visad period', 'Displayed period')}</p>
          <p className="mt-0.5 truncate text-xs capitalize text-muted-foreground">{periodLabel}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t(
              'Gäller alla diagram i Översikt, Temperatur och Energiprestanda.',
              'Applies to every chart in Overview, Temperature, and Performance.',
            )}
          </p>
        </div>
      </div>
      <div
        className="flex w-full gap-1 overflow-x-auto rounded-lg bg-muted/60 p-1 sm:w-auto"
        aria-label={t('Välj period', 'Select period')}
      >
        {PERIOD_OPTIONS.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={value === option.value ? 'default' : 'ghost'}
            className="h-8 shrink-0 px-3"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {language === 'sv' ? option.sv : option.en}
          </Button>
        ))}
      </div>
    </div>
  );
};

export default EnergyHistoryPeriodControl;
