import { z } from "zod";
import { RULE_KEYS } from "./ready-problem.ts";

const number = z.number().finite();
const storeTerm = z.object({ cap: number, grid_kwh_per_unit: number.nonnegative() }).strict();
const age = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off_unobserved") }),
  z.object({ kind: z.literal("off"), seconds: number.nonnegative() }),
  z.object({ kind: z.literal("steady") }),
  z.object({ kind: z.literal("running"), seconds: number.nonnegative() }),
]);
const command = z.object({
  pool_on: z.boolean(),
  ev_amps: number.int().nonnegative(),
  battery: z.enum([
    "idle",
    "solar_charge",
    "hold",
    "self_consumption",
    "grid_charge",
    "supply_house",
    "export",
  ]),
  charge_limit_w: number,
  discharge_limit_w: number,
});
export const readyProblemSchema = z.object({
  abi: z.literal(6),
  pool_cycle_seconds: number.nonnegative(),
  work_grant: number.int().nonnegative(),
  recipe: z.object({
    beam_width: number.int().positive(),
    max_actions: number.int().positive(),
    finalists: number.int().positive(),
    witness_trials: number.int().nonnegative(),
    repair_trials: number.int().nonnegative(),
  }),
  slots: z.object({
    local_month: number.int().min(1).max(12),
    start_seconds: number,
    hours: number,
    base_w: number,
    solar_w: number,
    outdoor_c: number,
    import_price: number,
    export_price: number,
    published: z.boolean(),
    ev_available: z.boolean(),
  }).array().nonempty(),
  battery: z.object({
    capacity_kwh: number,
    min_soc: number,
    max_soc: number,
    charge_max_w: number,
    discharge_max_w: number,
    charge_efficiency: number,
    discharge_efficiency: number,
  }).nullable(),
  car: z.object({
    capacity_kwh: number,
    kwh_per_km: number,
    charge_efficiency: number,
  }).nullable(),
  charger: z.object({
    voltage_v: number,
    phase_count: number.int(),
    min_current_a: number.int(),
    max_current_a: number.int(),
    current_step_a: number.int(),
  }).nullable(),
  pool_store: z.object({
    capacity_kwh_per_c: number,
    loss: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("linear"),
        kw_per_c: number,
        surroundings_c: number.nullable(),
      }),
      z.object({
        kind: z.literal("measured"),
        points: z.object({ at_c: number, c_per_h: number }).array(),
      }),
    ]),
  }).nullable(),
  heater: z.object({
    compressor_w: number,
    auxiliary_w: number,
    heat_w: number,
    response: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("steady") }),
      z.object({
        kind: z.literal("bergvarme"),
        startup: z.object({
          elapsed_seconds: number,
          electric_fraction: number,
          heat_fraction: number,
        }).array(),
      }),
    ]),
  }).nullable(),
  pool_stop_c: number.nullable(),
  initial: z.object({
    battery_kwh: number.nullable(),
    ev_kwh: number.nullable(),
    pool_c: number.nullable(),
    heater_state: age.nullable(),
  }),
  targets: z.object({
    pool_c: number.nullable(),
    ev_km: number.nullable(),
    ev_limit_kwh: number.nullable(),
  }),
  limits: z.object({
    import_w: number,
    export_w: number,
    battery_export_enabled: z.boolean(),
    battery_export_reserve_kwh: number,
    battery_export_min_price: number,
    wear_per_kwh: number,
  }),
  end_credit: z.object({
    reference_sek_per_kwh: number.nonnegative(),
    battery: storeTerm.nullable(),
    pool: storeTerm.nullable(),
    ev: storeTerm.nullable(),
  }).strict(),
  rules: z.object({
    key: z.enum(RULE_KEYS),
    threshold: number,
    points: number.int(),
    required: z.boolean(),
    unless: z.enum(RULE_KEYS).nullable(),
  })
    .array(),
  service_guard: z.object({
    pool: z.tuple([number, number]),
    ev: z.tuple([number, number]),
  }),
  accepted: command.array().nullable(),
  locked_through_seconds: number,
}).strict();
