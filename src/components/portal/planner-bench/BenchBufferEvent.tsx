import { useLanguage } from '@/contexts/LanguageContext';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import type { BufferEvent } from '@/lib/planner-bench/thermal-buffer';
import type { BenchSeries } from '@/lib/planner-bench/types';

/** The same event explanation in the rule list and selected-quarter receipt. */
export default function BenchBufferEvent({ event, series, timeZone }: { event: BufferEvent; series: BenchSeries; timeZone: string }) {
  const { t } = useLanguage();
  const cause = event.highPrices && event.lowSolar ? t('höga priser och låg solproduktion', 'high prices and low solar')
    : event.highPrices ? t('höga priser', 'high prices') : t('låg solproduktion', 'low solar');
  const end = event.to < series.start.length ? series.start[event.to]
    : new Date(Date.parse(series.start[event.to - 1]) + series.hours[event.to - 1] * 3600000).toISOString();
  const stamp = (start: string) => formatHomeDayMonthTime(start, timeZone);
  return <>{t('Varm termisk buffert på grund av', 'Warm thermal buffer due to')} {cause} {t('under händelsen', 'event between')} {stamp(series.start[event.from])} – {stamp(end)}. {t('Modellerat uppvärmningsbehov utan buffert', 'Modeled reheating need without buffer')}: {stamp(series.start[event.reheatQuarter])}.</>;
}
