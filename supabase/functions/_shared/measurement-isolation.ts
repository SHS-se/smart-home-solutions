/**
 * An impossible device reading takes only its own device out of the plan.
 *
 * User requirement, 23 September 2026 (see
 * docs/energy-optimisation/authoritative-plan-contract.md). Realistic state is
 * planned as it is: a car above its charge limit, a pool warmer than its stop
 * temperature and a pack below a cut-off raised after it discharged are all
 * states a household can be in, and none of them is an error. A reading no
 * device can produce — a state of charge above 100 %, a pool at 500 °C, a
 * negative usable energy — is an error in the sensor. It must affect only its
 * device: that device leaves this plan exactly as a disabled capability does,
 * the reading is named for both interfaces, and every other device is planned
 * as usual.
 *
 * The ranges below are physical, not predictions or confidence bounds. The
 * pool and vehicle ranges were already enforced for the whole snapshot; only
 * their consequence changed.
 */
import type { OptimisationSnapshot } from "./energy-optimisation.ts";

export const ISOLATED_DEVICES = ["battery", "ev", "pool"] as const;
export type IsolatedDevice = typeof ISOLATED_DEVICES[number];

export interface MeasurementIssue {
  /** The planning store the reading belongs to, and which this plan omits. */
  device: IsolatedDevice;
  /** Which reading, in the snapshot's own field names. */
  field: string;
  /** The Home Assistant entity that reported it, when one did. */
  entity_id: string | null;
  /** What was reported: a number, or Home Assistant's state text. */
  value: number | string | null;
  /** One sentence for the reader: what was reported and why it cannot be real. */
  reason: string;
  /** Home Assistant left the device out itself; the planner found the rest. */
  detected_by: "home_assistant" | "planner";
}

const NO_BATTERY_POLICY: OptimisationSnapshot["policy"] = {
  battery_end_of_solar_target_soc: 0,
  battery_target_is_hard: false,
  terminal_soc_min: 0,
  terminal_energy_value_sek_per_kwh: 0,
  battery_export_enabled: false,
  battery_export_reserve_soc: 0,
  battery_export_min_price_sek_per_kwh: 0,
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const within = (value: unknown, low: number, high: number): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= low &&
  value <= high;
const percent = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 1000) / 10}%`
    : `"${String(value)}"`;
const reported = (value: unknown): number | string | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : value === null || value === undefined
    ? null
    : String(value);

/** Home Assistant's own findings, in the shape both interfaces read. */
function reportedIssues(snapshot: OptimisationSnapshot): MeasurementIssue[] {
  const supplied = snapshot.measurement_issues;
  if (supplied === undefined) return [];
  if (!Array.isArray(supplied)) {
    throw new Error("measurement_issues must be an array");
  }
  return supplied.map((issue, index) => {
    if (
      !record(issue) ||
      !ISOLATED_DEVICES.includes(issue.device as IsolatedDevice) ||
      !text(issue.field) || !text(issue.reason) ||
      !(issue.entity_id === null || text(issue.entity_id)) ||
      !(issue.value === null || typeof issue.value === "string" ||
        (typeof issue.value === "number" && Number.isFinite(issue.value))) ||
      !["home_assistant", "planner"].includes(issue.detected_by as string)
    ) {
      throw new Error(`measurement_issues[${index}] is invalid`);
    }
    return { ...issue } as MeasurementIssue;
  });
}

/** Readings present in the snapshot that no device could have produced. */
function impossibleReadings(snapshot: OptimisationSnapshot): MeasurementIssue[] {
  const issues: MeasurementIssue[] = [];
  const add = (
    device: IsolatedDevice,
    field: string,
    entity: unknown,
    value: unknown,
    reason: string,
  ) =>
    issues.push({
      device,
      field,
      entity_id: text(entity) ? entity : null,
      value: reported(value),
      reason,
      detected_by: "planner",
    });

  const battery = snapshot.battery;
  if (record(battery) && !within(battery.soc, 0, 1)) {
    add(
      "battery",
      "soc",
      snapshot.sources?.battery?.entity_ids?.[0],
      battery.soc,
      `The home battery reported a state of charge of ${
        percent(battery.soc)
      }, outside 0–100%.`,
    );
  }

  const vehicle = snapshot.ev_battery;
  if (record(vehicle)) {
    const sources: Record<string, unknown> = record(vehicle.source_entity_ids)
      ? vehicle.source_entity_ids
      : {};
    if (!within(vehicle.soc, 0, 1)) {
      add(
        "ev",
        "soc",
        sources.soc,
        vehicle.soc,
        `The car reported a state of charge of ${
          percent(vehicle.soc)
        }, outside 0–100%.`,
      );
    }
    if (!within(vehicle.departure_target_soc, 0, 1)) {
      add(
        "ev",
        "departure_target_soc",
        sources.target_soc,
        vehicle.departure_target_soc,
        `The car reported a charge limit of ${
          percent(vehicle.departure_target_soc)
        }, outside 0–100%.`,
      );
    }
    // Derived from the car's usable energy and state of charge, so a negative
    // or absurd energy reading surfaces here.
    if (!within(vehicle.capacity_kwh, 1, 500)) {
      add(
        "ev",
        "capacity_kwh",
        sources.energy_remaining,
        vehicle.capacity_kwh,
        `The car's readings imply a ${
          reported(vehicle.capacity_kwh)
        } kWh battery, outside 1–500 kWh.`,
      );
    }
  }

  const pool = snapshot.pool;
  if (record(pool) && !within(pool.water_temperature_c, -5, 60)) {
    add(
      "pool",
      "water_temperature_c",
      record(pool.source_entity_ids)
        ? pool.source_entity_ids.water_temperature
        : null,
      pool.water_temperature_c,
      `The pool reported a water temperature of ${
        reported(pool.water_temperature_c)
      } °C, outside −5–60 °C.`,
    );
  }
  return issues;
}

/** The snapshot as the planner sees it once `device` is left out. */
function withoutDevice(
  snapshot: OptimisationSnapshot,
  device: IsolatedDevice,
): OptimisationSnapshot {
  const capabilities = { ...snapshot.capabilities, [device]: false };
  if (device === "ev") {
    return {
      ...snapshot,
      capabilities,
      ev_battery: null,
      services: snapshot.services.filter((service) => service.device !== "ev"),
    };
  }
  if (device === "pool") {
    return {
      ...snapshot,
      capabilities,
      pool: null,
      services: snapshot.services.filter((service) =>
        service.device !== "pool"
      ),
    };
  }
  // A home without a usable battery reading is planned as a home without a
  // battery: no store, no policy and no execution contract to hand over.
  const result: OptimisationSnapshot = {
    ...snapshot,
    capabilities,
    battery: null,
    sources: { ...snapshot.sources, battery: null },
    policy: { ...NO_BATTERY_POLICY },
  };
  delete result.battery_execution_feedback;
  return result;
}

/**
 * Leave out every device with a named measurement issue, and name them all.
 *
 * Idempotent: the returned snapshot carries the complete list, so planning it
 * again finds nothing new and leaves out the same devices.
 */
export function isolateMeasurements(
  snapshot: OptimisationSnapshot,
): OptimisationSnapshot {
  const issues = [...reportedIssues(snapshot), ...impossibleReadings(snapshot)];
  if (issues.length === 0) return snapshot;
  let isolated = snapshot;
  for (const device of new Set(issues.map((issue) => issue.device))) {
    isolated = withoutDevice(isolated, device);
  }
  return { ...isolated, measurement_issues: issues };
}
