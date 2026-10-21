import type { DutyCycleServiceInput } from "./planner/planning-contracts.ts";
import { localDay } from "./planner-wasm/calendar.ts";
import { FINISH_HEATING_W, projectBoilerTank } from "./boiler-consumption.ts";

export const WATER_MINUTES_PER_DAY = 150;
/** The longest the boiler may go without a permitted quarter, measured from
 * the end of one to the start of the next (user requirement, 21 October 2026). */
export const WATER_MAX_GAP_MINUTES = 720;
const QUARTER_MS = 900_000;
export interface WaterCommitment { start: string; boiler_permitted: boolean; boiler_expected_w: number }
export interface WaterOpportunities {
  permitted: boolean[];
  expected_w: number[];
  rated_w: number[];
  permission_starts: string[];
  shortfall_minutes: Record<string, number>;
}

/** Select one heating run a day against the tank's heat deficit, then
 * additional opportunities for the daily permission quota. Electricity and
 * permission remain separate. */
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
  const horizonStart = Date.parse(starts[0]), gapMs = WATER_MAX_GAP_MINUTES * 60_000;
  const past = [...new Set(input.previous_permissions)].filter(start => Date.parse(start) + QUARTER_MS <= horizonStart);
  const previous = past.filter(start => localDay(start, input.timezone) >= localDay(starts[0], input.timezone));
  // The gap rule reaches back across midnight, so the ledger also keeps the
  // last 12 hours and the latest permission, however old.
  const latest = past.reduce<string | null>((a, b) => a === null || Date.parse(b) > Date.parse(a) ? b : a, null);
  const recent = past.filter(start => start === latest || Date.parse(start) + QUARTER_MS + gapMs >= horizonStart);
  const dayOf = starts.map(() => "");
  for (const [day, indices] of days) for (const i of indices) dayOf[i] = day;
  const medianLoad = new Map([...days].map(([day, indices]) =>
    [day, indices.map(i => input.other_house_w[i]).sort((a, b) => a - b)[Math.floor(indices.length / 2)]]));
  const price = (i: number) => input.solar_w[i] - input.other_house_w[i] >= rated[i] ? input.export_price[i] : input.import_price[i];
  // Busy hours and overlapping large loads are preferences, not prohibitions.
  // Prices choose among quiet quarters; other household watts break ties.
  const eligible = (i: number) => active[i].length > 0 && !locked[i] && rated[i] <= input.available_w[i] + 1e-6;
  const busy = (i: number) => Number(input.other_house_w[i] > medianLoad.get(dayOf[i])!);
  const rank = (a: number, b: number) => Number(input.large_load_w[a] > 0) - Number(input.large_load_w[b] > 0) ||
    Number(peak[a]) - Number(peak[b]) || busy(a) - busy(b) ||
    price(a) - price(b) || input.other_house_w[a] - input.other_house_w[b] || a - b;
  const at = (i: number) => Date.parse(starts[i]);
  const dayAt = (ms: number) => localDay(new Date(ms).toISOString(), input.timezone);
  // Water use per quarter, as a free thermostat would draw to replace it. A
  // day the horizon covers in full is scaled to its daily requirement; a
  // partial day keeps the forecast's shape, and the current day's
  // requirement beyond the rest of its forecast is heat already owed.
  const raw = starts.map((_s, i) => active[i].reduce((sum, s) => sum + s.control.expected_power_w_by_slot[i], 0));
  const draw = [...raw];
  let owedAtStart = 0;
  const daily: { day: string; indices: number[]; elapsed: number }[] = [];
  for (const [day, indices] of days) {
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
    const profileWh = indices.reduce((sum, i) => sum + raw[i] * hours[i], 0);
    const first = indices[0], last = indices.at(-1)!;
    const full = dayAt(at(first) - 1) !== day && hours[first] >= .25 - 1e-9 && dayAt(at(last) + QUARTER_MS) !== day;
    if (full) {
      const dayHours = indices.reduce((sum, i) => sum + hours[i], 0);
      for (const i of indices) draw[i] = profileWh > 0 ? raw[i] * requiredWh / profileWh : requiredWh / dayHours;
    } else if (first === 0) owedAtStart = Math.max(0, requiredWh - profileWh);
    daily.push({ day, indices, elapsed: previous.filter(start => localDay(start, input.timezone) === day).length * 15 });
  }
  const committed = starts.map((_s, i) => locked[i]?.boiler_expected_w);
  const project = () => projectBoilerTank({ draw_w: draw, initial_deficit_wh: owedAtStart, running_w: rated, hours,
    permitted, committed_w: committed });
  const withinHeadroom = (run: ReturnType<typeof project>) =>
    !run.expected_w.some((w, i) => !locked[i] && w > input.available_w[i] + 1e-6);
  const fits = () => withinHeadroom(project());
  // Heat the tank still owes at a day's end is bought later; it is valued at
  // the horizon's median import price so an early run is not free.
  const reference = [...input.import_price].sort((a, b) => a - b)[Math.floor(input.import_price.length / 2)];
  for (const { indices, elapsed } of daily) {
    const fixed = indices.reduce((sum, i) => sum + (locked[i]?.boiler_permitted ? hours[i] * 60 : 0), 0);
    const remainingMinutes = Math.max(0, WATER_MINUTES_PER_DAY - elapsed - fixed);
    let prefix = 0;
    while (prefix < indices.length && locked[indices[prefix]]) prefix++;
    const continuing = prefix > 0 && prefix < indices.length && locked[indices[prefix - 1]].boiler_expected_w >= FINISH_HEATING_W
      && project().deficit_wh[indices[prefix - 1]] > 1e-6;
    // Each candidate is one run, permitted for as long as the tank keeps it
    // heating, then the quota's other quarters after it. A run that would
    // finish through a headroom obstruction is not started.
    const evaluate = (block: number[]) => {
      for (const i of block) permitted[i] = true;
      const run = project();
      for (const i of block) permitted[i] = false;
      if (!withinHeadroom(run)) return null;
      const heated = indices.filter(i => run.expected_w[i] > 0);
      const minutes = block.reduce((sum, i) => sum + hours[i] * 60, 0);
      const heatHours = (flag: (i: number) => number) => heated.reduce((sum, i) => sum + flag(i) * hours[i], 0);
      return { indices: block, score: [
        Math.max(0, remainingMinutes - minutes),
        heatHours(i => Number(input.large_load_w[i] > 0)), heatHours(i => Number(peak[i])), heatHours(busy),
        heated.reduce((sum, i) => sum + run.expected_w[i] * hours[i] * price(i), 0) / 1000 + run.deficit_wh[indices.at(-1)!] * reference / 1000,
        block.length ? block.reduce((s, i) => s + input.other_house_w[i] * hours[i], 0) / (minutes / 60) : 0, block[0] ?? -1,
      ] };
    };
    const candidates = [evaluate([])].filter(c => c !== null && !continuing);
    for (let from = 0; from < indices.length; from++) {
      if (continuing && from !== prefix) continue;
      const start = indices[from];
      if (!eligible(start)) continue;
      permitted[start] = true;
      const run = project();
      permitted[start] = false;
      const block = [start];
      while (block.at(-1)! + 1 < starts.length && eligible(block.at(-1)! + 1) && run.expected_w[block.at(-1)! + 1] >= FINISH_HEATING_W
        && dayOf[block.at(-1)! + 1] === dayOf[start]) block.push(block.at(-1)! + 1);
      let minutes = block.reduce((sum, i) => sum + hours[i] * 60, 0);
      // Extra permission after the run need not be contiguous. It must not
      // start earlier and move the run through an obstruction it avoided.
      const runEnd = block.at(-1)!;
      for (const i of indices.filter(i => i > runEnd && eligible(i)).sort(rank)) {
        if (minutes + 1e-6 >= remainingMinutes) break;
        block.push(i); minutes += hours[i] * 60;
      }
      const candidate = evaluate(block);
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((a, b) => {
      for (let i = 0; i < a!.score.length; i++) if (Math.abs(a!.score[i] - b!.score[i]) > 1e-6) return a!.score[i] - b!.score[i];
      return 0;
    });
    for (const i of candidates[0]?.indices ?? []) permitted[i] = true;
  }
  // No more than the maximum gap without a permitted quarter. A longer gap
  // gets the fewest extra quarters that close it, each the best-ranked one
  // in the span that still leaves the rest closable and whose run fits the
  // headroom. Failing that, the latest inside the gap, then the earliest after.
  // The horizon's end closes the last gap; the next replan continues it.
  const horizonEnd = at(starts.length - 1) + QUARTER_MS;
  // An overdue gap is closed at the first eligible quarter. Without any
  // record the gap is counted from the start of the horizon.
  let lastEnd = latest === null ? horizonStart : Date.parse(latest) + QUARTER_MS;
  for (;;) {
    const next = permitted.findIndex((p, i) => p && at(i) >= lastEnd);
    const nextStart = next >= 0 ? at(next) : horizonEnd;
    if (nextStart - lastEnd <= gapMs) {
      if (next < 0) break;
      lastEnd = at(next) + QUARTER_MS;
      continue;
    }
    const needed = Math.ceil((nextStart - lastEnd - gapMs) / (gapMs + QUARTER_MS));
    const from = Math.max(lastEnd, nextStart - needed * (gapMs + QUARTER_MS)), until = lastEnd + gapMs;
    const open = starts.flatMap((_s, i) => at(i) >= lastEnd && at(i) < nextStart && eligible(i) ? [i] : []);
    const span = open.filter(i => at(i) >= from && at(i) <= until).sort(rank);
    const inside = open.filter(i => at(i) < from && at(i) <= until).reverse();
    const pick = [...span, ...inside, ...open.filter(i => at(i) > until)].find(i => {
      permitted[i] = true;
      if (fits()) return true;
      permitted[i] = false;
      return false;
    });
    if (pick === undefined) break;
    lastEnd = at(pick) + QUARTER_MS;
  }
  const run = project();
  if (!withinHeadroom(run)) throw new Error("Committed boiler completion exceeds electrical headroom");
  run.expected_w.forEach((w, i) => { expected[i] = w; });
  // A day falls short by missing permission minutes, and by heat it still
  // owes at its end beyond the water used after its last heating.
  const shortfall: Record<string, number> = {};
  for (const { day, indices, elapsed } of daily) {
    const permissionMinutes = indices.reduce((sum, i) => sum + (permitted[i] ? hours[i] * 60 : 0), 0);
    const power = Math.max(...indices.map(i => rated[i]));
    const lastHeat = indices.findLast(i => run.expected_w[i] > 0 || permitted[i]);
    const after = indices.filter(i => lastHeat === undefined || i > lastHeat).reduce((sum, i) => sum + draw[i] * hours[i], 0);
    const unmetWh = Math.max(0, run.deficit_wh[indices.at(-1)!] - after);
    shortfall[day] = Math.max(0, WATER_MINUTES_PER_DAY - elapsed - permissionMinutes, power > 0 ? unmetWh / power * 60 : 0);
  }
  return { permitted, expected_w: expected, rated_w: rated, shortfall_minutes: shortfall,
    permission_starts: [...new Set([...previous, ...recent, ...starts.filter((_s, i) => permitted[i])])].sort() };
}
