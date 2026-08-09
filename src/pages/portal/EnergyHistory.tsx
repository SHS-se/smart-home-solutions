import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  CreditCard,
  History,
  Loader2,
  LockKeyhole,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSubscription } from '@/hooks/use-subscription';
import {
  deleteEnergyBillingDocument,
  fetchEnergyBillingDocuments,
  toEnergyBillingSeriesDocuments,
  type EnergyBillingDocumentRecord,
} from '@/lib/energy-billing-storage';
import {
  deleteEnergyParseFailure,
  ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY,
  fetchEnergyParseFailures,
  type EnergyParseFailureRecord,
} from '@/lib/energy-import-file-storage';
import { detectEnergyBillingChanges } from '@/lib/energy-billing-changes';
import { buildEnergyBillingSeries } from '@/lib/energy-billing-series';
import {
  mergeEnergyBillingAndTariffDocuments,
  buildEnergyTariffInvoiceComparisons,
  tariffCalculationsWithoutImportedGridMonths,
  toEnergyTariffChangeDocuments,
} from '@/lib/energy-tariff-series';
import { mergeSupplierEstimates } from '@/lib/energy-supplier-series';
import {
  fetchEnergySupplierDailyCosts,
  fetchEnergyTariffCalculations,
} from '@/lib/energy-tariff-storage';
import { fetchEnergyHistoryHomeProfileInputs } from '@/lib/home-profile-functional-data';
import {
  ENERGY_HISTORY_SAMPLE_CHANGES,
  ENERGY_HISTORY_SAMPLE_SERIES,
} from '@/lib/energy-history-sample';
import EnergyDataUploadCard from '@/components/portal/energy-history/EnergyDataUploadCard';
import EnergiprestandaSection from '@/components/portal/energy-history/EnergiprestandaSection';
import {
  fetchAllWeatherObservations,
  fetchEnergyDeviceReadings,
} from '@/lib/energy-device-readings';
import { resolveDailyUsageReadings } from '@/lib/energy-usage-resolution';
import EnergyTemperatureAnalysis from '@/components/portal/energy-history/EnergyTemperatureAnalysis';
import EnergyHistoryDocuments from '@/components/portal/energy-history/EnergyHistoryDocuments';
import EnergyCoverageTable from '@/components/portal/energy-history/EnergyCoverageTable';
import EnergyHistoryOverview from '@/components/portal/energy-history/EnergyHistoryOverview';
import EnergyHistoryPeriodControl from '@/components/portal/energy-history/EnergyHistoryPeriodControl';
import {
  energyHistoryPeriodStart,
  type EnergyHistoryPeriod,
} from '@/lib/energy-history-period';
import {
  createEnergyHistoryNote,
  deleteEnergyUsageImport,
  fetchEnergyHistoryNotes,
  fetchEnergyUsageImportBatches,
  fetchEnergyUsageReadings,
  fetchSharedWeatherDataset,
  fetchSharedWeatherObservations,
  type EnergyUsageImportBatchRecord,
  type TimelineNoteValues,
} from '@/lib/energy-temperature-storage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface EnergyHistoryProps {
  customerId?: string;
  isStaffView?: boolean;
}

const SHARED_WEATHER_DATASET_QUERY_KEY = ['energy-shared-weather-dataset'] as const;
type EnergyHistorySection = 'overview' | 'data' | 'temperature' | 'performance';
const ENERGY_HISTORY_SECTIONS = new Set<EnergyHistorySection>([
  'overview',
  'data',
  'temperature',
  'performance',
]);
const PERFORMANCE_WEATHER_MINIMUM_DAYS = 329;

function isEnergyHistorySection(value: string | null): value is EnergyHistorySection {
  return value !== null && ENERGY_HISTORY_SECTIONS.has(value as EnergyHistorySection);
}

const EnergyHistory: React.FC<EnergyHistoryProps> = ({
  customerId: propCustomerId,
  isStaffView = false,
}) => {
  const { customerData, isStaff } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    isSubscribed,
    loading: subscriptionLoading,
    error: subscriptionError,
  } = useSubscription();
  const customerId = propCustomerId || customerData?.id || '';
  const requestedTab = searchParams.get('tab');
  const activeTab: EnergyHistorySection = isEnergyHistorySection(requestedTab)
    ? requestedTab
    : 'overview';
  const [displayedPeriod, setDisplayedPeriod] = useState<EnergyHistoryPeriod>('12');
  const showSection = (section: EnergyHistorySection) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', section);
    setSearchParams(nextParams);
  };
  const queryKey = ['energy-billing-documents', customerId] as const;
  const tariffCalculationsQueryKey = ['energy-tariff-calculations', customerId] as const;
  const supplierCostsQueryKey = ['energy-supplier-daily-costs', customerId] as const;
  const usageQueryKey = ['energy-usage-readings', customerId] as const;
  const usageImportsQueryKey = ['energy-usage-import-batches', customerId] as const;
  const parseFailuresQueryKey = ['energy-parse-failures', customerId] as const;
  const notesQueryKey = ['energy-history-notes', customerId] as const;
  const customerEnergyEnabled = Boolean(customerId && isSubscribed && !subscriptionLoading);
  const billingDataEnabled = customerEnergyEnabled
    && (activeTab === 'overview' || activeTab === 'data' || activeTab === 'temperature');
  const homeProfileEnabled = customerEnergyEnabled
    && (activeTab === 'overview' || activeTab === 'data' || activeTab === 'performance');
  const usageDataEnabled = customerEnergyEnabled
    && (activeTab === 'overview'
      || activeTab === 'temperature'
      || activeTab === 'performance');
  const temperatureDataEnabled = customerEnergyEnabled && activeTab === 'temperature';
  const performanceDataEnabled = customerEnergyEnabled && activeTab === 'performance';
  const managementDataEnabled = customerEnergyEnabled && activeTab === 'data';
  const notesDataEnabled = customerEnergyEnabled
    && (activeTab === 'overview' || activeTab === 'temperature');
  // The Data section's coverage table reads the same merged series, so it needs the
  // calculated halves too or it would report every month as thinner than it is.
  const tariffCalculationsEnabled = customerEnergyEnabled
    && (activeTab === 'overview' || activeTab === 'data' || activeTab === 'temperature');
  const documentsQuery = useQuery({
    queryKey,
    queryFn: () => fetchEnergyBillingDocuments(customerId),
    enabled: billingDataEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const homeProfileQuery = useQuery({
    queryKey: ['energy-history-home-profile', customerId],
    queryFn: () => fetchEnergyHistoryHomeProfileInputs(customerId),
    enabled: homeProfileEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const tariffCalculationsQuery = useQuery({
    queryKey: tariffCalculationsQueryKey,
    queryFn: () => fetchEnergyTariffCalculations(customerId),
    enabled: tariffCalculationsEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const supplierCostsQuery = useQuery({
    queryKey: supplierCostsQueryKey,
    queryFn: () => fetchEnergySupplierDailyCosts(customerId),
    enabled: tariffCalculationsEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const usageQuery = useQuery({
    queryKey: usageQueryKey,
    queryFn: () => fetchEnergyUsageReadings(customerId),
    enabled: usageDataEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const usageImportsQuery = useQuery({
    queryKey: usageImportsQueryKey,
    queryFn: () => fetchEnergyUsageImportBatches(customerId),
    enabled: managementDataEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const parseFailuresQuery = useQuery({
    queryKey: parseFailuresQueryKey,
    queryFn: () => fetchEnergyParseFailures(customerId),
    enabled: managementDataEnabled,
    staleTime: 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const deviceReadingsQuery = useQuery({
    queryKey: ['energy-device-readings', customerId],
    queryFn: () => fetchEnergyDeviceReadings(customerId),
    // Needed wherever the usage series is: uploading is optional, so Home
    // Assistant fills in every day no file reached.
    enabled: usageDataEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const usageReadings = useMemo(
    () => resolveDailyUsageReadings(
      usageQuery.data ?? [],
      deviceReadingsQuery.data ?? [],
    ),
    [usageQuery.data, deviceReadingsQuery.data],
  );
  const usageIsLoading = usageQuery.isLoading || deviceReadingsQuery.isLoading;
  const usageError = usageQuery.error ?? deviceReadingsQuery.error;
  const usageStartDate = usageReadings.at(0)?.reading_date ?? null;
  const usageEndDate = usageReadings.at(-1)?.reading_date ?? null;
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
  const weatherDatasetQuery = useQuery({
    queryKey: SHARED_WEATHER_DATASET_QUERY_KEY,
    queryFn: fetchSharedWeatherDataset,
    enabled: temperatureDataEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const weatherObservationsQuery = useQuery({
    queryKey: ['energy-shared-weather-observations', usageStartDate, usageEndDate],
    queryFn: () => fetchSharedWeatherObservations(usageStartDate!, usageEndDate!),
    enabled: temperatureDataEnabled && Boolean(usageStartDate && usageEndDate),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const allWeatherQuery = useQuery({
    queryKey: ['energy-all-weather-observations'],
    queryFn: fetchAllWeatherObservations,
    // A normal-year weather baseline is only used after the measured window
    // itself has near-complete annual coverage. Fetching all shared weather
    // years for a newly installed integration added seconds without changing
    // the result.
    enabled: performanceDataEnabled
      && performanceCategoryDays >= PERFORMANCE_WEATHER_MINIMUM_DAYS,
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const notesQuery = useQuery({
    queryKey: notesQueryKey,
    queryFn: () => fetchEnergyHistoryNotes(customerId),
    enabled: notesDataEnabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const documents = useMemo(
    () => documentsQuery.data ?? [],
    [documentsQuery.data],
  );
  const billingSeriesDocuments = useMemo(
    () => toEnergyBillingSeriesDocuments(documents),
    [documents],
  );
  const seriesDocuments = useMemo(
    () => mergeSupplierEstimates(
      mergeEnergyBillingAndTariffDocuments(
        billingSeriesDocuments,
        tariffCalculationsQuery.data ?? [],
      ),
      supplierCostsQuery.data ?? [],
    ),
    [billingSeriesDocuments, tariffCalculationsQuery.data, supplierCostsQuery.data],
  );
  const authoritativeTariffCalculations = useMemo(
    () => tariffCalculationsWithoutImportedGridMonths(
      billingSeriesDocuments,
      tariffCalculationsQuery.data ?? [],
    ),
    [billingSeriesDocuments, tariffCalculationsQuery.data],
  );
  const tariffInvoiceComparisons = useMemo(
    () => buildEnergyTariffInvoiceComparisons(
      billingSeriesDocuments,
      tariffCalculationsQuery.data ?? [],
    ),
    [billingSeriesDocuments, tariffCalculationsQuery.data],
  );
  const series = useMemo(
    () => buildEnergyBillingSeries(seriesDocuments),
    [seriesDocuments],
  );
  const changes = useMemo(
    () => detectEnergyBillingChanges([
      ...documents,
      ...toEnergyTariffChangeDocuments(authoritativeTariffCalculations),
    ]),
    [documents, authoritativeTariffCalculations],
  );
  const billingDataError = documentsQuery.error
    ?? homeProfileQuery.error
    ?? tariffCalculationsQuery.error
    ?? supplierCostsQuery.error;
  const billingDataIsLoading = documentsQuery.isLoading
    || tariffCalculationsQuery.isLoading
    || supplierCostsQuery.isLoading;
  const overviewSeries = seriesDocuments.length === 0 ? ENERGY_HISTORY_SAMPLE_SERIES : series;
  const latestBillingMonth = seriesDocuments.length > 0
    ? series.at(-1)?.monthKey ?? null
    : null;
  const latestUsageMonth = usageEndDate?.slice(0, 7) ?? null;
  const latestDeviceMonth = deviceReadingsQuery.data?.at(-1)?.reading_date.slice(0, 7) ?? null;
  const latestAnalyticalMonth = useMemo(() => {
    const candidates = [latestBillingMonth, latestUsageMonth, latestDeviceMonth].filter(
      (month): month is string => month !== null,
    );
    return candidates.sort().at(-1)
      ?? (activeTab === 'overview' ? overviewSeries.at(-1)?.monthKey ?? null : null);
  }, [activeTab, latestBillingMonth, latestDeviceMonth, latestUsageMonth, overviewSeries]);
  const displayedPeriodStart = energyHistoryPeriodStart(
    latestAnalyticalMonth,
    displayedPeriod,
  );

  const refreshDocuments = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const refreshUsage = async () => {
    await queryClient.invalidateQueries({ queryKey: usageQueryKey });
  };

  const refreshEnergyData = async () => {
    await Promise.all([
      refreshDocuments(),
      refreshUsage(),
      queryClient.invalidateQueries({ queryKey: tariffCalculationsQueryKey }),
      queryClient.invalidateQueries({ queryKey: supplierCostsQueryKey }),
      queryClient.invalidateQueries({ queryKey: usageImportsQueryKey }),
      queryClient.invalidateQueries({ queryKey: parseFailuresQueryKey }),
      queryClient.invalidateQueries({
        queryKey: ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY,
      }),
    ]);
  };

  const refreshNotes = async () => {
    await queryClient.invalidateQueries({ queryKey: notesQueryKey });
  };

  const handleCreateNote = async (values: TimelineNoteValues) => {
    await createEnergyHistoryNote(customerId, values);
    await refreshNotes();
  };

  const handleDeleteDocument = async (document: EnergyBillingDocumentRecord) => {
    await deleteEnergyBillingDocument(customerId, document);
    await refreshDocuments();
  };

  const handleDeleteUsageImport = async (usageImport: EnergyUsageImportBatchRecord) => {
    await deleteEnergyUsageImport(customerId, usageImport.id);
    await Promise.all([
      refreshUsage(),
      queryClient.invalidateQueries({ queryKey: usageImportsQueryKey }),
    ]);
  };

  const handleDeleteParseFailure = async (failure: EnergyParseFailureRecord) => {
    await deleteEnergyParseFailure(customerId, failure);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: parseFailuresQueryKey }),
      queryClient.invalidateQueries({
        queryKey: ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY,
      }),
    ]);
  };

  const header = (
    <div className="flex items-start gap-3">
      <div className="rounded-lg bg-primary/10 p-2 text-primary">
        <BarChart3 className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-3xl font-medium">{t('Energihistorik', 'Energy history')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {t(
            'Importera energifiler, skilj nätuttag från husets verkliga energibehov och följ kostnad, effektivitet och energiprestanda.',
            'Import energy files, separate grid import from the home’s actual energy demand, and track cost, efficiency, and energy performance.',
          )}
        </p>
      </div>
    </div>
  );

  if (isStaff && !customerId && !isStaffView) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="border-dashed">
          <CardContent className="flex min-h-72 flex-col items-center justify-center text-center">
            <History className="mb-4 h-10 w-10 text-muted-foreground" />
            <h2 className="text-lg font-medium">{t('Välj en kund', 'Select a customer')}</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {t(
                'Öppna kundvyn från kundlistan för att se eller importera kundens energihistorik.',
                "Open a customer from the customer list to view or import that customer's energy history.",
              )}
            </p>
            <Button asChild className="mt-4">
              <Link to="/portal/customers">{t('Visa kunder', 'View customers')}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!customerId) {
    return (
      <div className="space-y-6">
        {header}
        <Alert>
          <LockKeyhole className="h-4 w-4" />
          <AlertTitle>
            {t('Kundkonto kunde inte identifieras', 'Customer account could not be identified')}
          </AlertTitle>
          <AlertDescription>
            {t(
              'Ditt användarkonto är inte kopplat till en kund. Kontakta supporten innan du importerar energifakturor.',
              'Your user account is not linked to a customer. Contact support before importing energy invoices.',
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {subscriptionLoading ? (
        <Card>
          <CardContent className="flex min-h-64 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </CardContent>
        </Card>
      ) : !isSubscribed ? (
        <Alert>
          <LockKeyhole className="h-4 w-4" />
          <AlertTitle>{t('Aktiv prenumeration krävs', 'Active subscription required')}</AlertTitle>
          <AlertDescription className="space-y-4">
            <p>
              {subscriptionError
                ? t(
                    'Prenumerationsstatus kunde inte verifieras. Försök igen senare.',
                    'Subscription status could not be verified. Please try again later.',
                  )
                : t(
                    'Energihistorik, dokumentimport och diagram ingår för kunder med en aktiv prenumeration.',
                    'Energy history, document import, and charts are available to customers with an active subscription.',
                  )}
            </p>
            {!isStaffView && (
              <Button size="sm" asChild>
                <Link to="/portal/billing">
                  <CreditCard className="mr-2 h-4 w-4" />
                  {t('Visa prenumeration', 'View subscription')}
                </Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-5">
          {activeTab !== 'data' && (
            <EnergyHistoryPeriodControl
              value={displayedPeriod}
              onChange={setDisplayedPeriod}
              latestMonth={latestAnalyticalMonth}
            />
          )}
          {activeTab === 'overview' && (
            billingDataIsLoading || homeProfileQuery.isLoading ? (
              <Card>
                <CardContent className="flex min-h-64 items-center justify-center">
                  <Loader2 className="h-7 w-7 animate-spin text-primary" />
                </CardContent>
              </Card>
            ) : billingDataError ? (
              <Alert variant="destructive">
                <AlertTitle>{t('Energihistoriken kunde inte läsas', 'Energy history could not be loaded')}</AlertTitle>
                <AlertDescription>
                  {billingDataError instanceof Error ? billingDataError.message : String(billingDataError)}
                </AlertDescription>
              </Alert>
            ) : (
              <EnergyHistoryOverview
                series={overviewSeries}
                changes={seriesDocuments.length === 0 ? ENERGY_HISTORY_SAMPLE_CHANGES : changes}
                moveInDate={seriesDocuments.length === 0
                  ? null
                  : homeProfileQuery.data?.moveInDate ?? null}
                notes={notesQuery.data ?? []}
                usageReadings={usageReadings}
                notesError={notesQuery.error}
                usageError={usageError}
                usageIsLoading={usageIsLoading}
                isSample={seriesDocuments.length === 0}
                periodStartMonth={displayedPeriodStart}
                periodEndMonth={latestAnalyticalMonth}
                onUploadClick={() => showSection('data')}
                onCreateNote={handleCreateNote}
                tariffInvoiceComparisons={tariffInvoiceComparisons}
              />
            )
          )}
          {activeTab === 'data' && (
            <div className="space-y-5">
              {billingDataIsLoading || homeProfileQuery.isLoading ? (
                <Card>
                  <CardContent className="flex min-h-36 items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  </CardContent>
                </Card>
              ) : billingDataError ? (
                <Alert variant="destructive">
                  <AlertTitle>{t('Datatäckningen kunde inte läsas', 'Data coverage could not be loaded')}</AlertTitle>
                  <AlertDescription>
                    {billingDataError instanceof Error ? billingDataError.message : String(billingDataError)}
                  </AlertDescription>
                </Alert>
              ) : (
                <EnergyCoverageTable
                  series={series}
                  moveInDate={homeProfileQuery.data?.moveInDate ?? null}
                />
              )}
              <EnergyDataUploadCard
                customerId={customerId}
                onDataChanged={refreshEnergyData}
              />
              {usageImportsQuery.isLoading || parseFailuresQuery.isLoading || documentsQuery.isLoading ? (
                <Card>
                  <CardContent className="flex min-h-48 items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  </CardContent>
                </Card>
              ) : usageImportsQuery.error || parseFailuresQuery.error || documentsQuery.error ? (
                <Alert variant="destructive">
                  <AlertTitle>
                    {t('Importdata kunde inte läsas', 'Import data could not be loaded')}
                  </AlertTitle>
                  <AlertDescription>
                    {String(usageImportsQuery.error ?? parseFailuresQuery.error ?? documentsQuery.error)}
                  </AlertDescription>
                </Alert>
              ) : (
                <EnergyHistoryDocuments
                  customerId={customerId}
                  documents={documents}
                  usageImports={usageImportsQuery.data ?? []}
                  parseFailures={parseFailuresQuery.data ?? []}
                  isStaffView={isStaffView || isStaff}
                  onDeleteDocument={handleDeleteDocument}
                  onDeleteUsageImport={handleDeleteUsageImport}
                  onDeleteParseFailure={handleDeleteParseFailure}
                />
              )}
            </div>
          )}
          {activeTab === 'performance' && (
            <EnergiprestandaSection
              readings={deviceReadingsQuery.data ?? []}
              usageReadings={usageReadings}
              weatherObservations={allWeatherQuery.data ?? []}
              atempM2={homeProfileQuery.data?.heatedAreaM2 ?? null}
              heatedBoareaM2={homeProfileQuery.data?.heatedBoareaM2 ?? null}
              heatedBiareaM2={homeProfileQuery.data?.heatedBiareaM2 ?? null}
              hasSolar={homeProfileQuery.data?.hasSolar ?? null}
              periodStartMonth={displayedPeriodStart}
              periodEndMonth={latestAnalyticalMonth}
              isLoading={homeProfileQuery.isLoading || usageIsLoading || allWeatherQuery.isLoading}
              error={homeProfileQuery.error ?? usageError ?? allWeatherQuery.error}
              onUploadClick={() => showSection('data')}
            />
          )}
          {activeTab === 'temperature' && (
            <EnergyTemperatureAnalysis
              readings={usageReadings}
              weatherDataset={weatherDatasetQuery.data ?? null}
              weatherObservations={weatherObservationsQuery.data ?? []}
              notes={notesQuery.data ?? []}
              billingMonths={series}
              periodStartMonth={displayedPeriodStart}
              periodEndMonth={latestAnalyticalMonth}
              costDataIsLoading={billingDataIsLoading}
              isLoading={usageIsLoading
                || weatherDatasetQuery.isLoading
                || weatherObservationsQuery.isLoading}
              error={usageError
                ?? weatherDatasetQuery.error
                ?? weatherObservationsQuery.error}
              onUploadClick={() => showSection('data')}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default EnergyHistory;
