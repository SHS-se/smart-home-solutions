import type { GridTariffCatalogue } from './energy-grid-pricing.ts';

export const ROI_GRID_POLICY = 'current-fuse-v1';

/** The equipment comparison uses today's fuse throughout the replay. Tariff
 * versions remain dated; the source catalogue retains actual fuse history. */
export function roiGridCatalogue(catalogue: GridTariffCatalogue): GridTariffCatalogue {
  const configuration = catalogue.configuration;
  if (!configuration) throw new Error('ROI grid tariff configuration unavailable');
  if (configuration.connection_type === 'apartment') return catalogue;
  if (configuration.fuse_a == null) throw new Error('ROI main fuse size unavailable');
  return { ...catalogue, configuration: { ...configuration,
    fuse_periods: [{ valid_from: null, fuse_a: configuration.fuse_a }] } };
}
