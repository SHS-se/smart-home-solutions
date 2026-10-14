import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CreditCard, Loader2, LockKeyhole } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSubscription } from '@/hooks/use-subscription';
import { useEnergyBillingSeries } from '@/hooks/use-energy-billing-series';
import { deleteEnergyBillingDocument, type EnergyBillingDocumentRecord } from '@/lib/energy-billing-storage';
import {
  deleteEnergyParseFailure,
  ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY,
  fetchEnergyParseFailures,
  type EnergyParseFailureRecord,
} from '@/lib/energy-import-file-storage';
import { fetchEnergyHistoryHomeProfileInputs } from '@/lib/home-profile-functional-data';
import {
  createEnergyHistoryNote,
  deleteEnergyHistoryNote,
  deleteEnergyUsageImport,
  fetchEnergyHistoryNotes,
  fetchEnergyUsageImportBatches,
  type EnergyUsageImportBatchRecord,
  type TimelineNoteValues,
} from '@/lib/energy-temperature-storage';
import EnergyBillingDiagnostics from '@/components/portal/energy-history/EnergyBillingDiagnostics';
import EnergyCoverageTable from '@/components/portal/energy-history/EnergyCoverageTable';
import EnergyDataUploadCard from '@/components/portal/energy-history/EnergyDataUploadCard';
import EnergyEventsSection from '@/components/portal/energy-history/EnergyEventsSection';
import EnergyHistoryDocuments from '@/components/portal/energy-history/EnergyHistoryDocuments';

const CACHED = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
} as const;

interface SetupRecordsProps {
  customerId: string;
  isStaffView: boolean;
  /** Bills and data the planner reads, or the changes to the home it should know about. */
  section: 'data' | 'changes';
}

function Spinner({ height = 'min-h-36' }: { height?: string }) {
  return (
    <Card>
      <CardContent className={`flex ${height} items-center justify-center`}>
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </CardContent>
    </Card>
  );
}

function LoadError({ title, error }: { title: string; error: unknown }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  );
}

/**
 * The records under Energy optimisation → Setup: the bills and readings the
 * estimate and the planner are built on, and the changes to the home that
 * explain them. They used to be sections of the Energy history page.
 */
const SetupRecords: React.FC<SetupRecordsProps> = ({ customerId, isStaffView, section }) => {
  const { t } = useLanguage();
  const { isStaff } = useAuth();
  const queryClient = useQueryClient();
  const { isSubscribed, loading: subscriptionLoading, error: subscriptionError } = useSubscription();
  const enabled = Boolean(customerId && isSubscribed && !subscriptionLoading);
  const showData = enabled && section === 'data';

  const billing = useEnergyBillingSeries(customerId, showData);
  const homeProfileQuery = useQuery({
    queryKey: ['energy-history-home-profile', customerId],
    queryFn: () => fetchEnergyHistoryHomeProfileInputs(customerId),
    enabled: showData,
    ...CACHED,
  });
  const usageImportsQueryKey = ['energy-usage-import-batches', customerId] as const;
  const parseFailuresQueryKey = ['energy-parse-failures', customerId] as const;
  const notesQueryKey = ['energy-history-notes', customerId] as const;
  const usageImportsQuery = useQuery({
    queryKey: usageImportsQueryKey,
    queryFn: () => fetchEnergyUsageImportBatches(customerId),
    enabled: showData,
    ...CACHED,
  });
  const parseFailuresQuery = useQuery({
    queryKey: parseFailuresQueryKey,
    queryFn: () => fetchEnergyParseFailures(customerId),
    enabled: showData,
    ...CACHED,
    staleTime: 60 * 1000,
  });
  const notesQuery = useQuery({
    queryKey: notesQueryKey,
    queryFn: () => fetchEnergyHistoryNotes(customerId),
    enabled: enabled && section === 'changes',
    ...CACHED,
  });

  const invalidate = (queryKey: readonly unknown[]) => queryClient.invalidateQueries({ queryKey });
  const refreshUsage = () => invalidate(['energy-usage-readings', customerId]);
  const refreshParseFailures = () => Promise.all([invalidate(parseFailuresQueryKey), invalidate(ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY)]);
  const refreshEnergyData = async () => {
    await Promise.all([billing.refresh(), refreshUsage(), invalidate(usageImportsQueryKey), refreshParseFailures()]);
  };
  const handleDeleteDocument = async (document: EnergyBillingDocumentRecord) => {
    await deleteEnergyBillingDocument(customerId, document);
    await billing.refreshDocuments();
  };
  const handleDeleteUsageImport = async (usageImport: EnergyUsageImportBatchRecord) => {
    await deleteEnergyUsageImport(customerId, usageImport.id);
    await Promise.all([refreshUsage(), invalidate(usageImportsQueryKey)]);
  };
  const handleDeleteParseFailure = async (failure: EnergyParseFailureRecord) => {
    await deleteEnergyParseFailure(customerId, failure);
    await refreshParseFailures();
  };
  const handleCreateNote = async (values: TimelineNoteValues) => {
    await createEnergyHistoryNote(customerId, values);
    await invalidate(notesQueryKey);
  };
  const handleDeleteNote = async (noteId: string) => {
    await deleteEnergyHistoryNote(customerId, noteId);
    await invalidate(notesQueryKey);
  };

  if (!customerId) {
    return (
      <Alert>
        <LockKeyhole className="h-4 w-4" />
        <AlertTitle>{t('Kundkonto kunde inte identifieras', 'Customer account could not be identified')}</AlertTitle>
        <AlertDescription>
          {t(
            'Ditt användarkonto är inte kopplat till en kund. Kontakta supporten innan du importerar energifakturor.',
            'Your user account is not linked to a customer. Contact support before importing energy invoices.',
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (subscriptionLoading) return <Spinner height="min-h-64" />;
  if (!isSubscribed) {
    return (
      <Alert>
        <LockKeyhole className="h-4 w-4" />
        <AlertTitle>{t('Aktiv prenumeration krävs', 'Active subscription required')}</AlertTitle>
        <AlertDescription className="space-y-4">
          <p>
            {subscriptionError
              ? t('Prenumerationsstatus kunde inte verifieras. Försök igen senare.', 'Subscription status could not be verified. Please try again later.')
              : t(
                'Fakturor, dokumentimport och registrerade förändringar ingår för kunder med en aktiv prenumeration.',
                'Bills, document import and recorded changes are available to customers with an active subscription.',
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
    );
  }

  if (section === 'changes') {
    return (
      <EnergyEventsSection
        notes={notesQuery.data ?? []}
        isLoading={notesQuery.isLoading}
        loadError={notesQuery.error}
        onCreate={handleCreateNote}
        onDelete={handleDeleteNote}
      />
    );
  }

  const billingError = billing.error ?? homeProfileQuery.error;
  return (
    <div className="space-y-5">
      {billing.isLoading || homeProfileQuery.isLoading ? <Spinner />
        : billingError ? <LoadError title={t('Datatäckningen kunde inte läsas', 'Data coverage could not be loaded')} error={billingError} />
        : <EnergyCoverageTable series={billing.series} moveInDate={homeProfileQuery.data?.moveInDate ?? null} />}
      <EnergyDataUploadCard customerId={customerId} onDataChanged={refreshEnergyData} />
      {usageImportsQuery.isLoading || parseFailuresQuery.isLoading || billing.isLoading ? <Spinner height="min-h-48" />
        : usageImportsQuery.error || parseFailuresQuery.error || billing.error
          ? <LoadError title={t('Importdata kunde inte läsas', 'Import data could not be loaded')} error={usageImportsQuery.error ?? parseFailuresQuery.error ?? billing.error} />
          : (
            <EnergyHistoryDocuments
              customerId={customerId}
              documents={billing.documents}
              usageImports={usageImportsQuery.data ?? []}
              parseFailures={parseFailuresQuery.data ?? []}
              isStaffView={isStaffView || isStaff}
              onDeleteDocument={handleDeleteDocument}
              onDeleteUsageImport={handleDeleteUsageImport}
              onDeleteParseFailure={handleDeleteParseFailure}
            />
          )}
      {isStaff && !billing.isLoading && !billing.error && (
        <EnergyBillingDiagnostics changes={billing.changes} tariffInvoiceComparisons={billing.tariffInvoiceComparisons} />
      )}
    </div>
  );
};

export default SetupRecords;
