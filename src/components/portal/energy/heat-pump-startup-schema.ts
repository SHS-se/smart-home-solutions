import { z } from 'zod';
import { HEAT_PUMP_STARTUP_METHOD } from '../../../../supabase/functions/_shared/device-learning/heat-pump-startup';

/** The published start-up model, as the Model tab reads it. */
const watts = z.number().nullable();
const band = z.object({
  band_c: z.number(), outdoor_c: z.number(), starts: z.number().int().nonnegative(),
  start_peak_w: watts, start_peak_max_w: watts, first_hour_w: watts,
  recovery_w: z.array(watts), recovery_peak_w: z.array(watts),
  running_hours: z.number().int().nonnegative(), running_w: watts, running_peak_w: watts,
});
const checkHour = z.object({
  at: z.iso.datetime({ offset: true }), outdoor_c: z.number(), measured_w: z.number(), predicted_w: watts,
  measured_peak_w: watts, predicted_peak_w: watts, start: z.boolean(),
});
export const heatPumpStartupModel = z.object({
  method: z.literal(HEAT_PUMP_STARTUP_METHOD),
  recovery_hours: z.number().int().nonnegative(),
  observed_from: z.iso.datetime({ offset: true }).nullable(),
  observed_to: z.iso.datetime({ offset: true }).nullable(),
  bands: z.array(band),
  starts: z.array(z.object({ at: z.iso.datetime({ offset: true }), outdoor_c: z.number(), peak_w: watts, first_hour_w: z.number() })),
  check: z.discriminatedUnion('available', [
    z.object({ available: z.literal(false), reason: z.string(), from: z.string(), to: z.string() }),
    z.object({ available: z.literal(true), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
      hours: z.array(checkHour), draw_error_w: watts, draw_bias_w: watts, running_hours: z.number().int(),
      starts: z.number().int(), starts_within_peak: z.number().int(),
      running_peak_hours: z.number().int(), running_peaks_within: z.number().int() }),
  ]),
});
export type HeatPumpStartup = z.infer<typeof heatPumpStartupModel>;
