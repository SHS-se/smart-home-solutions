/**
 * Pure 15-minute energy planner shared by the ingestion edge function and its
 * contract tests. It deliberately has no database or browser dependencies.
 *
 * The planner is a deterministic, explainable heuristic. It is not a device
 * controller: Home Assistant still owns interlocks, overrides, thermostats and
 * command confirmation. Every schedule is simulated independently and then
 * verified before it may be published as `ready`.
 */

export const OPTIMISATION_SCHEMA_VERSION = 1;
export const OPTIMISATION_MODEL_VERSION = "quarter-hour-heuristic-v1";
export const SLOT_MINUTES = 15;
export const SLOT_HOURS = SLOT_MINUTES / 60;
export const MAX_FORECAST_SLOTS = 72 * 4;
const SLOT_MS = SLOT_MINUTES * 60_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;
const MAX_SOURCE_FUTURE_SKEW_MS = 5 * 60_000;
const SOURCE_MAX_AGE_MS = {
  pv: 12 * 60 * 60_000,
  base_load: 3 * 60 * 60_000,
  import_price: 48 * 60 * 60_000,
  export_price: 48 * 60 * 60_000,
  battery: 15 * 60_000,
} as const;

export type PlanKey = "baseline" | "priority" | "cost";
export type DeviceKey = "pool" | "boiler" | "ev";

export interface SourceProvenance {
  provider: string;
  entity_ids: string[];
  issued_at: string;
  valid_until: string;
  quality: "measured" | "calibrated" | "provider_raw";
  sample_count?: number;
  mape_percent?: number;
  bias_percent?: number;
  location?: {
    latitude?: number;
    longitude?: number;
    market_area?: string;
  };
}

export interface ForecastSlotInput {
  start: string;
  pv_forecast_w: number;
  base_load_forecast_w: number;
  base_load_p10_w: number;
  base_load_p90_w: number;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
}

export interface BatteryInput {
  capacity_kwh: number;
  soc: number;
  min_soc: number;
  max_soc: number;
  charge_max_w: number;
  discharge_max_w: number;
  charge_efficiency: number;
  discharge_efficiency: number;
}

export interface ServiceInput {
  id: string;
  device: DeviceKey;
  earliest_start: string;
  deadline: string;
  required_kwh: number;
  power_w: number;
  min_run_slots: number;
  priority: number;
  baseline_preferred_start?: string;
}

export interface OptimisationSnapshotV1 {
  schema_version: 1;
  snapshot_id: string;
  captured_at: string;
  timezone: string;
  slot_minutes: 15;
  slots: ForecastSlotInput[];
  sources: {
    pv: SourceProvenance;
    base_load: SourceProvenance;
    import_price: SourceProvenance;
    export_price: SourceProvenance;
    battery: SourceProvenance;
  };
  pv_calibration: {
    correction_factor_by_lead_day: number[];
    sample_count_by_lead_day: number[];
  };
  battery: BatteryInput;
  grid: {
    import_limit_w: number;
    export_limit_w: number;
  };
  policy: {
    battery_end_of_solar_target_soc: number;
    battery_target_is_hard: boolean;
    terminal_soc_min: number;
    terminal_energy_value_sek_per_kwh: number;
  };
  services: ServiceInput[];
  service_requirement_sample_days: Record<string, number>;
}

export interface PlannedSlot {
  start: string;
  binding: boolean;
  pv_raw_w: number;
  pv_w: number;
  base_w: number;
  base_p10_w: number;
  base_p90_w: number;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
  pool_w: number;
  boiler_w: number;
  ev_w: number;
  load_w: number;
  battery_charge_w: number;
  battery_discharge_w: number;
  battery_soc: number;
  grid_import_w: number;
  grid_export_w: number;
  curtailed_w: number;
  unserved_w: number;
  import_cost_sek: number | null;
  export_revenue_sek: number | null;
}

export interface PlanSummary {
  load_kwh: number;
  flexible_load_kwh: number;
  pv_kwh: number;
  grid_import_kwh: number;
  grid_export_kwh: number;
  curtailed_kwh: number;
  priced_import_kwh: number;
  priced_export_kwh: number;
  net_cost_sek: number;
  terminal_adjusted_cost_sek: number;
  battery_soc_start: number;
  battery_soc_end: number;
  battery_soc_low: number;
  battery_end_of_solar_soc: Record<string, number>;
  service_required_kwh: number;
  service_delivered_kwh: number;
}

export interface GeneratedPlan {
  key: PlanKey;
  label: string;
  status: "ready" | "infeasible";
  validation_errors: string[];
  slots: PlannedSlot[];
  summary: PlanSummary;
  service_slots: Record<string, number[]>;
}

export interface OptimisationPlanV1 {
  schema_version: 1;
  model_version: string;
  plan_id: string;
  snapshot_id: string;
  issued_at: string;
  valid_until: string;
  binding_until: string;
  timezone: string;
  slot_minutes: 15;
  status: "ready" | "incomplete" | "infeasible";
  validation_errors: string[];
  sources: OptimisationSnapshotV1["sources"];
  pv_calibration: OptimisationSnapshotV1["pv_calibration"];
  policy: OptimisationSnapshotV1["policy"];
  battery: BatteryInput;
  grid: OptimisationSnapshotV1["grid"];
  services: ServiceInput[];
  service_requirement_sample_days: Record<string, number>;
  plans: Record<PlanKey, GeneratedPlan>;
}

interface PreparedSlot extends ForecastSlotInput {
  index: number;
  epoch_ms: number;
  pv_raw_w: number;
  pv_w: number;
  binding: boolean;
}

interface Schedule {
  pool: number[];
  boiler: number[];
  ev: number[];
  serviceSlots: Record<string, number[]>;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const inRange = (value: number, min: number, max: number) =>
  finite(value) && value >= min && value <= max;

const isoMs = (value: string) => Date.parse(value);

const round = (value: number, digits = 5) => {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const localDay = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));

const localMinuteOfDay = (iso: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
};

function completedLocalDays(
  slots: PreparedSlot[],
  timezone: string,
): Set<string> {
  const horizonEnd = new Date(
    slots[slots.length - 1].epoch_ms + SLOT_MS,
  ).toISOString();
  const endDay = localDay(horizonEnd, timezone);
  return new Set(
    slots.map((slot) => localDay(slot.start, timezone)).filter((day) =>
      day < endDay
    ),
  );
}

export function validateSnapshot(snapshot: OptimisationSnapshotV1): string[] {
  const errors: string[] = [];
  if (snapshot?.schema_version !== OPTIMISATION_SCHEMA_VERSION) {
    errors.push("schema_version must be 1");
  }
  if (snapshot?.slot_minutes !== SLOT_MINUTES) {
    errors.push("slot_minutes must be 15");
  }
  if (!UUID_RE.test(snapshot?.snapshot_id ?? "")) {
    errors.push("snapshot_id must be a UUID");
  }
  if (!Number.isFinite(isoMs(snapshot?.captured_at))) {
    errors.push("captured_at is invalid");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: snapshot?.timezone }).format();
  } catch {
    errors.push("timezone is invalid");
  }
  if (
    !Array.isArray(snapshot?.slots) || snapshot.slots.length < 4 ||
    snapshot.slots.length > MAX_FORECAST_SLOTS
  ) {
    errors.push(`slots must contain 4..${MAX_FORECAST_SLOTS} quarter-hours`);
  }

  let previous = -1;
  for (const [index, slot] of (snapshot?.slots ?? []).entries()) {
    const start = isoMs(slot?.start);
    if (!Number.isFinite(start)) {
      errors.push(`slots[${index}].start is invalid`);
    }
    if (start % (SLOT_MINUTES * 60_000) !== 0) {
      errors.push(`slots[${index}].start is not quarter-hour aligned`);
    }
    if (previous >= 0 && start - previous !== SLOT_MINUTES * 60_000) {
      errors.push(`slots[${index}] is not contiguous`);
    }
    previous = start;
    for (
      const [field, value] of [
        ["pv_forecast_w", slot?.pv_forecast_w],
        ["base_load_forecast_w", slot?.base_load_forecast_w],
      ] as const
    ) {
      if (!finite(value) || value < 0 || value > 100_000) {
        errors.push(`slots[${index}].${field} is invalid`);
      }
    }
    if (
      !finite(slot?.base_load_p10_w) || !finite(slot?.base_load_p90_w) ||
      slot.base_load_p10_w < 0 || slot.base_load_p90_w < slot.base_load_p10_w ||
      slot.base_load_forecast_w < slot.base_load_p10_w ||
      slot.base_load_forecast_w > slot.base_load_p90_w
    ) {
      errors.push(`slots[${index}] has invalid base-load confidence bounds`);
    }
    for (
      const field of [
        "import_price_sek_per_kwh",
        "export_price_sek_per_kwh",
      ] as const
    ) {
      const value = slot?.[field];
      if (value !== null && (!finite(value) || value < -20 || value > 100)) {
        errors.push(`slots[${index}].${field} is invalid`);
      }
    }
    if (
      (slot?.import_price_sek_per_kwh === null) !==
        (slot?.export_price_sek_per_kwh === null)
    ) {
      errors.push(
        `slots[${index}] must price import and export over the same binding interval`,
      );
    }
  }

  const battery = snapshot?.battery;
  if (!battery || !inRange(battery.capacity_kwh, 0.1, 1_000)) {
    errors.push("battery.capacity_kwh is invalid");
  } else {
    if (
      !inRange(battery.min_soc, 0, 1) || !inRange(battery.max_soc, 0, 1) ||
      battery.min_soc >= battery.max_soc
    ) errors.push("battery SOC bounds are invalid");
    if (!inRange(battery.soc, battery.min_soc, battery.max_soc)) {
      errors.push("battery.soc is outside its configured bounds");
    }
    if (
      !inRange(battery.charge_efficiency, 0.5, 1) ||
      !inRange(battery.discharge_efficiency, 0.5, 1)
    ) {
      errors.push("battery efficiencies are invalid");
    }
    if (
      !inRange(battery.charge_max_w, 0, 100_000) ||
      !inRange(battery.discharge_max_w, 0, 100_000)
    ) {
      errors.push("battery power limits are invalid");
    }
  }
  if (
    !snapshot?.grid || !inRange(snapshot.grid.import_limit_w, 100, 500_000) ||
    !inRange(snapshot.grid.export_limit_w, 0, 500_000)
  ) {
    errors.push("grid limits are invalid");
  }
  if (
    !snapshot?.policy ||
    typeof snapshot.policy.battery_target_is_hard !== "boolean" ||
    !inRange(snapshot.policy.battery_end_of_solar_target_soc, 0, 1) ||
    !inRange(snapshot.policy.terminal_soc_min, 0, 1) ||
    !inRange(snapshot.policy.terminal_energy_value_sek_per_kwh, -20, 100)
  ) {
    errors.push("policy is invalid");
  } else if (
    battery && (
      !inRange(
        snapshot.policy.battery_end_of_solar_target_soc,
        battery.min_soc,
        battery.max_soc,
      ) ||
      !inRange(
        snapshot.policy.terminal_soc_min,
        battery.min_soc,
        battery.max_soc,
      )
    )
  ) {
    errors.push("battery policy targets are outside the configured SOC bounds");
  }

  const firstStart = isoMs(snapshot?.slots?.[0]?.start);
  const horizonEnd = previous + SLOT_MINUTES * 60_000;
  const capturedAt = isoMs(snapshot?.captured_at);
  if (
    Number.isFinite(firstStart) && Number.isFinite(capturedAt) &&
    (firstStart < Math.floor(capturedAt / SLOT_MS) * SLOT_MS ||
      firstStart > capturedAt + SLOT_MS)
  ) {
    errors.push(
      "first forecast slot must start at the current or next quarter-hour",
    );
  }
  if (snapshot?.slots?.[0]?.import_price_sek_per_kwh === null) {
    errors.push("the first forecast slot must have import and export prices");
  }
  if (!Array.isArray(snapshot?.services)) {
    errors.push("services must be an array");
  }
  const ids = new Set<string>();
  for (const [index, service] of (snapshot?.services ?? []).entries()) {
    if (!service?.id || ids.has(service.id)) {
      errors.push(`services[${index}].id is missing or duplicated`);
    }
    ids.add(service?.id);
    if (!["pool", "boiler", "ev"].includes(service?.device)) {
      errors.push(`services[${index}].device is invalid`);
    }
    const earliest = isoMs(service?.earliest_start);
    const deadline = isoMs(service?.deadline);
    if (
      !Number.isFinite(earliest) || !Number.isFinite(deadline) ||
      earliest >= deadline ||
      earliest < firstStart || deadline > horizonEnd
    ) {
      errors.push(`services[${index}] has an invalid service window`);
    }
    if (
      !inRange(service?.required_kwh, 0, 1_000) ||
      !inRange(service?.power_w, 100, 100_000) ||
      !Number.isInteger(service?.min_run_slots) || service.min_run_slots < 1 ||
      service.min_run_slots > 96 || !Number.isInteger(service?.priority) ||
      service.priority < 1
    ) {
      errors.push(
        `services[${index}] has invalid energy, power or minimum run time`,
      );
    }
  }

  for (
    const key of [
      "pv",
      "base_load",
      "import_price",
      "export_price",
      "battery",
    ] as const
  ) {
    const source = snapshot?.sources?.[key];
    if (
      !source?.provider || !Array.isArray(source?.entity_ids) ||
      source.entity_ids.length === 0 ||
      source.entity_ids.some((entityId) =>
        typeof entityId !== "string" || !entityId
      ) ||
      !["measured", "calibrated", "provider_raw"].includes(source?.quality) ||
      !Number.isFinite(isoMs(source?.issued_at)) ||
      !Number.isFinite(isoMs(source?.valid_until))
    ) {
      errors.push(`sources.${key} is incomplete`);
      continue;
    }
    const issuedAt = isoMs(source.issued_at);
    const validUntil = isoMs(source.valid_until);
    if (
      issuedAt > capturedAt + MAX_SOURCE_FUTURE_SKEW_MS ||
      capturedAt - issuedAt > SOURCE_MAX_AGE_MS[key]
    ) {
      errors.push(`sources.${key} is stale or future-dated`);
    }
    if (validUntil <= firstStart) {
      errors.push(`sources.${key} does not cover the first forecast slot`);
    }
  }
  const pvLocation = snapshot?.sources?.pv?.location;
  if (
    !finite(pvLocation?.latitude) || !finite(pvLocation?.longitude) ||
    !inRange(pvLocation.latitude, -90, 90) ||
    !inRange(pvLocation.longitude, -180, 180)
  ) {
    errors.push("sources.pv.location is required");
  }
  const importArea = snapshot?.sources?.import_price?.location?.market_area;
  const exportArea = snapshot?.sources?.export_price?.location?.market_area;
  if (!/^SE[1-4]$/.test(importArea ?? "") || importArea !== exportArea) {
    errors.push(
      "import and export sources must declare the same Swedish market area",
    );
  }
  const importEntities = new Set(
    snapshot?.sources?.import_price?.entity_ids ?? [],
  );
  if (
    (snapshot?.sources?.export_price?.entity_ids ?? []).some((entityId) =>
      importEntities.has(entityId)
    )
  ) {
    errors.push("import and export prices must use separate source entities");
  }
  const factors = snapshot?.pv_calibration?.correction_factor_by_lead_day;
  const counts = snapshot?.pv_calibration?.sample_count_by_lead_day;
  if (
    !Array.isArray(factors) || !Array.isArray(counts) || factors.length !== 4 ||
    counts.length !== factors.length ||
    factors.some((factor) => !inRange(factor, 0.25, 2)) ||
    counts.some((count) => !Number.isInteger(count) || count < 0)
  ) {
    errors.push(
      "pv_calibration must contain four bounded lead-day factors and sample counts",
    );
  }
  if (
    !snapshot?.service_requirement_sample_days ||
    typeof snapshot.service_requirement_sample_days !== "object" ||
    Array.isArray(snapshot.service_requirement_sample_days) ||
    Object.values(snapshot.service_requirement_sample_days).some((count) =>
      !Number.isInteger(count) || count < 0
    )
  ) {
    errors.push("service_requirement_sample_days is invalid");
  }
  return [...new Set(errors)];
}

function preparedSlots(snapshot: OptimisationSnapshotV1): PreparedSlot[] {
  const captured = isoMs(snapshot.captured_at);
  let priceGapSeen = false;
  return snapshot.slots.map((slot, index) => {
    const epoch = isoMs(slot.start);
    const leadDay = Math.max(
      0,
      Math.min(
        snapshot.pv_calibration.correction_factor_by_lead_day.length - 1,
        Math.floor((epoch - captured) / 86_400_000),
      ),
    );
    const factor = snapshot.pv_calibration
      .correction_factor_by_lead_day[leadDay]!;
    const binding = !priceGapSeen && slot.import_price_sek_per_kwh !== null &&
      slot.export_price_sek_per_kwh !== null;
    if (!binding) priceGapSeen = true;
    return {
      ...slot,
      index,
      epoch_ms: epoch,
      pv_raw_w: slot.pv_forecast_w,
      pv_w: Math.max(0, slot.pv_forecast_w * factor),
      binding,
    };
  });
}

function requiredSlotCount(service: ServiceInput): number {
  if (service.required_kwh <= 0) return 0;
  const slots = Math.ceil(
    service.required_kwh / ((service.power_w / 1_000) * SLOT_HOURS),
  );
  return Math.max(service.min_run_slots, slots);
}

function candidateStarts(
  slots: PreparedSlot[],
  service: ServiceInput,
  count: number,
): number[] {
  if (count === 0) return [];
  const earliest = isoMs(service.earliest_start);
  const deadline = isoMs(service.deadline);
  const candidates: number[] = [];
  for (let start = 0; start + count <= slots.length; start += 1) {
    if (slots[start].epoch_ms < earliest) continue;
    if (slots[start + count - 1].epoch_ms + SLOT_MINUTES * 60_000 > deadline) {
      continue;
    }
    candidates.push(start);
  }
  return candidates;
}

function emptySchedule(length: number): Schedule {
  return {
    pool: new Array(length).fill(0),
    boiler: new Array(length).fill(0),
    ev: new Array(length).fill(0),
    serviceSlots: {},
  };
}

function scheduleServices(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshotV1,
  reservedW: number[],
): { schedule: Schedule; errors: string[] } {
  const schedule = emptySchedule(slots.length);
  const occupiedW = new Array(slots.length).fill(0);
  const errors: string[] = [];
  const services = [...snapshot.services].sort((a, b) =>
    isoMs(a.deadline) - isoMs(b.deadline) || a.priority - b.priority ||
    a.id.localeCompare(b.id)
  );

  for (const service of services) {
    const count = requiredSlotCount(service);
    if (count === 0) {
      schedule.serviceSlots[service.id] = [];
      continue;
    }
    const candidates = candidateStarts(slots, service, count).filter(
      (start) => {
        for (let offset = 0; offset < count; offset += 1) {
          const index = start + offset;
          // A physical device cannot satisfy two service commitments in the
          // same quarter. Other device classes may overlap when the grid limit
          // allows it, but a second run for this device needs its own window.
          if (schedule[service.device][index] > 0) return false;
          if (
            slots[index].base_load_forecast_w + occupiedW[index] +
                service.power_w >
              snapshot.grid.import_limit_w + Math.max(0, slots[index].pv_w)
          ) return false;
        }
        return true;
      },
    );
    if (candidates.length === 0) {
      errors.push(`${service.id}: no feasible contiguous ${count}-slot window`);
      schedule.serviceSlots[service.id] = [];
      continue;
    }

    const preferred = service.baseline_preferred_start
      ? isoMs(service.baseline_preferred_start)
      : isoMs(service.earliest_start);
    const score = (start: number) => {
      if (key === "baseline") {
        return Math.abs(slots[start].epoch_ms - preferred);
      }
      let total = 0;
      for (let offset = 0; offset < count; offset += 1) {
        const index = start + offset;
        const slot = slots[index];
        const remainingSolar = Math.max(
          0,
          slot.pv_w - slot.base_load_forecast_w - occupiedW[index] -
            reservedW[index],
        );
        const solarW = Math.min(service.power_w, remainingSolar);
        const gridW = service.power_w - solarW;
        if (slot.binding) {
          total += (solarW / 1_000) * SLOT_HOURS *
            slot.export_price_sek_per_kwh!;
          total += (gridW / 1_000) * SLOT_HOURS *
            slot.import_price_sek_per_kwh!;
        } else {
          // Advisory slots are ranked by forecast self-consumption only. A
          // monetary value is never invented beyond the published overlap.
          total += gridW / 100;
        }
        if (key === "priority" && reservedW[index] > 0) total += 1_000_000;
      }
      return total;
    };
    candidates.sort((a, b) => score(a) - score(b) || a - b);
    const chosen = candidates[0];
    const indices: number[] = [];
    for (let offset = 0; offset < count; offset += 1) {
      const index = chosen + offset;
      schedule[service.device][index] = service.power_w;
      occupiedW[index] += service.power_w;
      indices.push(index);
    }
    schedule.serviceSlots[service.id] = indices;
  }
  return { schedule, errors };
}

function batteryReservation(
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshotV1,
): { reservedW: number[]; protectedSoc: (number | null)[] } {
  const reservedW = new Array(slots.length).fill(0);
  const protectedSoc: (number | null)[] = new Array(slots.length).fill(null);
  if (!snapshot.policy.battery_target_is_hard) {
    return { reservedW, protectedSoc };
  }

  const target = snapshot.policy.battery_end_of_solar_target_soc;
  const battery = snapshot.battery;
  const completedDays = completedLocalDays(slots, snapshot.timezone);
  const byDay = new Map<string, number[]>();
  for (const slot of slots) {
    const day = localDay(slot.start, snapshot.timezone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(slot.index);
  }

  // Build the reservation chronologically from a base-load-only battery
  // trajectory. This accounts for pre-dawn drain and cloudy dips instead of
  // sizing the target from midnight SOC. The protected trajectory prevents a
  // lower-ranked load from spending charge already accumulated for the hard
  // target; the final independent simulation remains authoritative.
  let assumedSoc = battery.soc;
  for (const [day, indices] of byDay) {
    const solar = indices.filter((index) => slots[index].pv_w > 50);
    const enforceTarget = completedDays.has(day) && solar.length > 0;
    const firstSolar = enforceTarget ? solar[0] : -1;
    const lastSolar = enforceTarget ? solar[solar.length - 1] : -1;
    for (const index of indices) {
      const netW = slots[index].pv_w - slots[index].base_load_forecast_w;
      const roomKwh = Math.max(
        0,
        (battery.max_soc - assumedSoc) * battery.capacity_kwh,
      );
      const maxChargeW = Math.min(
        battery.charge_max_w,
        roomKwh / battery.charge_efficiency * 1_000 / SLOT_HOURS,
      );
      const availableKwh = Math.max(
        0,
        (assumedSoc - battery.min_soc) * battery.capacity_kwh,
      );
      let maxDischargeW = Math.min(
        battery.discharge_max_w,
        availableKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
      );
      if (enforceTarget && index >= lastSolar) {
        const aboveTargetKwh = Math.max(
          0,
          (assumedSoc - target) * battery.capacity_kwh,
        );
        maxDischargeW = Math.min(
          maxDischargeW,
          aboveTargetKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
        );
      }

      if (netW >= 0) {
        const chargeW = Math.min(netW, maxChargeW);
        const neededW = Math.max(0, target - assumedSoc) *
          battery.capacity_kwh /
          battery.charge_efficiency * 1_000 / SLOT_HOURS;
        if (enforceTarget && index >= firstSolar && index <= lastSolar) {
          reservedW[index] = Math.min(chargeW, neededW);
        }
        assumedSoc += chargeW * battery.charge_efficiency / 1_000 *
          SLOT_HOURS / battery.capacity_kwh;
      } else {
        const dischargeW = Math.min(-netW, maxDischargeW);
        assumedSoc -= dischargeW / battery.discharge_efficiency / 1_000 *
          SLOT_HOURS / battery.capacity_kwh;
      }
      assumedSoc = Math.max(
        battery.min_soc,
        Math.min(battery.max_soc, assumedSoc),
      );
      if (enforceTarget && index >= firstSolar && index <= lastSolar) {
        protectedSoc[index] = Math.min(target, assumedSoc);
      } else if (enforceTarget && index > lastSolar) {
        protectedSoc[index] = target;
      }
    }
  }
  return { reservedW, protectedSoc };
}

function simulate(
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshotV1,
  schedule: Schedule,
  protectedSoc: (number | null)[],
): { slots: PlannedSlot[]; summary: PlanSummary; errors: string[] } {
  const battery = snapshot.battery;
  let soc = battery.soc;
  let socLow = soc;
  const output: PlannedSlot[] = [];
  const errors: string[] = [];
  const endOfSolar: Record<string, number> = {};
  const completedDays = completedLocalDays(slots, snapshot.timezone);
  const endMarkerByDay = new Map<string, number>();
  for (const day of completedDays) {
    const daySlots = slots.filter((slot) =>
      localDay(slot.start, snapshot.timezone) === day
    );
    const solarSlots = daySlots.filter((slot) => slot.pv_w > 50);
    const marker = solarSlots.at(-1) ??
      (localMinuteOfDay(daySlots[0].start, snapshot.timezone) === 0
        ? daySlots.at(-1)
        : undefined);
    if (marker) endMarkerByDay.set(day, marker.index);
  }

  let loadKwh = 0;
  let flexibleKwh = 0;
  let pvKwh = 0;
  let importKwh = 0;
  let exportKwh = 0;
  let pricedImportKwh = 0;
  let pricedExportKwh = 0;
  let curtailedKwh = 0;
  let importCost = 0;
  let exportRevenue = 0;

  for (const slot of slots) {
    const poolW = schedule.pool[slot.index];
    const boilerW = schedule.boiler[slot.index];
    const evW = schedule.ev[slot.index];
    const flexibleW = poolW + boilerW + evW;
    const loadW = slot.base_load_forecast_w + flexibleW;
    const roomKwh = Math.max(0, (battery.max_soc - soc) * battery.capacity_kwh);
    const availableKwh = Math.max(
      0,
      (soc - battery.min_soc) * battery.capacity_kwh,
    );
    const maxChargeW = Math.min(
      battery.charge_max_w,
      roomKwh / battery.charge_efficiency * 1_000 / SLOT_HOURS,
    );
    let maxDischargeW = Math.min(
      battery.discharge_max_w,
      availableKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
    );
    const floor = protectedSoc[slot.index];
    if (floor !== null) {
      const aboveFloorKwh = Math.max(0, (soc - floor) * battery.capacity_kwh);
      maxDischargeW = Math.min(
        maxDischargeW,
        aboveFloorKwh * battery.discharge_efficiency * 1_000 / SLOT_HOURS,
      );
    }

    const netW = slot.pv_w - loadW;
    let batteryChargeW = 0;
    let batteryDischargeW = 0;
    let gridImportW = 0;
    let gridExportW = 0;
    let curtailedW = 0;
    let unservedW = 0;
    if (netW >= 0) {
      batteryChargeW = Math.min(netW, maxChargeW);
      const afterBatteryW = netW - batteryChargeW;
      gridExportW = Math.min(afterBatteryW, snapshot.grid.export_limit_w);
      curtailedW = Math.max(0, afterBatteryW - gridExportW);
    } else {
      const deficitW = -netW;
      batteryDischargeW = Math.min(deficitW, maxDischargeW);
      const afterBatteryW = deficitW - batteryDischargeW;
      gridImportW = Math.min(afterBatteryW, snapshot.grid.import_limit_w);
      unservedW = Math.max(0, afterBatteryW - gridImportW);
    }
    soc += (
      batteryChargeW * battery.charge_efficiency -
      batteryDischargeW / battery.discharge_efficiency
    ) / 1_000 * SLOT_HOURS / battery.capacity_kwh;
    soc = Math.max(battery.min_soc, Math.min(battery.max_soc, soc));
    socLow = Math.min(socLow, soc);

    const slotImportKwh = gridImportW / 1_000 * SLOT_HOURS;
    const slotExportKwh = gridExportW / 1_000 * SLOT_HOURS;
    const importCostSek = slot.binding
      ? slotImportKwh * slot.import_price_sek_per_kwh!
      : null;
    const exportRevenueSek = slot.binding
      ? slotExportKwh * slot.export_price_sek_per_kwh!
      : null;

    output.push({
      start: slot.start,
      binding: slot.binding,
      pv_raw_w: round(slot.pv_raw_w, 2),
      pv_w: round(slot.pv_w, 2),
      base_w: round(slot.base_load_forecast_w, 2),
      base_p10_w: round(slot.base_load_p10_w, 2),
      base_p90_w: round(slot.base_load_p90_w, 2),
      import_price_sek_per_kwh: slot.import_price_sek_per_kwh,
      export_price_sek_per_kwh: slot.export_price_sek_per_kwh,
      pool_w: poolW,
      boiler_w: boilerW,
      ev_w: evW,
      load_w: round(loadW, 2),
      battery_charge_w: round(batteryChargeW, 2),
      battery_discharge_w: round(batteryDischargeW, 2),
      battery_soc: round(soc, 6),
      grid_import_w: round(gridImportW, 2),
      grid_export_w: round(gridExportW, 2),
      curtailed_w: round(curtailedW, 2),
      unserved_w: round(unservedW, 2),
      import_cost_sek: importCostSek === null ? null : round(importCostSek),
      export_revenue_sek: exportRevenueSek === null
        ? null
        : round(exportRevenueSek),
    });

    loadKwh += loadW / 1_000 * SLOT_HOURS;
    flexibleKwh += flexibleW / 1_000 * SLOT_HOURS;
    pvKwh += slot.pv_w / 1_000 * SLOT_HOURS;
    importKwh += slotImportKwh;
    exportKwh += slotExportKwh;
    curtailedKwh += curtailedW / 1_000 * SLOT_HOURS;
    if (slot.binding) {
      pricedImportKwh += slotImportKwh;
      pricedExportKwh += slotExportKwh;
      importCost += importCostSek!;
      exportRevenue += exportRevenueSek!;
    }
    const suppliedW = slot.pv_w + gridImportW + batteryDischargeW;
    const consumedW = loadW - unservedW + gridExportW + batteryChargeW +
      curtailedW;
    if (Math.abs(suppliedW - consumedW) > 0.01) {
      errors.push(
        `${slot.start}: energy balance differs by ${
          round(suppliedW - consumedW, 2)
        } W`,
      );
    }
    if (
      (gridImportW > 0 && gridExportW > 0) ||
      (batteryChargeW > 0 && batteryDischargeW > 0)
    ) {
      errors.push(`${slot.start}: mutually exclusive power flows overlap`);
    }
    if (unservedW > 1) {
      errors.push(`${slot.start}: ${round(unservedW, 1)} W unserved`);
    }
    const day = localDay(slot.start, snapshot.timezone);
    if (endMarkerByDay.get(day) === slot.index) endOfSolar[day] = round(soc, 6);
  }

  const scheduledKwh = snapshot.services.reduce(
    (sum, service) =>
      sum + requiredSlotCount(service) * service.power_w / 1_000 * SLOT_HOURS,
    0,
  );
  const requestedKwh = snapshot.services.reduce(
    (sum, service) => sum + service.required_kwh,
    0,
  );
  const deliveredKwh = Object.entries(schedule.serviceSlots).reduce(
    (sum, [id, indices]) => {
      const service = snapshot.services.find((item) => item.id === id);
      return sum +
        (service ? indices.length * service.power_w / 1_000 * SLOT_HOURS : 0);
    },
    0,
  );
  if (Math.abs(scheduledKwh - deliveredKwh) > 1e-6) {
    errors.push(
      `services delivered ${round(deliveredKwh, 3)} of ${
        round(scheduledKwh, 3)
      } scheduled kWh`,
    );
  }
  if (Math.abs(flexibleKwh - deliveredKwh) > 1e-6) {
    errors.push(
      `simulated flexible load ${round(flexibleKwh, 3)} differs from ` +
        `${round(deliveredKwh, 3)} delivered kWh`,
    );
  }
  for (const service of snapshot.services) {
    const indices = schedule.serviceSlots[service.id] ?? [];
    if (indices.length > 0 && indices.length < service.min_run_slots) {
      errors.push(
        `${service.id}: run is shorter than ${service.min_run_slots} slots`,
      );
    }
    if (
      indices.some((value, index) =>
        index > 0 && value !== indices[index - 1] + 1
      )
    ) {
      errors.push(`${service.id}: service run is fragmented`);
    }
    const serviceDelivered = indices.length * service.power_w / 1_000 *
      SLOT_HOURS;
    if (serviceDelivered + 1e-6 < service.required_kwh) {
      errors.push(
        `${service.id}: delivered ${round(serviceDelivered, 3)} kWh for ` +
          `${round(service.required_kwh, 3)} kWh requirement`,
      );
    }
  }
  if (snapshot.policy.battery_target_is_hard) {
    for (const [day, endSoc] of Object.entries(endOfSolar)) {
      if (endSoc + 1e-6 < snapshot.policy.battery_end_of_solar_target_soc) {
        errors.push(
          `${day}: battery target ${
            (snapshot.policy.battery_end_of_solar_target_soc * 100).toFixed(0)
          }% ` +
            `is infeasible; forecast result ${(endSoc * 100).toFixed(1)}%`,
        );
      }
    }
  }
  if (soc + 1e-6 < snapshot.policy.terminal_soc_min) {
    errors.push(
      `terminal SOC ${(soc * 100).toFixed(1)}% is below ` +
        `${(snapshot.policy.terminal_soc_min * 100).toFixed(1)}%`,
    );
  }

  const terminalDeltaKwh = (soc - battery.soc) * battery.capacity_kwh;
  const netCost = importCost - exportRevenue;
  return {
    slots: output,
    summary: {
      load_kwh: round(loadKwh, 3),
      flexible_load_kwh: round(flexibleKwh, 3),
      pv_kwh: round(pvKwh, 3),
      grid_import_kwh: round(importKwh, 3),
      grid_export_kwh: round(exportKwh, 3),
      curtailed_kwh: round(curtailedKwh, 3),
      priced_import_kwh: round(pricedImportKwh, 3),
      priced_export_kwh: round(pricedExportKwh, 3),
      net_cost_sek: round(netCost, 3),
      terminal_adjusted_cost_sek: round(
        netCost -
          terminalDeltaKwh * snapshot.policy.terminal_energy_value_sek_per_kwh,
        3,
      ),
      battery_soc_start: battery.soc,
      battery_soc_end: round(soc, 6),
      battery_soc_low: round(socLow, 6),
      battery_end_of_solar_soc: endOfSolar,
      service_required_kwh: round(requestedKwh, 3),
      service_delivered_kwh: round(deliveredKwh, 3),
    },
    errors,
  };
}

function buildPlan(
  key: PlanKey,
  slots: PreparedSlot[],
  snapshot: OptimisationSnapshotV1,
  reservedW: number[],
  protectedSoc: (number | null)[],
): GeneratedPlan {
  const scheduled = scheduleServices(
    key,
    slots,
    snapshot,
    key === "priority" ? reservedW : new Array(slots.length).fill(0),
  );
  const simulated = simulate(
    slots,
    snapshot,
    scheduled.schedule,
    key === "priority" ? protectedSoc : new Array(slots.length).fill(null),
  );
  const validationErrors = [...scheduled.errors, ...simulated.errors];
  return {
    key,
    label: key === "baseline"
      ? "A · Baseline"
      : key === "priority"
      ? "B · Priority stack"
      : "C · Cost-led",
    status: validationErrors.length === 0 ? "ready" : "infeasible",
    validation_errors: validationErrors,
    slots: simulated.slots,
    summary: simulated.summary,
    service_slots: scheduled.schedule.serviceSlots,
  };
}

export function generateOptimisationPlan(
  snapshot: OptimisationSnapshotV1,
  now = new Date(),
): OptimisationPlanV1 {
  const validationErrors = validateSnapshot(snapshot);
  const snapshotAge = now.getTime() - isoMs(snapshot.captured_at);
  if (
    snapshotAge > MAX_SNAPSHOT_AGE_MS ||
    snapshotAge < -MAX_SOURCE_FUTURE_SKEW_MS
  ) {
    validationErrors.push("captured_at must describe a fresh snapshot");
  }
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("; "));
  }
  const slots = preparedSlots(snapshot);
  const { reservedW, protectedSoc } = batteryReservation(slots, snapshot);
  const baseline = buildPlan(
    "baseline",
    slots,
    snapshot,
    reservedW,
    protectedSoc,
  );
  const priority = buildPlan(
    "priority",
    slots,
    snapshot,
    reservedW,
    protectedSoc,
  );
  const cost = buildPlan("cost", slots, snapshot, reservedW, protectedSoc);
  const plans = { baseline, priority, cost };

  // Comparisons are only valid when every plan carries exactly the same
  // quarter-hour service workload. This catches truncated-tail and silently
  // unmet-service bugs before a plan reaches the portal.
  const flexible = Object.values(plans).map((plan) =>
    plan.summary.flexible_load_kwh
  );
  if (Math.max(...flexible) - Math.min(...flexible) > 1e-6) {
    validationErrors.push("plans do not contain equal flexible workload");
  }
  for (const service of snapshot.services) {
    const counts = Object.values(plans).map((plan) =>
      plan.service_slots[service.id]?.length ?? 0
    );
    if (new Set(counts).size !== 1) {
      validationErrors.push(
        `${service.id}: scenarios do not contain the same service workload`,
      );
    }
  }
  const bindingSlots = slots.filter((slot) => slot.binding);
  const bindingUntil = bindingSlots.length > 0
    ? new Date(
      bindingSlots[bindingSlots.length - 1].epoch_ms + SLOT_MINUTES * 60_000,
    ).toISOString()
    : slots[0].start;
  const priorityErrors = priority.validation_errors.map((error) =>
    `priority: ${error}`
  );
  const status = validationErrors.length > 0
    ? "incomplete"
    : priorityErrors.length > 0
    ? "infeasible"
    : "ready";

  return {
    schema_version: 1,
    model_version: OPTIMISATION_MODEL_VERSION,
    // One snapshot produces one deterministic plan identity, so retries cannot
    // append duplicate run-history rows.
    plan_id: snapshot.snapshot_id,
    snapshot_id: snapshot.snapshot_id,
    issued_at: now.toISOString(),
    valid_until: new Date(now.getTime() + 75 * 60_000).toISOString(),
    binding_until: bindingUntil,
    timezone: snapshot.timezone,
    slot_minutes: 15,
    status,
    validation_errors: [...validationErrors, ...priorityErrors],
    sources: snapshot.sources,
    pv_calibration: snapshot.pv_calibration,
    policy: snapshot.policy,
    battery: snapshot.battery,
    grid: snapshot.grid,
    services: snapshot.services,
    service_requirement_sample_days: snapshot.service_requirement_sample_days,
    plans,
  };
}
