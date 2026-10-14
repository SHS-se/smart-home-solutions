import type { DutyCycleServiceInput, PlannedSlot, ForecastSlotInput } from "./energy-optimisation.ts";
import { hotWaterPermission, type HotWaterDemandPolicy } from "./device-models.ts";

// The gate is the water heater's own behaviour, so the bench's referee steps it too.
export { hotWaterPermission, type HotWaterDemandPolicy };
type Commitment = Pick<PlannedSlot, "boiler_permitted" | "boiler_expected_w">;

/** The load level that could absorb the window's expected water energy in its
 * lowest-demand quarters. A flat load profile stays permitted; colder houses
 * move the level upwards. Forecasts above running power remain valid forecasts.
 */
function fillingLevel(loads: number[], hours: number[], rated: number, energyWh: number): number {
  let low = Math.min(...loads);
  let high = Math.max(...loads) + Math.max(rated, energyWh / hours.reduce((a, b) => a + b, 0));
  for (let n = 0; n < 60; n++) {
    const level = (low + high) / 2;
    const absorbed = loads.reduce((sum, load, i) => sum + Math.min(rated, Math.max(0, level - load)) * hours[i], 0);
    if (absorbed < energyWh) low = level;
    else high = level;
  }
  return high;
}

/** One window's water as the heater delivers it: its forecast draw where it is
 * permitted, held-off energy queued and caught up later at most at rated power.
 * Committed quarters deliver exactly their committed share.
 */
function serveWindow(service: DutyCycleServiceInput, indices: number[], hours: number[],
  permitted: (i: number) => boolean, committed: (i: number) => number | undefined): { expected_w: Map<number, number>; pending_wh: number } {
  const expected = new Map<number, number>();
  let pendingWh = 0;
  for (const i of indices) {
    const forecast = service.control.expected_power_w_by_slot[i];
    const fixed = committed(i);
    if (fixed !== undefined) {
      pendingWh = Math.max(0, pendingWh + (forecast - fixed) * hours[i]);
    } else if (!permitted(i)) {
      pendingWh += forecast * hours[i];
    } else {
      const catchup = Math.min(Math.max(0, service.control.rated_power_w - forecast), pendingWh / hours[i]);
      expected.set(i, forecast + catchup);
      pendingWh -= catchup * hours[i];
    }
  }
  return { expected_w: expected, pending_wh: pendingWh };
}

/** The valley level, raised where the heater could not catch up on what it
 * holds off before its window closes. The filling estimate assumes every
 * quarter under the level absorbs rated power; the heater can only make up
 * its own forecast's headroom, after the quarters it was held in. Delivery
 * only grows as the level rises, so the lowest serving load level is exact.
 */
function servingLevel(service: DutyCycleServiceInput, indices: number[], available: number[], site: number[], hours: number[],
  committed: (i: number) => number | undefined, eligible: readonly boolean[], energyWh: number): number {
  const filling = fillingLevel(available.map(i => site[i]), available.map(i => hours[i]), service.control.rated_power_w, energyWh);
  const serves = (level: number) => serveWindow(service, indices, hours, i => eligible[i] && site[i] <= level, committed).pending_wh <= 1e-6;
  if (serves(filling)) return filling;
  const levels = [...new Set(available.map(i => site[i]))].filter(w => w > filling).sort((a, b) => a - b);
  return levels.find(serves) ?? Math.max(filling, ...levels);
}

/** Prepare permission and its empirical load forecast together from selected
 * household loads and economic eligibility. Recovery is forecast after inhibition, within the
 * original service window; it is not measured usable water or a heat guarantee.
 */
export function planHotWaterDemand(input: {
  services: DutyCycleServiceInput[];
  slots: Pick<ForecastSlotInput, "start">[];
  hours: number[];
  other_house_w: number[];
  locked: Commitment[];
  /** Economic authority is separate from the live measured-load gate. */
  eligible?: readonly boolean[];
  battery_offset_w?: readonly number[];
  /** Native admission starts with causal work, before narrowing load valleys. */
  level_mode?: "all_loads";
  site_policies?: readonly (HotWaterDemandPolicy | null)[];
  /** A candidate prefix is certified against its projected battery flow. */
  permission_prefix?: readonly boolean[];
}): { policies: (HotWaterDemandPolicy | null)[]; permitted: boolean[]; expected_w: number[]; deferred_kwh: number; deferred_kwh_by_service: Record<string, number>; site_policies: (HotWaterDemandPolicy | null)[]; rated_w: number[]; eligible: boolean[] } {
  const { services, slots, hours, other_house_w: other, locked } = input;
  const eligible = input.eligible ?? slots.map(() => true);
  const offset = input.battery_offset_w ?? slots.map(() => 0);
  const site = other.map((w, i) => w + offset[i]);
  for (let i = 0; i < locked.length; i++) {
    if (!Number.isFinite(locked[i].boiler_expected_w)) {
      throw new Error(`Committed hot-water power missing or non-finite at ${slots[i].start}`);
    }
  }
  for (const { control } of services) {
    if (!Number.isFinite(control.rated_power_w) || control.rated_power_w <= 0 ||
      control.expected_power_w_by_slot.length !== slots.length || control.expected_power_w_by_slot.some(w => !Number.isFinite(w) || w < 0)) throw new Error("Hot water requires its rated draw and complete consumption forecast");
  }
  const inWindow = services.map(service => slots.flatMap((slot, i) => Date.parse(slot.start) + 900_000 > Date.parse(service.earliest_start) && Date.parse(slot.start) < Date.parse(service.deadline) ? [i] : []));
  const active = slots.map((_slot, i) => services.flatMap((service, s) => inWindow[s].includes(i) ? [service] : []));
  // A committed quarter's measured-in power is shared between the windows open in it.
  const committedShare = (service: DutyCycleServiceInput) => (i: number): number | undefined => {
    if (!locked[i]) return undefined;
    const forecast = service.control.expected_power_w_by_slot[i];
    const total = active[i].reduce((sum, s) => sum + s.control.expected_power_w_by_slot[i], 0);
    const rated = active[i].reduce((sum, s) => sum + s.control.rated_power_w, 0);
    return locked[i].boiler_expected_w * (total > 0 ? forecast / total : service.control.rated_power_w / rated);
  };
  const windows = services.map((service, s) => {
    const indices = inWindow[s];
    const energy = indices.reduce((sum, i) => sum + service.control.expected_power_w_by_slot[i] * hours[i], 0);
    const available = indices.filter(i => eligible[i]);
    return { service, indices, level: available.length ? input.level_mode === "all_loads" ? Math.max(...available.map(i => site[i]))
      : servingLevel(service, indices, available, site, hours, committedShare(service), eligible, energy) : 0 };
  });
  const sitePolicies = input.site_policies ? [...input.site_policies] : slots.map((_slot, i) => {
    const open = windows.filter(w => w.indices.includes(i));
    return open.length ? {
      allow_below_w: Math.max(...open.map(w => w.level)),
      inhibit_above_w: Math.max(...open.map(w => w.level)) + open.reduce((sum, w) => sum + w.service.control.rated_power_w, 0),
    } : null;
  });
  // HA measures gross appliances. Translate the chosen battery contribution
  // out of the site-load policy, preserving its rated-draw hysteresis width.
  // A negative gross admission level has no attainable measured-house value.
  // Publish an explicit inhibit instead of moving that band upwards to zero.
  const admitted = sitePolicies.map((policy, i) => !policy || eligible[i] && policy.allow_below_w - offset[i] >= 0);
  const policies = sitePolicies.map((policy, i) => policy && policy.allow_below_w - offset[i] >= 0 ? {
    allow_below_w: policy.allow_below_w - offset[i],
    inhibit_above_w: policy.inhibit_above_w - offset[i],
  } : null);
  const permitted: boolean[] = [];
  let previous = true;
  for (let i = 0; i < slots.length; i++) {
    const policy = policies[i];
    const rated = active[i].reduce((sum, service) => sum + service.control.rated_power_w, 0);
    const permit = locked[i]?.boiler_permitted ?? input.permission_prefix?.[i] ?? (!admitted[i] ? false : policy ? hotWaterPermission(policy, other[i] + (previous ? rated : 0), previous) : true);
    permitted.push(permit);
    previous = permit;
  }
  const expected = slots.map(() => 0);
  let deferred = 0;
  const deferredByService: Record<string, number> = {};
  for (const { service, indices } of windows) {
    const served = serveWindow(service, indices, hours, i => permitted[i], committedShare(service));
    for (const [i, w] of served.expected_w) expected[i] += w;
    deferred += served.pending_wh / 1000;
    deferredByService[service.id] = served.pending_wh / 1000;
  }
  for (let i = 0; i < locked.length; i++) expected[i] = locked[i].boiler_expected_w;
  return { policies, permitted, expected_w: expected, deferred_kwh: deferred, deferred_kwh_by_service: deferredByService, site_policies: sitePolicies, eligible: admitted, rated_w: active.map(open => open.reduce((sum, service) => sum + service.control.rated_power_w, 0)) };
}
