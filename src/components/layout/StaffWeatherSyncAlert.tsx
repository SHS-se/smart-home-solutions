import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { fetchSharedWeatherDataset } from '@/lib/energy-temperature-storage';
import { Button } from '@/components/ui/button';

const WEATHER_SYNC_WARNING_AFTER_MS = 36 * 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const StaffWeatherSyncAlert = () => {
  const { t, language } = useLanguage();
  const datasetQuery = useQuery({
    queryKey: ['energy-shared-weather-dataset'],
    queryFn: fetchSharedWeatherDataset,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    language === 'sv' ? 'sv-SE' : 'en-GB',
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ), [language]);

  if (datasetQuery.isLoading) return null;

  const dataset = datasetQuery.data;
  const lastSyncedAt = dataset?.last_synced_at
    ? new Date(dataset.last_synced_at)
    : null;
  const syncIsStale = !lastSyncedAt
    || !Number.isFinite(lastSyncedAt.getTime())
    || Date.now() - lastSyncedAt.getTime() > WEATHER_SYNC_WARNING_AFTER_MS;
  const monitoringError = datasetQuery.error
    ? errorMessage(datasetQuery.error)
    : null;

  if (!monitoringError && !dataset?.sync_error && !syncIsStale) return null;

  const lastSuccess = lastSyncedAt && Number.isFinite(lastSyncedAt.getTime())
    ? dateFormatter.format(lastSyncedAt)
    : t('ingen registrerad uppdatering', 'no recorded update');
  const detail = monitoringError
    ? t(
        `Statusen för temperaturhämtningen kunde inte läsas: ${monitoringError}`,
        `The temperature collection status could not be read: ${monitoringError}`,
      )
    : dataset?.sync_error
      ? t(
          `Den nattliga SMHI-hämtningen misslyckades. Senaste lyckade uppdatering: ${lastSuccess}. Fel: ${dataset.sync_error}`,
          `The nightly SMHI collection failed. Last successful update: ${lastSuccess}. Error: ${dataset.sync_error}`,
        )
      : t(
          `Ingen lyckad SMHI-hämtning har registrerats inom 36 timmar. Senaste lyckade uppdatering: ${lastSuccess}.`,
          `No successful SMHI collection has been recorded within 36 hours. Last successful update: ${lastSuccess}.`,
        );

  return (
    <div
      role="alert"
      data-testid="staff-weather-sync-alert"
      className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100 md:px-6"
    >
      <div className="flex flex-wrap items-start gap-3">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {t('Automatisk temperaturhämtning behöver kontrolleras', 'Automatic temperature collection needs attention')}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed">{detail}</p>
          <p className="mt-1 text-xs">
            {t(
              'Kontrollera cron-jobbet och funktionen sync-weather-history. Kundernas befintliga diagram använder senast tillgängliga temperaturdata under tiden.',
              'Check the cron job and the sync-weather-history function. Existing customer charts continue using the latest available temperature data in the meantime.',
            )}
          </p>
        </div>
        {dataset?.source_url && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-amber-400 bg-background/80"
            asChild
          >
            <a href={dataset.source_url} target="_blank" rel="noreferrer">
              {t('Kontrollera SMHI-källan', 'Check SMHI source')}
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
};

export default StaffWeatherSyncAlert;
