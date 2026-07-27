import React, { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
  fetchEnergyBillingDocuments,
  toEnergyBillingSeriesDocuments,
} from '@/lib/energy-billing-storage';
import { detectEnergyBillingChanges } from '@/lib/energy-billing-changes';
import { buildEnergyBillingSeries } from '@/lib/energy-billing-series';
import EnergyDocumentUploadCard from '@/components/portal/energy-history/EnergyDocumentUploadCard';
import EnergyHistoryDocuments from '@/components/portal/energy-history/EnergyHistoryDocuments';
import EnergyHistoryOverview from '@/components/portal/energy-history/EnergyHistoryOverview';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface EnergyHistoryProps {
  customerId?: string;
  isStaffView?: boolean;
}

const EnergyHistory: React.FC<EnergyHistoryProps> = ({
  customerId: propCustomerId,
  isStaffView = false,
}) => {
  const { customerData, isStaff } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const {
    isSubscribed,
    loading: subscriptionLoading,
    error: subscriptionError,
  } = useSubscription();
  const customerId = propCustomerId || customerData?.id || '';
  const queryKey = ['energy-billing-documents', customerId] as const;
  const documentsQuery = useQuery({
    queryKey,
    queryFn: () => fetchEnergyBillingDocuments(customerId),
    enabled: Boolean(customerId && isSubscribed && !subscriptionLoading),
  });
  const documents = useMemo(
    () => documentsQuery.data ?? [],
    [documentsQuery.data],
  );
  const series = useMemo(
    () => buildEnergyBillingSeries(toEnergyBillingSeriesDocuments(documents)),
    [documents],
  );
  const changes = useMemo(
    () => detectEnergyBillingChanges(documents),
    [documents],
  );

  const refreshDocuments = async () => {
    await queryClient.invalidateQueries({ queryKey });
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
            'Importera fakturor från elnät och elhandel, följ förbrukning och kostnad och se tydligt var underlag saknas.',
            'Import grid and electricity provider invoices, track consumption and cost, and see exactly where source data is missing.',
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
      ) : documentsQuery.isLoading ? (
        <Card>
          <CardContent className="flex min-h-64 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </CardContent>
        </Card>
      ) : documentsQuery.error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('Energihistoriken kunde inte läsas', 'Energy history could not be loaded')}</AlertTitle>
          <AlertDescription>
            {documentsQuery.error instanceof Error
              ? documentsQuery.error.message
              : String(documentsQuery.error)}
          </AlertDescription>
        </Alert>
      ) : (
        <Tabs defaultValue="overview" className="space-y-5">
          <TabsList className="grid w-full max-w-lg grid-cols-3">
            <TabsTrigger value="overview">{t('Översikt', 'Overview')}</TabsTrigger>
            <TabsTrigger value="upload">{t('Ladda upp', 'Upload')}</TabsTrigger>
            <TabsTrigger value="documents">{t('Dokument', 'Documents')}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <EnergyHistoryOverview series={series} changes={changes} />
          </TabsContent>
          <TabsContent value="upload">
            <div className="grid items-start gap-6 xl:grid-cols-2">
              <EnergyDocumentUploadCard
                customerId={customerId}
                kind="grid"
                onImported={refreshDocuments}
              />
              <EnergyDocumentUploadCard
                customerId={customerId}
                kind="electricity"
                onImported={refreshDocuments}
              />
            </div>
          </TabsContent>
          <TabsContent value="documents">
            <EnergyHistoryDocuments documents={documents} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};

export default EnergyHistory;
