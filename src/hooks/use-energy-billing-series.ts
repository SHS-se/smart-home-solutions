import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchEnergyBillingDocuments, toEnergyBillingSeriesDocuments } from '@/lib/energy-billing-storage';
import { detectEnergyBillingChanges } from '@/lib/energy-billing-changes';
import { buildEnergyBillingSeries } from '@/lib/energy-billing-series';
import { mergeSupplierEstimates } from '@/lib/energy-supplier-series';
import {
  buildEnergyTariffInvoiceComparisons,
  mergeEnergyBillingAndTariffDocuments,
  tariffCalculationsWithoutImportedGridMonths,
  toEnergyTariffChangeDocuments,
} from '@/lib/energy-tariff-series';
import { fetchEnergySupplierDailyCosts, fetchEnergyTariffCalculations } from '@/lib/energy-tariff-storage';

const CACHED = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
} as const;

export const energyBillingQueryKeys = (customerId: string) => ({
  documents: ['energy-billing-documents', customerId] as const,
  tariffCalculations: ['energy-tariff-calculations', customerId] as const,
  supplierCosts: ['energy-supplier-daily-costs', customerId] as const,
});

/**
 * One customer's monthly bills: imported invoices first, with the tariff and
 * supplier calculations filling only the months no invoice covers. Shared by
 * Setup (coverage and staff checks) and Savings (what solar and battery saved),
 * under the query keys every other reader of these tables uses.
 */
export function useEnergyBillingSeries(customerId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const keys = energyBillingQueryKeys(customerId);
  const documentsQuery = useQuery({ queryKey: keys.documents, queryFn: () => fetchEnergyBillingDocuments(customerId), enabled, ...CACHED });
  const tariffCalculationsQuery = useQuery({ queryKey: keys.tariffCalculations, queryFn: () => fetchEnergyTariffCalculations(customerId), enabled, ...CACHED });
  const supplierCostsQuery = useQuery({ queryKey: keys.supplierCosts, queryFn: () => fetchEnergySupplierDailyCosts(customerId), enabled, ...CACHED });

  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);
  const billingSeriesDocuments = useMemo(() => toEnergyBillingSeriesDocuments(documents), [documents]);
  const seriesDocuments = useMemo(() => mergeSupplierEstimates(
    mergeEnergyBillingAndTariffDocuments(billingSeriesDocuments, tariffCalculationsQuery.data ?? []),
    supplierCostsQuery.data ?? [],
  ), [billingSeriesDocuments, tariffCalculationsQuery.data, supplierCostsQuery.data]);
  const series = useMemo(() => buildEnergyBillingSeries(seriesDocuments), [seriesDocuments]);
  // Staff checks: a Home Assistant tariff calculation never replaces an imported grid invoice.
  const tariffInvoiceComparisons = useMemo(
    () => buildEnergyTariffInvoiceComparisons(billingSeriesDocuments, tariffCalculationsQuery.data ?? []),
    [billingSeriesDocuments, tariffCalculationsQuery.data],
  );
  const changes = useMemo(() => detectEnergyBillingChanges([
    ...documents,
    ...toEnergyTariffChangeDocuments(tariffCalculationsWithoutImportedGridMonths(billingSeriesDocuments, tariffCalculationsQuery.data ?? [])),
  ]), [documents, billingSeriesDocuments, tariffCalculationsQuery.data]);

  return {
    documents,
    series,
    hasBills: seriesDocuments.length > 0,
    tariffInvoiceComparisons,
    changes,
    isLoading: documentsQuery.isLoading || tariffCalculationsQuery.isLoading || supplierCostsQuery.isLoading,
    error: documentsQuery.error ?? tariffCalculationsQuery.error ?? supplierCostsQuery.error,
    refresh: () => Promise.all(Object.values(keys).map(queryKey => queryClient.invalidateQueries({ queryKey }))),
    refreshDocuments: () => queryClient.invalidateQueries({ queryKey: keys.documents }),
  };
}
