import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import type { OverlapMove } from '@/lib/planner-bench/large-load-overlap';
import type { BenchSeries } from '@/lib/planner-bench/types';

/** The same move evidence in a selected quarter and the expanded rule list. */
export default function BenchOverlapMove({ move, series, timeZone, onSelect }: {
  move: OverlapMove; series: BenchSeries; timeZone: string; onSelect: (quarter: number) => void;
}) {
  const { t } = useLanguage();
  const device = move.device === 'ev' ? t('Billaddning', 'EV charging') : t('Hembatteriladdning', 'Home battery charging');
  const quarters = [
    { quarter: move.from, label: t('från kvart', 'source quarter') },
    { quarter: move.to, label: t('billigare kvart', 'cheaper quarter') },
  ];
  return <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs" data-testid="bench-overlap-move">
    <span>{device} · {(move.movedW / 1000).toFixed(2)} kW</span>
    {quarters.map(({ quarter, label }, index) => {
      const stamp = formatHomeDayMonthTime(series.start[quarter], timeZone);
      return <Fragment key={quarter}>
        {index > 0 && <span aria-hidden="true">→</span>}
        <Button size="sm" variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal text-left text-xs"
          aria-label={`${t('Visa', 'Show')} ${label}: ${stamp}`} onClick={() => onSelect(quarter)}>
          {label}: {stamp}{' · '}{t('verkligt pris', 'real price')}: {series.importPrice[quarter].toFixed(2)} SEK/kWh
        </Button>
      </Fragment>;
    })}
  </div>;
}
