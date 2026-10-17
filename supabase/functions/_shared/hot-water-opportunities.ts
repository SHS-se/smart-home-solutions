import type { DutyCycleServiceInput } from "./planner/planning-contracts.ts";
import { localDay } from "./planner-wasm/calendar.ts";
import { projectBoilerDay } from "./boiler-consumption.ts";

export const WATER_MINUTES_PER_DAY = 150;
export interface WaterCommitment { start: string; boiler_permitted: boolean; boiler_expected_w: number }
export interface WaterOpportunities {
  permitted: boolean[];
  expected_w: number[];
  rated_w: number[];
  permission_starts: string[];
  shortfall_minutes: Record<string, number>;
}

/** Select a continuous measured-power run, then additional opportunities for
 * the daily permission quota. Electricity and permission remain separate. */
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
    if ((control.rated_power_w !== null && (!Number.isFinite(control.rated_power_w) || control.rated_power_w <= 0)) ||
      control.expected_power_w_by_slot.length !== starts.length || control.expected_power_w_by_slot.some(w => !Number.isFinite(w) || w < 0)) {
      throw new Error("Hot water requires its electrical running power and complete consumption forecast");
    }
  }
  const active = starts.map(start => services.filter(s => Date.parse(start) + 900_000 > Date.parse(s.earliest_start) && Date.parse(start) < Date.parse(s.deadline)));
  const rated = active.map(ss => ss.reduce((sum, s) => sum + (s.control.rated_power_w ?? 0), 0));
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
    const remainingMinutes = Math.max(0, WATER_MINUTES_PER_DAY - elapsed - fixed);
    // Services normally cover one local day. A service spanning multiple days
    // apportions its energy by its historical shape, not a fixed daily amount.
    const requiredWh = services.reduce((sum, service) => {
      const eligible = starts.map((_start, i) => active[i].includes(service));
      const weights = eligible.map((yes, i) => yes ? service.control.expected_power_w_by_slot[i] * hours[i] : 0);
      const total = weights.reduce((a, b) => a + b, 0);
      const denominator = total || hours.reduce((s, h, i) => s + (eligible[i] ? h : 0), 0);
      const numerator = indices.reduce((s, i) => s + (total ? weights[i] : eligible[i] ? hours[i] : 0), 0);
      return sum + (denominator > 0 ? service.required_kwh * 1000 * numerator / denominator : 0);
    }, 0);
    const fixedWh = indices.reduce((sum, i) => sum + expected[i] * hours[i], 0);
    const neededWh = Math.max(0, requiredWh - fixedWh);
    let prefix = 0;
    while (prefix < indices.length && locked[indices[prefix]]) prefix++;
    const continuing = prefix > 0 && prefix < indices.length && neededWh > 1e-6
      && locked[indices[prefix - 1]].boiler_expected_w >= 500;
    const price = (i: number) => input.solar_w[i] - input.other_house_w[i] >= rated[i] ? input.export_price[i] : input.import_price[i];
    // Busy hours and overlapping large loads are preferences, not prohibitions.
    // Prices choose among quiet quarters; other household watts break ties.
    const medianLoad = indices.map(i => input.other_house_w[i]).sort((a, b) => a - b)[Math.floor(indices.length / 2)];
    const eligible = (i: number) => !locked[i] && rated[i] <= input.available_w[i] + 1e-6;
    const rank = (a: number, b: number) => Number(input.large_load_w[a] > 0) - Number(input.large_load_w[b] > 0) ||
      Number(peak[a]) - Number(peak[b]) || Number(input.other_house_w[a] > medianLoad) - Number(input.other_house_w[b] > medianLoad) ||
      price(a) - price(b) || input.other_house_w[a] - input.other_house_w[b] || a - b;
    const candidates: { indices: number[]; score: number[] }[] = [];
    for (let from = 0; from < indices.length && (remainingMinutes > 1e-6 || neededWh > 1e-6); from++) {
      if (continuing && from !== prefix) continue;
      const block: number[] = [];
      let minutes = 0, capacity = 0;
      for (let j = from; j < indices.length; j++) {
        const i = indices[j];
        if (!eligible(i) || block.length && i !== block.at(-1)! + 1) break;
        block.push(i); minutes += hours[i] * 60; capacity += rated[i] * hours[i];
        if (capacity + 1e-6 >= neededWh) break;
      }
      if (!block.length) continue;
      // Do not start a run that would have to finish through a known physical
      // obstruction. A horizon boundary may truncate a forecast explicitly.
      if (capacity + 1e-6 < neededWh && block.at(-1) !== indices.at(-1)) continue;
      const power = Math.max(...block.map(i => rated[i]));
      // Once the forecast run is complete, extra permission need not be
      // contiguous. It must not start earlier and move the run through a
      // headroom obstruction that the selected start deliberately avoided.
      const runEnd = block.at(-1)!;
      for (const i of indices.filter(i => i > runEnd && eligible(i)).sort(rank)) {
        if (minutes + 1e-6 >= remainingMinutes) break;
        block.push(i); minutes += hours[i] * 60;
      }
      candidates.push({ indices: block, score: [
        Math.max(0, remainingMinutes - minutes) + (power > 0 ? Math.max(0, neededWh - capacity) / power * 60 : 0),
        block.reduce((s, i) => s + Number(input.large_load_w[i] > 0) * hours[i], 0),
        block.reduce((s, i) => s + Number(peak[i]) * hours[i], 0),
        block.reduce((s, i) => s + Number(input.other_house_w[i] > medianLoad) * hours[i], 0),
        block.reduce((s, i) => s + price(i) * hours[i], 0) / (minutes / 60),
        block.reduce((s, i) => s + input.other_house_w[i] * hours[i], 0) / (minutes / 60), block[0],
      ] });
    }
    candidates.sort((a, b) => {
      for (let i = 0; i < a.score.length; i++) if (Math.abs(a.score[i] - b.score[i]) > 1e-6) return a.score[i] - b.score[i];
      return 0;
    });
    for (const i of candidates[0]?.indices ?? []) permitted[i] = true;
    const run = projectBoilerDay({ required_wh: requiredWh,
      running_w: indices.map(i => rated[i]), hours: indices.map(i => hours[i]),
      permitted: indices.map(i => permitted[i]), committed_w: indices.map(i => locked[i]?.boiler_expected_w) });
    if (indices.some((i, j) => !locked[i] && run.expected_w[j] > input.available_w[i] + 1e-6)) {
      throw new Error(`Committed boiler completion exceeds electrical headroom on ${day}`);
    }
    indices.forEach((i, j) => { expected[i] = run.expected_w[j]; });
    const permissionMinutes = indices.reduce((sum, i) => sum + (permitted[i] ? hours[i] * 60 : 0), 0);
    const power = Math.max(...indices.map(i => rated[i]));
    shortfall[day] = Math.max(0, WATER_MINUTES_PER_DAY - elapsed - permissionMinutes,
      power > 0 ? run.unserved_wh / power * 60 : 0);
  }
  return { permitted, expected_w: expected, rated_w: rated, shortfall_minutes: shortfall,
    permission_starts: [...new Set([...previous, ...starts.filter((_s, i) => permitted[i])])].sort() };
}
