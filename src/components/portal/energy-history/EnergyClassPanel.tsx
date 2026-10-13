import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSubscription } from '@/hooks/use-subscription';
import { fetchLatestEnergyDeclaration } from '@/lib/energy-declaration-storage';
import {
  fetchAllWeatherObservations,
  fetchEnergyDeviceReadings,
} from '@/lib/energy-device-readings';
import {
  fetchEnergyHistoryNotes,
  fetchEnergyUsageReadings,
} from '@/lib/energy-temperature-storage';
import { resolveDailyUsageReadings } from '@/lib/energy-usage-resolution';
import { fetchEnergyHistoryHomeProfileInputs } from '@/lib/home-profile-functional-data';
import EnergiprestandaSection from './EnergiprestandaSection';
import { GRADE_BANDS } from './grade-bands';

interface EnergyClassPanelProps {
  customerId: string;
  /** '/portal' for the customer, '/portal/customers/:id' for staff viewing one. */
  basePath: string;
}

const PERFORMANCE_WEATHER_MINIMUM_DAYS = 329;

// Same keys and lifetimes as the Energy history page, so moving between the
// two reads one cached copy instead of fetching the readings twice.
const CACHED = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
} as const;

/**
 * The home's estimated energy class, shown on the portal overview.
 *
 * It is included in the subscription. Without one the card says so instead of
 * showing a number: the estimate is one of the things a subscription buys.
 */
const EnergyClassPanel: React.FC<EnergyClassPanelProps> = ({ customerId, basePath }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const {
    isSubscribed,
    loading: subscriptionLoading,
    error: subscriptionError,
  } = useSubscription();
  const enabled = Boolean(customerId && isSubscribed && !subscriptionLoading);

  const homeProfileQuery = useQuery({
    queryKey: ['energy-history-home-profile', customerId],
    queryFn: () => fetchEnergyHistoryHomeProfileInputs(customerId),
    enabled,
    ...CACHED,
  });
  const declarationQuery = useQuery({
    queryKey: ['energy-history-declaration', customerId],
    queryFn: () => fetchLatestEnergyDeclaration(customerId),
    enabled,
    ...CACHED,
  });
  const usageQuery = useQuery({
    queryKey: ['energy-usage-readings', customerId],
    queryFn: () => fetchEnergyUsageReadings(customerId),
    enabled,
    ...CACHED,
  });
  const deviceReadingsQuery = useQuery({
    queryKey: ['energy-device-readings', customerId],
    queryFn: () => fetchEnergyDeviceReadings(customerId),
    enabled,
    ...CACHED,
  });
  const notesQuery = useQuery({
    queryKey: ['energy-history-notes', customerId],
    queryFn: () => fetchEnergyHistoryNotes(customerId),
    enabled,
    ...CACHED,
  });
  const usageReadings = useMemo(
    () => resolveDailyUsageReadings(
      usageQuery.data ?? [],
      deviceReadingsQuery.data ?? [],
    ),
    [usageQuery.data, deviceReadingsQuery.data],
  );
  const performanceCategoryDays = useMemo(() => new Set(
    (deviceReadingsQuery.data ?? [])
      .filter((reading) => (
        reading.category === 'heating'
        || reading.category === 'hot_water'
        || reading.category === 'cooling'
        || reading.category === 'property_energy'
      ))
      .map((reading) => reading.reading_date),
  ).size, [deviceReadingsQuery.data]);
  const allWeatherQuery = useQuery({
    queryKey: ['energy-all-weather-observations'],
    queryFn: fetchAllWeatherObservations,
    // A normal-year weather baseline is only used after the measured window
    // itself has near-complete annual coverage. Fetching all shared weather
    // years for a newly installed integration added seconds without changing
    // the result.
    enabled: enabled && performanceCategoryDays >= PERFORMANCE_WEATHER_MINIMUM_DAYS,
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  if (subscriptionLoading) {
    return (
      <Card>
        <CardContent className="flex min-h-48 items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (!isSubscribed) {
    return (
      <Card className="border-dashed" data-testid="energy-class-locked">
        <CardContent className="flex flex-col gap-6 p-6 md:flex-row md:items-center">
          <div
            aria-hidden="true"
            className="grid w-full shrink-0 grid-cols-7 overflow-hidden rounded-xl opacity-60 md:w-64"
          >
            {GRADE_BANDS.map((band) => (
              <div
                key={band.grade}
                className={`${band.className} py-3 text-center font-semibold text-white`}
              >
                {band.grade}
              </div>
            ))}
          </div>
          <div>
            <h2 className="text-lg font-medium">
              {t('Energiklass för ditt hem', 'An energy class for your home')}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {subscriptionError
                ? t(
                    'Prenumerationsstatus kunde inte verifieras. Försök igen senare.',
                    'Subscription status could not be verified. Please try again later.',
                  )
                : t(
                    'Med en prenumeration uppskattar vi husets energiklass, A till G, utifrån din egen energidata. Du behöver inte beställa en energideklaration för att se var huset står.',
                    'With a subscription we estimate your home’s energy class, A to G, from your own energy data. You do not need to order an energy declaration to see where the house stands.',
                  )}
            </p>
            <Button size="sm" asChild className="mt-4">
              <Link to={`${basePath}/billing`}>
                <CreditCard className="mr-2 h-4 w-4" />
                {t('Visa prenumeration', 'View subscription')}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const profile = homeProfileQuery.data;
  const showData = () => navigate(`${basePath}/energy-history?tab=data`);

  return (
    <EnergiprestandaSection
      readings={deviceReadingsQuery.data ?? []}
      usageReadings={usageReadings}
      weatherObservations={allWeatherQuery.data ?? []}
      atempM2={profile?.heatedAreaM2 ?? null}
      heatedBoareaM2={profile?.heatedBoareaM2 ?? null}
      heatedBiareaM2={profile?.heatedBiareaM2 ?? null}
      hasSolar={profile?.hasSolar ?? null}
      homeFacts={{
        yearBuilt: profile?.yearBuilt ?? null,
        dwelling: profile?.dwelling ?? null,
        heating: profile?.heating ?? null,
        // BBR 31 Table 9:2c is not loaded yet; the UI says so.
        geographicAdjustmentFactor: null,
      }}
      events={notesQuery.data ?? []}
      onManageEventsClick={() => navigate(`${basePath}/energy-history?tab=events`)}
      declaration={declarationQuery.data ?? null}
      onUploadDeclarationClick={showData}
      periodStartMonth={null}
      periodEndMonth={null}
      isLoading={homeProfileQuery.isLoading
        || usageQuery.isLoading
        || deviceReadingsQuery.isLoading
        || allWeatherQuery.isLoading}
      error={homeProfileQuery.error
        ?? usageQuery.error
        ?? deviceReadingsQuery.error
        ?? allWeatherQuery.error}
      onUploadClick={showData}
    />
  );
};

export default EnergyClassPanel;
