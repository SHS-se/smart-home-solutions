import type { Conversion } from './battery-conversion.ts';

/** Independently synthetic, lossless AC/DC conversion for test equipment.
 * Stored-energy losses remain explicitly configured by each battery fixture. */
export function syntheticIdentityConversion(): Conversion {
  return { revision: 'synthetic-identity-conversion-v1',
    grid_charge: { gain: 1, overhead_w: 0 },
    surplus_charge: { gain: 1, overhead_w: 0 },
    discharge: { gain: 1, overhead_w: 0 }, idle_loss_w: 0 };
}
