import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatHomeDayMonth } from '@/lib/energy-shift/home-time';
import { summariseVisibleEnergy } from '@/lib/energy-shift/visible-energy-summary';
import type { DayWindow, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import { useHomeTimeZone } from '../HomeTimeZoneContext';
import { Kpi } from './ui';

export default function PlanEnergySummary({ rows, excludedLoads, dayWindow }: {
  rows: readonly TimelineRow[];
  excludedLoads: readonly (readonly number[])[];
  dayWindow: DayWindow;
}) {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const windowSummary = summariseVisibleEnergy(rows, excludedLoads);
  const windowLabel = dayWindow === 'upcoming'
    ? t('kommande plan', 'upcoming plan')
    : dayWindow === 'all'
    ? t('hela perioden', 'the whole period')
    : dayWindow === 0
      ? t('idag', 'today')
      : formatHomeDayMonth(
        rows[0]?.start ?? Date.now(),
        homeTimeZone,
      );
  // "Today" is part measured and part forecast. Saying which is which is the
  // difference between a number and a claim.
  const provenance = windowSummary.measuredSlotCount > 0 && windowSummary.plannedSlotCount > 0
    ? t(
      `${windowSummary.measuredSlotCount} uppmätta · ${windowSummary.plannedSlotCount} planerade kvartar`,
      `${windowSummary.measuredSlotCount} measured · ${windowSummary.plannedSlotCount} planned quarters`,
    )
    : windowSummary.plannedSlotCount > 0
      ? t('planerat', 'planned')
      : t('uppmätt', 'measured');

  return <>
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="energy-totals" aria-live="polite">
      <Kpi
        label={t('Solproduktion', 'Solar production')}
        value={`${windowSummary.solarKwh.toFixed(1)} kWh`}
        detail={provenance}
      />
      <Kpi
        label={t('Husets förbrukning', 'House consumption')}
        value={`${windowSummary.consumptionKwh.toFixed(1)} kWh`}
        detail={windowSummary.filtered ? t('synliga laster i perioden', 'visible loads in the period') : t('all last i perioden', 'all load in the period')}
      />
      <Kpi
        label={t('Nätimport', 'Grid import')}
        value={`${windowSummary.gridImportKwh.toFixed(1)} kWh`}
        detail={windowLabel}
      />
      <Kpi
        label={t('Nätexport', 'Grid export')}
        value={`${windowSummary.gridExportKwh.toFixed(1)} kWh`}
        detail={windowLabel}
      />
      <Kpi
        label={t('Nettokostnad', 'Net cost')}
        value={`${windowSummary.netCostSek.toFixed(2)} SEK`}
        detail={windowSummary.fullyPriced
          ? t('import minus exportersättning', 'import minus export credit')
          : t('endast prissatta kvartar', 'priced quarters only')}
        tone={windowSummary.netCostSek > 0 ? undefined : 'good'}
      />
    </div>
    {windowSummary.filtered && <p className="-mt-4 mb-4 text-xs text-muted-foreground" data-testid="visible-load-estimate">
      {t('Uppskattning för synliga laster, med solproduktion och batterischema oförändrade.',
        'Estimate for visible loads, with solar production and the battery schedule held fixed.')}
      {windowSummary.incomplete && ' ' + t('Ofullständiga mätvärden: endast känd förbrukning har dragits bort.',
        'Incomplete readings: only known consumption has been excluded.')}
    </p>}
  </>;
}
