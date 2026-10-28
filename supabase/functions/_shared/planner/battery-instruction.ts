/** The planner's stated battery instruction and demand partition (contract v2).
 *
 * The native candidate the optimiser chose is the instruction; nothing is
 * reconstructed from forecast flows. HA applies the stated law to live
 * measurements.
 */

/** How household supply responds to live demand. */
export type SupplyResponse =
  | { mode: "follow_demand" }
  | { mode: "import_target"; import_target_w: number }
  | { mode: "fixed"; discharge_ac_w: number; import_target_w: number | null };

/** One quarter's instruction. All powers are integer AC watts. */
export type BatteryInstruction =
  | { kind: "idle" }
  | { kind: "hold"; charge_ac_limit_w: number }
  | { kind: "solar_charge"; charge_ac_limit_w: number }
  | { kind: "grid_charge"; charge_ac_w: number }
  | { kind: "supply"; profile_id: string; charge_ac_limit_w: number; discharge_ac_limit_w: number; response: SupplyResponse }
  | { kind: "export"; profile_id: string; discharge_ac_w: number };

export interface DemandLoad { key: string; name: string; category: string }
export interface DemandProfile { id: string; include_base: boolean; eligible_keys: string[] }
/** Base load is the house minus every listed load. */
export interface BatteryDemand { loads: DemandLoad[]; profiles: DemandProfile[] }

type NativeOperation = "idle" | "solar_charge" | "hold" | "self_consumption" | "grid_charge" | "supply_house" | "export" | "shave_import";
interface NativeBattery { battery: NativeOperation; charge_limit_w: number; discharge_limit_w: number }

const WITH_WATER = "base+loads";
const WITHOUT_WATER = "base+loads-hot-water";

/** Every load the plan separated from base, and the profiles its quarters use.
 *
 * The battery may supply base and every listed load except EV charging; hot
 * water only in quarters whose plan lets the battery supply it.
 */
export function batteryDemand(
  models: Array<{ key: string; name: string; category: string }>,
  waterAllowed: Array<boolean | undefined>,
): BatteryDemand {
  const loads = models.map(({ key, name, category }) => ({ key, name, category }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const eligible = (water: boolean) => loads
    .filter((l) => l.category !== "ev_charging" && (water || l.category !== "hot_water")).map((l) => l.key);
  const used = new Set(waterAllowed.map(profileFor));
  const profiles = [
    { id: WITH_WATER, include_base: true, eligible_keys: eligible(true) },
    { id: WITHOUT_WATER, include_base: true, eligible_keys: eligible(false) },
  ].filter((p) => used.has(p.id));
  return { loads, profiles };
}

export function profileFor(waterAllowed: boolean | undefined): string {
  return waterAllowed === false ? WITHOUT_WATER : WITH_WATER;
}

/** The chosen native candidate, stated as the instruction HA executes. */
export function instructionFor(
  command: NativeBattery,
  quarter: { charge_w: number; discharge_w: number },
  profile_id: string,
  limits: { import_w: number; discharge_max_w: number },
): BatteryInstruction {
  const w = Math.floor;
  switch (command.battery) {
    case "idle": return { kind: "idle" };
    case "hold": return { kind: "hold", charge_ac_limit_w: w(command.charge_limit_w) };
    case "solar_charge": return { kind: "solar_charge", charge_ac_limit_w: w(command.charge_limit_w) };
    // Native scored integer requests retain their identity when DC/SOC/grid
    // saturation produces a smaller fractional physical reference flow.
    case "grid_charge": return quarter.charge_w > 0 ? { kind: "grid_charge", charge_ac_w: w(command.charge_limit_w) } : { kind: "idle" };
    case "export": return quarter.discharge_w > 0 ? { kind: "export", profile_id, discharge_ac_w: w(command.discharge_limit_w) } : { kind: "idle" };
    case "self_consumption":
      return { kind: "supply", profile_id, charge_ac_limit_w: w(command.charge_limit_w),
        discharge_ac_limit_w: w(command.discharge_limit_w), response: { mode: "follow_demand" } };
    case "supply_house":
      return { kind: "supply", profile_id, charge_ac_limit_w: w(command.charge_limit_w),
        discharge_ac_limit_w: w(Math.max(limits.discharge_max_w, command.discharge_limit_w)),
        response: { mode: "fixed", discharge_ac_w: w(command.discharge_limit_w), import_target_w: w(limits.import_w) } };
    case "shave_import":
      return { kind: "supply", profile_id, charge_ac_limit_w: w(command.charge_limit_w),
        discharge_ac_limit_w: w(command.discharge_limit_w), response: { mode: "import_target", import_target_w: w(limits.import_w) } };
  }
}

/** A committed quarter's instruction as the native command it was chosen as. */
export function nativeBattery(instruction: BatteryInstruction): NativeBattery {
  switch (instruction.kind) {
    case "idle": return { battery: "idle", charge_limit_w: 0, discharge_limit_w: 0 };
    case "hold": return { battery: "hold", charge_limit_w: instruction.charge_ac_limit_w, discharge_limit_w: 0 };
    case "solar_charge": return { battery: "solar_charge", charge_limit_w: instruction.charge_ac_limit_w, discharge_limit_w: 0 };
    case "grid_charge": return { battery: "grid_charge", charge_limit_w: instruction.charge_ac_w, discharge_limit_w: 0 };
    case "export": return { battery: "export", charge_limit_w: 0, discharge_limit_w: instruction.discharge_ac_w };
    case "supply": {
      const r = instruction.response;
      return r.mode === "follow_demand"
        ? { battery: "self_consumption", charge_limit_w: instruction.charge_ac_limit_w, discharge_limit_w: instruction.discharge_ac_limit_w }
        : r.mode === "import_target"
        ? { battery: "shave_import", charge_limit_w: instruction.charge_ac_limit_w, discharge_limit_w: instruction.discharge_ac_limit_w }
        : { battery: "supply_house", charge_limit_w: instruction.charge_ac_limit_w, discharge_limit_w: r.discharge_ac_w };
    }
  }
}
