import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";
import { chargerLevels, type ChargerModel } from "./planner/device-models.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { commandOwner, evCurrentCeiling, unavailableOwner } from "./rules-commitments.ts";
import type { PublishedCommandReference, PublishedCommandSlot } from "./rules-planner.ts";

type Model = OptimisationSnapshot["device_models"][number];
type EvInstruction = Pick<PublishedCommandSlot, "ev_target_current_a" | "ev_min_current_a" | "ev_max_current_a">;
type PoolInstruction = Pick<PublishedCommandSlot, "pool_permitted" | "pool_command_w">;
type BoilerInstruction = Pick<PublishedCommandSlot, "boiler_permitted" | "boiler_expected_w" | "boiler_battery_allowed">;
export interface ServiceContinuity {
  commands: Record<string, Array<DeviceCommand | undefined>>;
  power: Record<string, number[]>;
  ev: Array<EvInstruction | undefined>;
  pool: Array<PoolInstruction | undefined>;
  boiler: Array<BoilerInstruction | undefined>;
  boiler_evidence_missing: boolean;
  boiler_allowance: Array<boolean | undefined>;
  ev_charger?: ChargerModel;
  pool_stop_temperature_c?: number;
  warnings: PlanningWarning[];
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Unreadable observations differ from finite readings that cannot be real. */
export function hasMissingServiceReading(snapshot: OptimisationSnapshot, device: "ev" | "pool"): boolean {
  const issues = snapshot.measurement_issues?.filter(issue => issue.device === device) ?? [];
  return issues.length > 0 && issues.every(issue => issue.value === null ||
    typeof issue.value === "string" && !Number.isFinite(Number(issue.value)));
}

function compatible(command: DeviceCommand | undefined, model: Model, snapshot: OptimisationSnapshot): command is DeviceCommand {
  return !!command && command.type !== "unavailable" && (command.type === model.control_type ||
    command.type === "room_relay" && model.control_type === "switch_schedule" &&
    !!snapshot.thermal_zones?.some(zone => zone.key === command.room_key && zone.device_keys.includes(model.key)));
}

/** Retain accepted requests without treating their previous store states as current measurements. */
export function retainUnavailableServices(snapshot: OptimisationSnapshot, reference: PublishedCommandReference | null,
  activeKeys: ReadonlySet<string>, charger: ChargerModel | null = null,
  repairOwners: ReadonlySet<string> = new Set(), bookedStarts: ReadonlySet<number> = new Set(),
  boilerEnabled = snapshot.capabilities.boiler): ServiceContinuity {
  const n = snapshot.slots.length;
  const result: ServiceContinuity = { commands: {}, power: {}, ev: Array(n), pool: Array(n), boiler: Array(n),
    boiler_evidence_missing: boilerEnabled && !snapshot.capabilities.boiler, boiler_allowance: Array(n), warnings: [] };
  if (!reference) return result;
  const prior = new Map(reference.slots.map(slot => [Date.parse(slot.start), slot]));
  const eligible = snapshot.device_models.filter(model => {
    const owner = commandOwner(snapshot, model);
    const mode = snapshot.operating_scope?.modes[owner];
    return model.planning_role === "controllable" && !activeKeys.has(model.key) &&
      !(model.category === "hot_water" && !boilerEnabled) &&
      (!snapshot.operating_scope || mode === "controlling" || mode === "control_verification");
  });
  const ev = eligible.filter(model => model.category === "ev_charging" && model.control_type === "variable_power" && commandOwner(snapshot, model) === "$ev");
  const pool = eligible.filter(model => model.planning_service === "pool" && commandOwner(snapshot, model) === "$pool");
  const recoveredEv = hasMissingServiceReading(snapshot, "ev");
  const recoveredPool = hasMissingServiceReading(snapshot, "pool");
  let levels: ReturnType<typeof chargerLevels> | null = null;
  try {
    const model = charger ?? reference.ev_charger;
    if (model) {
      levels = chargerLevels(model);
      const { voltage_v, phase_count, min_current_a, max_current_a, current_step_a } = model;
      result.ev_charger = { voltage_v, phase_count, min_current_a, max_current_a, current_step_a };
    }
  } catch { /* An unreadable equipment contract retains settings, never an invented current range. */ }
  const copy = (model: Model, i: number, command: DeviceCommand, watts: number) => {
    (result.commands[model.key] ??= Array(n))[i] = structuredClone(command);
    (result.power[model.key] ??= model.forecast_w_by_slot.slice())[i] = watts;
  };
  for (const [i, source] of snapshot.slots.entries()) {
    if (bookedStarts.has(Date.parse(source.start))) continue;
    const old = prior.get(Date.parse(source.start));
    if (!old) continue;
    if (result.boiler_evidence_missing && typeof old.boiler_battery_allowed === "boolean") {
      result.boiler_allowance[i] = old.boiler_battery_allowed;
    }
    // Execution repair releases destinations in the held hour, not every future opportunity.
    const repairing = (owner: string) => repairOwners.has(owner) &&
      Date.parse(source.start) < Date.parse(snapshot.captured_at) + 3_600_000;
    if (recoveredEv && ev.length && !repairing("$ev") && !unavailableOwner(snapshot, "$ev", source.start)) {
      const amps = old.ev_target_current_a;
      const ceiling = evCurrentCeiling(snapshot, source.start);
      const bound = amps === 0 ? 0 : levels?.find(level => level.setting === amps)?.draw_w;
      const commands = ev.map(model => old.device_commands?.[model.key]);
      if (finite(bound) && finite(amps) && finite(old.ev_min_current_a) && finite(old.ev_max_current_a) &&
        amps >= old.ev_min_current_a && amps <= old.ev_max_current_a && (ceiling === null || amps <= ceiling) &&
        commands.every(command => command?.type === "variable_power" && command.unit === "A" && command.value === amps)) {
        result.ev[i] = { ev_target_current_a: amps, ev_min_current_a: old.ev_min_current_a, ev_max_current_a: old.ev_max_current_a };
        const weights = ev.map(model => Math.max(0, model.active_power_w ?? 0));
        const total = weights.reduce((sum, watts) => sum + watts, 0);
        ev.forEach((model, j) => copy(model, i, commands[j]!, bound * (total > 0 ? weights[j] / total : 1 / ev.length)));
      }
    }
    if (recoveredPool && pool.length && !repairing("$pool") && !unavailableOwner(snapshot, "$pool", source.start) &&
      finite(reference.pool_stop_temperature_c) && typeof old.pool_permitted === "boolean" && finite(old.pool_command_w) &&
      pool.every(model => compatible(old.device_commands?.[model.key], model, snapshot) ||
        model.control_type === "variable_power" && old.device_commands?.[model.key]?.type === "unavailable")) {
      const bounds = pool.map(model => model.active_power_w);
      if (!old.pool_permitted || bounds.every(watts => finite(watts) && watts > 0)) {
        const watts = old.pool_permitted ? bounds.reduce<number>((sum, value) => sum + value!, 0) : 0;
        result.pool[i] = { pool_permitted: old.pool_permitted, pool_command_w: watts };
        result.pool_stop_temperature_c = reference.pool_stop_temperature_c;
        pool.forEach((model, j) => copy(model, i, old.device_commands?.[model.key] ??
          { type: "unavailable", reason: "Dedicated pool owner supplies the retained enable command" },
        old.pool_permitted ? bounds[j]! : 0));
      }
    }
    for (const model of eligible) {
      const owner = commandOwner(snapshot, model);
      if (model.category === "ev_charging" || owner === "$pool" || repairing(owner) || unavailableOwner(snapshot, owner, source.start)) continue;
      const command = old.device_commands?.[model.key];
      if (!compatible(command, model, snapshot)) continue;
      const bound = model.active_power_w;
      if (command.type === "switch_schedule" && command.on_seconds === 0 ||
        command.type === "permit_inhibit" && !command.permitted) copy(model, i, command, 0);
      else if (finite(bound) && bound > 0) copy(model, i, command, bound);
    }
    const boilers = eligible.filter(model => model.category === "hot_water" &&
      result.commands[model.key]?.[i]?.type === "permit_inhibit");
    if (boilers.length) result.boiler[i] = {
      boiler_permitted: boilers.some(model => (result.commands[model.key][i] as Extract<DeviceCommand, {type: "permit_inhibit"}>).permitted),
      boiler_expected_w: boilers.reduce((sum, model) => sum + result.power[model.key][i], 0),
      boiler_battery_allowed: old.boiler_battery_allowed === true,
    };
  }
  const owners = new Map<string, Model[]>();
  for (const model of eligible) {
    const owner = commandOwner(snapshot, model);
    if (model.category === "ev_charging" && !recoveredEv || owner === "$pool" && !recoveredPool) continue;
    owners.set(owner, [...(owners.get(owner) ?? []), model]);
  }
  for (const [owner, models] of owners) {
    const retained = snapshot.slots.filter((_slot, i) => models.some(model => result.commands[model.key]?.[i])).length;
    if (!retained && owner !== "$ev" && owner !== "$pool") continue;
    result.warnings.push(planningWarning("service_commands_retained", owner,
      `${models.map(model => model.name).join(", ")}: current evidence cannot support a new schedule.`,
      "Accepted instructions are retained where their original intervals and equipment bounds are known. Uncovered intervals keep existing settings; no store state is invented.",
      { retained_intervals: retained, uncovered_intervals: n - retained }));
  }
  return result;
}
