import type { DutyCycleServiceInput } from "./planner/energy-optimisation.ts";
import { localDay } from "./planner-wasm/calendar.ts";

export const WATER_MINUTES_PER_DAY = 150;
export interface WaterCommitment { start: string; boiler_permitted: boolean; boiler_expected_w: number }
export interface WaterOpportunities {
  permitted: boolean[];
  expected_w: number[];
  rated_w: number[];
  permission_starts: string[];
  shortfall_minutes: Record<string, number>;
}

/** Permission is the product. Forecast energy is distributed over those
 * opportunities, never queued as though we knew the tank's thermal state. */
export function scheduleHotWater(input: {
  services: DutyCycleServiceInput[];
  starts: string[];
  hours: number[];
  timezone: string;
  other_house_w: number[];
  import_price: number[];
  export_price: number[];
  solar_w: number[];
  large_load_w: number[];
  available_w: number[];
  locked: WaterCommitment[];
  previous_permissions: string[];
}): WaterOpportunities {
  const { starts, hours, services, locked } = input;
  for (const { control } of services) {
    if (!Number.isFinite(control.rated_power_w) || control.rated_power_w <= 0 ||
      control.expected_power_w_by_slot.length !== starts.length || control.expected_power_w_by_slot.some(w => !Number.isFinite(w) || w < 0)) {
      throw new Error("Hot water requires its electrical running power and complete consumption forecast");
    }
  }
  const active = starts.map(start => services.filter(s => Date.parse(start) + 900_000 > Date.parse(s.earliest_start) && Date.parse(start) < Date.parse(s.deadline)));
  const rated = active.map(ss => ss.reduce((sum, s) => sum + s.control.rated_power_w, 0));
  const permitted = starts.map((_s, i) => locked[i]?.boiler_permitted ?? false);
  const expected = starts.map((_s, i) => locked[i]?.boiler_expected_w ?? 0);
  const days = new Map<string, number[]>();
  starts.forEach((start, i) => {
    if (!active[i].length) return;
    const day = localDay(start, input.timezone);
    days.set(day, [...days.get(day) ?? [], i]);
  });
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: input.timezone, hour: "numeric", hourCycle: "h23" });
  const peak = starts.map(start => { const h = Number(formatter.format(new Date(start))); return h >= 6 && h < 9 || h >= 18 && h < 21; });
  const previous = [...new Set(input.previous_permissions)].filter(start => Date.parse(start) + 900_000 <= Date.parse(starts[0]) && localDay(start, input.timezone) >= localDay(starts[0], input.timezone));
  const shortfall: Record<string, number> = {};
  for (const [day, indices] of days) {
    const elapsed = previous.filter(start => localDay(start, input.timezone) === day).length * 15;
    const fixed = indices.reduce((sum, i) => sum + (locked[i]?.boiler_permitted ? hours[i] * 60 : 0), 0);
    let remaining = Math.max(0, WATER_MINUTES_PER_DAY - elapsed - fixed);
    const price = (i: number) => input.solar_w[i] - input.other_house_w[i] >= rated[i] ? input.export_price[i] : input.import_price[i];
    // Busy hours and overlapping large loads are preferences, not prohibitions.
    // Prices choose among quiet quarters; other household watts break ties.
    const medianLoad = indices.map(i => input.other_house_w[i]).sort((a, b) => a - b)[Math.floor(indices.length / 2)];
    const candidates = indices.filter(i => i >= locked.length && rated[i] <= input.available_w[i] + 1e-6)
      .sort((a, b) => Number(input.large_load_w[a] > 0) - Number(input.large_load_w[b] > 0) ||
        Number(peak[a]) - Number(peak[b]) || Number(input.other_house_w[a] > medianLoad) - Number(input.other_house_w[b] > medianLoad) || price(a) - price(b) || input.other_house_w[a] - input.other_house_w[b] || a - b);
    for (const i of candidates) {
      if (remaining <= 1e-6) break;
      permitted[i] = true;
      remaining -= hours[i] * 60;
    }
    shortfall[day] = Math.max(0, remaining);
    const forecastWh = indices.reduce((sum, i) => sum + active[i].reduce((w, s) => w + s.control.expected_power_w_by_slot[i], 0) * hours[i], 0);
    const fixedWh = indices.reduce((sum, i) => sum + expected[i] * hours[i], 0);
    const capacityWh = indices.reduce((sum, i) => sum + (i >= locked.length && permitted[i] ? rated[i] * hours[i] : 0), 0);
    const fraction = capacityWh > 0 ? Math.min(1, Math.max(0, forecastWh - fixedWh) / capacityWh) : 0;
    for (const i of indices) if (i >= locked.length && permitted[i]) expected[i] = rated[i] * fraction;
  }
  return { permitted, expected_w: expected, rated_w: rated, shortfall_minutes: shortfall,
    permission_starts: [...new Set([...previous, ...starts.filter((_s, i) => permitted[i])])].sort() };
}
