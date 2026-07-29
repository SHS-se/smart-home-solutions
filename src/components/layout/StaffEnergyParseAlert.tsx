import { useQuery } from '@tanstack/react-query';
import { FileWarning } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';
import { purgeAllLegacyEnergyBillingSourceFilesForStaff } from '@/lib/energy-billing-storage';
import {
  ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY,
  fetchEnergyParseFailureStaffStatus,
} from '@/lib/energy-import-file-storage';
import { Button } from '@/components/ui/button';

const StaffEnergyParseAlert = () => {
  const { t } = useLanguage();
  const statusQuery = useQuery({
    queryKey: ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY,
    queryFn: async () => {
      await purgeAllLegacyEnergyBillingSourceFilesForStaff();
      return fetchEnergyParseFailureStaffStatus();
    },
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  if (statusQuery.isLoading) return null;

  const firstFailure = statusQuery.data?.failures.at(0);
  const total = statusQuery.data?.total ?? 0;
  if (!statusQuery.error && total === 0) return null;

  return (
    <div
      role="alert"
      data-testid="staff-energy-parse-alert"
      className="border-b border-orange-300 bg-orange-50 px-4 py-3 text-orange-950 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-100 md:px-6"
    >
      <div className="flex flex-wrap items-start gap-3">
        <FileWarning className="mt-0.5 h-5 w-5 shrink-0 text-orange-700 dark:text-orange-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {statusQuery.error
              ? t(
                  'Hanteringen av energifiler behöver kontrolleras',
                  'Energy-file retention needs attention',
                )
              : t(
                  `${total} energifiler behöver parsergranskning`,
                  `${total} energy files need parser review`,
                )}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed">
            {statusQuery.error
              ? (statusQuery.error instanceof Error
                  ? statusQuery.error.message
                  : String(statusQuery.error))
              : t(
                  'Filerna är privata och har endast behållits eftersom importen misslyckades. Granska formatet, rätta parsern eller ta bort filen.',
                  'These files are private and were retained only because import failed. Review the format, fix the parser, or delete the file.',
                )}
          </p>
        </div>
        {firstFailure && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-orange-400 bg-background/80"
            asChild
          >
            <Link to={`/portal/customers/${firstFailure.customer_id}/energy-history?tab=documents`}>
              {t('Granska äldsta filen', 'Review oldest file')}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
};

export default StaffEnergyParseAlert;
