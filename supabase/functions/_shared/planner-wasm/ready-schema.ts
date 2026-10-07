import { z } from 'zod';
import { DIRECT_RULE_KEYS } from './ready-problem.ts';

const number = z.number().finite();
const age = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }),
  z.object({ kind: z.literal('steady') }),
  z.object({ kind: z.literal('running'), seconds: number.nonnegative() }),
]);
const command = z.object({
  pool_on: z.boolean(),
  ev_amps: number.int().nonnegative(),
  battery: z.enum(['hold', 'self_consumption', 'grid_charge', 'supply_house', 'export']),
  charge_limit_w: number,
  discharge_limit_w: number,
});
export const readyProblemSchema = z.object({
  abi: z.literal(1),
  work_grant: number.int().nonnegative(),
  recipe: z.object({ max_passes: number.int().nonnegative(), coupled_masks: number.int().array() }),
  slots: z.object({
    start_seconds: number,
    hours: number,
    base_w: number,
    solar_w: number,
    outdoor_c: number,
    import_price: number,
    export_price: number,
    published: z.boolean(),
    cheap_rank: number,
    dear_rank: number,
    next_day_buffer: z.boolean().nullable(),
  }).array().nonempty(),
  battery: z.object({
    capacity_kwh: number,
    min_soc: number,
    max_soc: number,
    charge_max_w: number,
    discharge_max_w: number,
    charge_efficiency: number,
    discharge_efficiency: number,
  }),
  car: z.object({ capacity_kwh: number, kwh_per_km: number, charge_efficiency: number }),
  charger: z.object({
    voltage_v: number,
    phase_count: number.int(),
    min_current_a: number.int(),
    max_current_a: number.int(),
    current_step_a: number.int(),
  }),
  pool_store: z.object({
    capacity_kwh_per_c: number,
    loss: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('linear'), kw_per_c: number, surroundings_c: number.nullable() }),
      z.object({
        kind: z.literal('measured'),
        points: z.object({ at_c: number, c_per_h: number }).array(),
      }),
    ]),
  }),
  heater: z.object({
    compressor_w: number,
    auxiliary_w: number,
    heat_w: number,
    response: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('steady') }),
      z.object({
        kind: z.literal('bergvarme'),
        startup: z.object({
          elapsed_seconds: number,
          electric_fraction: number,
          heat_fraction: number,
        }).array(),
      }),
    ]),
  }),
  initial: z.object({ battery_kwh: number, ev_kwh: number, pool_c: number, heater_age: age }),
  targets: z.object({ pool_c: number, ev_km: number, ev_limit_kwh: number }),
  limits: z.object({
    import_w: number,
    export_w: number,
    battery_export_enabled: z.boolean(),
    battery_export_reserve_kwh: number,
    battery_export_min_price: number,
    wear_per_kwh: number,
  }),
  rules: z.object({ key: z.enum(DIRECT_RULE_KEYS), threshold: number, points: number.int() })
    .array(),
  accepted: command.array().nullable(),
  locked_through_seconds: number,
}).strict();
