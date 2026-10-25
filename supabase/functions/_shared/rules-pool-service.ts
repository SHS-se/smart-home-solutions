import type { OptimisationSnapshot, PlannedSlot } from "./planner/planning-contracts.ts";
import { type PublishedHeater, type ThermalStoreModel } from "./planner/device-models.ts";
import { poolPhysics } from "./planner/pool-physics.ts";
import { poolElectricalDemand } from "./planner/models/pool/electrical.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { commandOwner, unavailableOwner } from "./rules-commitments.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";

export interface PoolService {
  physics: { store: ThermalStoreModel; heater: PublishedHeater } | null;
  pending_heat_kwh: number | null;
  source_depletion_kwh: number | null;
  empirical: boolean;
  permitted: (boolean | null)[];
  command_w: (number | null)[];
  commands: Record<string, DeviceCommand[]>;
  power: Record<string, number[]>;
  total_w: number[];
  stop_c: number | null;
  warnings: PlanningWarning[];
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Statistical evidence selects a forecast method, never whether the home plans. */
export function preparePoolService(snapshot: OptimisationSnapshot, retained: Partial<PlannedSlot>[] = [], acceptedStopC?: number | null): PoolService {
  const members = snapshot.device_models.filter(m => m.planning_service === "pool");
  const n = snapshot.slots.length;
  const empty = (): PoolService => ({ physics: null, pending_heat_kwh: null, source_depletion_kwh: null, empirical: false, permitted: [], command_w: [], commands: {}, power: {}, total_w: [], stop_c: null, warnings: [] });
  if (!snapshot.capabilities.pool) return empty();
  const target = snapshot.comfort?.pool?.target_c;
  const stop = finite(target) ? target : snapshot.pool_model?.hardware?.stop_c;
  let reason = "Pool thermal evidence is incomplete";
  try {
    if (!snapshot.pool) throw new Error("Pool water state is unavailable");
    if (!finite(target)) throw new Error("Pool comfort target is unavailable");
    if (!finite(stop)) throw new Error("Pool stop setting is unavailable");
    if (finite(snapshot.pool_model?.cutout_air_c)) throw new Error("Pool air cutout is represented in the empirical permit schedule");
    const physics = poolPhysics(snapshot);
    const depletion = physics.heater.source ? snapshot.pool_model?.source_depletion_kwh : null;
    if (physics.heater.source && (!finite(depletion) || depletion < 0 || physics.heater.source.heat_loss_per_kwh * depletion >= 1)) throw new Error('Pool source memory has not been reconstructed');
    const pending = physics.store.response_time_constant_h === 0 ? 0 : snapshot.pool_model?.pending_heat_kwh;
    if (!finite(pending) || pending < 0) throw new Error("Pool response memory has not been reconstructed");
    if (physics.store.loss.kind === "linear" && physics.store.loss.surroundings_c === null &&
      snapshot.slots.some((_slot, i) => !finite(snapshot.outdoor_temperature_c?.[i]))) {
      throw new Error("Pool weather coverage is incomplete");
    }
    const hardware = snapshot.pool_model?.hardware ?? snapshot.pool.hardware;
    if (!hardware || hardware.control !== "external_enable" || !finite(hardware.start_c) || !finite(hardware.stop_c)) {
      throw new Error("Pool native start/stop evidence is incomplete");
    }
    return { ...empty(), physics, pending_heat_kwh: pending, source_depletion_kwh: depletion ?? null, stop_c: stop };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const power = Object.fromEntries(members.map(m => [m.key, m.forecast_w_by_slot.slice()]));
  const demand = poolElectricalDemand(snapshot);
  const rating = (key: string) => demand.member_w[key] ?? 0;
  const permitted = snapshot.slots.map((_slot, i) => {
    if (unavailableOwner(snapshot, "$pool", snapshot.slots[i].start) || !finite(acceptedStopC)) return null;
    const old = retained[i];
    return typeof old?.pool_permitted === "boolean" && finite(old.pool_command_w) ? old.pool_permitted : null;
  });
  const commands: Record<string, DeviceCommand[]> = Object.fromEntries(members.map(m => [m.key, []]));
  for (const m of members) for (let i = 0; i < n; i++) {
    const owner = commandOwner(snapshot, m), old = retained[i];
    const noInstruction: DeviceCommand = { type: "unavailable", reason: "Pool rescheduling failed; no accepted instruction covers this interval. Existing settings are retained." };
    commands[m.key][i] = noInstruction;
    if (unavailableOwner(snapshot, owner, snapshot.slots[i].start)) continue;
    // A separately owned pump keeps its own accepted command, never the
    // thermal owner's permission. With no command its measured demand is passive.
    if (owner !== "$pool") {
      const command = old?.device_commands?.[m.key];
      if (command?.type === m.control_type) {
        commands[m.key][i] = structuredClone(command);
        const held = old?.device_loads_w?.[m.key];
        if (finite(held)) power[m.key][i] = held;
      }
      continue;
    }
    if (permitted[i] === null) continue;
    const command = old?.device_commands?.[m.key];
    if (command?.type === m.control_type) commands[m.key][i] = structuredClone(command);
    // Retained ON still reserves equipment draw, not a previous duty average.
    power[m.key][i] = permitted[i] ? rating(m.key) > 0 ? rating(m.key) : power[m.key][i] : 0;
  }
  // Capture diagnostics explain missing evidence; this owner decides whether a
  // temperature projection was actually possible. Publish one pool-level note,
  // including failures after capture (for example an unusable source model).
  const captured = snapshot.planning_warnings?.find(w => w.scope === "pool" && w.code === "pool_response_evidence");
  const detail = [...new Set([captured?.message, reason].filter(Boolean))].join(". ");
  const retainedCount = permitted.filter(on => on !== null).length;
  return { physics: null, pending_heat_kwh: null, source_depletion_kwh: null, empirical: true, permitted, power, commands,
    command_w: permitted.map((on, i) => on === null ? null : retained[i].pool_command_w!),
    total_w: snapshot.slots.map((_s, i) => sum(Object.values(power).map(values => values[i]))),
    stop_c: finite(acceptedStopC) ? acceptedStopC : null,
    warnings: [planningWarning(captured?.code ?? "pool_reschedule_failed", "pool", "Pool rescheduling failed: " + detail.replace(/\.+$/, "") + ".",
      "Accepted pool instructions are retained. Uncovered intervals issue no new instruction and keep existing settings. Demand is estimated; a new temperature projection is unavailable.",
      { retained_intervals: retainedCount, uncovered_intervals: n - retainedCount })],
  };
}
