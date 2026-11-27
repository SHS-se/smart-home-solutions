import { forecastConnectedExchange, type ConnectedRoomObservation, type ConnectedRoomResponse } from "./connected-exchange.ts";
import { roomMeanObservation } from "./observation.ts";
import type { RoomStateReading } from "./state.ts";

export interface ConnectedBoundaryRoom { key: string; model: ConnectedRoomResponse }
type Span = { start_ms: number; end_ms: number };
const HOUR = 3_600_000;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const intervalKey = (span: Span) => `${span.start_ms}:${span.end_ms}`;

/** At the coldest indoor node, positive internal exchange cannot cool further.
 * Ignore unknown positive heat and integrate exterior loss/negative background.
 * Below outdoor temperature, omit the unsupported warming instead. */
function coolMinimum(value: number, outdoor: number, loss: number, background: number, hours: number): number {
  if (loss === 0 || value <= outdoor) return value + background * hours;
  const crossing = background < 0 ? Math.log1p(loss * (value - outdoor) / -background) / loss : Infinity;
  const h = Math.min(hours, crossing), effect = -Math.expm1(-loss * h) / loss;
  return outdoor + (value - outdoor) * Math.exp(-loss * h) + background * effect +
    background * Math.max(0, hours - crossing);
}

/** Missing indoor forcing is estimated from causal indoor observations, never a
 * future outdoor minimum. Native means condition endpoints through the same
 * constant-mean forcing contract as the receiving model. Asynchronous anchors
 * remain conditional model estimates, not absolute stochastic confidence bounds.
 * No estimated temperature or unknown positive heat becomes an observation. */
export function connectedRoomBoundary(
  receiver: string,
  rooms: readonly ConnectedBoundaryRoom[],
  observations: ReadonlyMap<string, RoomStateReading>,
  rows: readonly ConnectedRoomObservation[],
  currentOutdoor: number,
  receiverRates: readonly number[],
): (span: Span) => number {
  const models = new Map(rooms.map(room => [room.key, room.model]));
  const readings = new Map<string, RoomStateReading[]>(), exact = new Map<string, Map<string, RoomStateReading>>();
  const starts = new Map<string, Map<number, RoomStateReading[]>>();
  const add = (key: string, reading: RoomStateReading) => {
    if (!finite(reading.mean_c)) return;
    const list = readings.get(key) ?? [], intervals = exact.get(key) ?? new Map(), byStart = starts.get(key) ?? new Map();
    list.push(reading); intervals.set(intervalKey(reading), reading);
    const sameStart = (byStart.get(reading.start_ms) ?? []).filter(r => r.end_ms !== reading.end_ms);
    sameStart.push(reading); byStart.set(reading.start_ms, sameStart);
    readings.set(key, list); exact.set(key, intervals); starts.set(key, byStart);
  };
  for (const [key, reading] of observations) add(key, reading);
  // Qualified native means take precedence over a duplicate admission reading.
  for (const row of rows) {
    const span = { start_ms: row.start_ms, end_ms: row.start_ms + (row.duration_s ?? 900) * 1000 };
    if (finite(row.room_c)) add(receiver, { ...span, mean_c: row.room_c });
    for (const [key, mean] of Object.entries(row.peer_c ?? {})) if (finite(mean)) add(key, { ...span, mean_c: mean });
  }
  for (const [key, intervals] of exact) readings.set(key,
    [...intervals.values()].sort((a, b) => a.end_ms - b.end_ms || a.start_ms - b.start_ms));
  const latest = (key: string, at: number) => {
    const list = readings.get(key) ?? [];
    let first = 0, last = list.length;
    while (first < last) {
      const mid = (first + last) >>> 1;
      if (list[mid].end_ms <= at) first = mid + 1;
      else last = mid;
    }
    return list[first - 1];
  };
  const measuredMean = (key: string, span: Span): number | undefined => {
    const matching = exact.get(key)?.get(intervalKey(span));
    if (matching) return matching.mean_c;
    // Complete finer observations can supply an hourly mean. An hourly mean
    // cannot be sliced into asserted quarter measurements or forward-filled.
    let at = span.start_ms, integral = 0;
    while (at < span.end_ms) {
      const next = starts.get(key)?.get(at)?.filter(r => r.end_ms > at && r.end_ms <= span.end_ms)
        .reduce<RoomStateReading | undefined>((best, r) => !best || r.end_ms < best.end_ms ? r : best, undefined);
      if (!next) return undefined;
      integral += (next.end_ms - at) * next.mean_c; at = next.end_ms;
    }
    return at > span.start_ms ? integral / (at - span.start_ms) : undefined;
  };
  const component = new Set<string>(), pending = [receiver];
  while (pending.length) {
    const key = pending.pop()!;
    if (component.has(key)) continue;
    component.add(key);
    // Include passive and indirect sources; an unknown colder edge is not zero.
    const model = models.get(key);
    for (const edge of model?.incoming ?? []) if (edge.kind !== "constant" || edge.per_h > 0 ||
      model?.process_belief?.reset_priors.some(prior => prior.from === edge.from)) pending.push(edge.from);
  }
  const rates = new Map([...component].flatMap(key => {
    const model = models.get(key);
    return model ? [[key, key === receiver ? receiverRates : forecastConnectedExchange(model, model.reference_state, 0)] as const] : [];
  }));
  const loss = Math.max(0, ...[...component].map(key => models.get(key)?.thermal.outdoor_per_h ?? 0));
  const background = Math.min(0, ...[...component].map(key => models.get(key)?.thermal.background_per_h ?? 0));
  const weather = (at: number) => rows.findLast(row => row.start_ms <= at && finite(row.outdoor_c))?.outdoor_c ?? currentOutdoor;
  const indoorSeed = (span: Span): number => {
    const anchors: Array<{ at: number; temperature: number }> = [];
    for (const key of component) {
      const reading = latest(key, span.end_ms), reference = models.get(key)?.reference_state;
      if (reading) {
        // Locate a conditional indoor anchor without recursively inventing
        // upstream endpoint states. Unknown positive heat receives no credit.
        const outdoor = weather(reading.start_ms), op = roomMeanObservation(loss, 0, (reading.end_ms - reading.start_ms) / HOUR);
        const rho = op.a / op.E, forcing = loss * outdoor + background;
        anchors.push({ at: reading.end_ms, temperature: rho * reading.mean_c + (op.effect - rho * op.V) * forcing });
      } else if (reference && reference.observations > 0 && reference.through_ms <= span.end_ms) {
        anchors.push({ at: reference.through_ms, temperature: reference.temperature_c });
      } else anchors.push({ at: span.start_ms, temperature: weather(span.start_ms) });
    }
    const from = Math.min(...anchors.map(anchor => anchor.at));
    let outdoor = weather(from);
    for (const row of rows) if (row.start_ms >= from && row.start_ms < span.end_ms && finite(row.outdoor_c)) outdoor = Math.min(outdoor, row.outdoor_c);
    return Math.min(...anchors.map(anchor => coolMinimum(anchor.temperature, outdoor, loss, background,
      Math.max(0, span.end_ms - anchor.at) / HOUR)));
  };
  const endpoints = new Map<string, number>();
  const endpoint = (key: string, reading: RoomStateReading): number => {
    const tag = `${key}:${intervalKey(reading)}`;
    if (endpoints.has(tag)) return endpoints.get(tag)!;
    const model = models.get(key);
    if (!model) return reading.mean_c;
    const incoming = rates.get(key)!, outdoor = weather(reading.start_ms);
    let lower: number | undefined;
    const forcing = model.thermal.outdoor_per_h * outdoor + Math.min(0, model.thermal.background_per_h) +
      model.incoming.reduce((sum, edge, i) => sum + incoming[i] *
        (measuredMean(edge.from, reading) ?? (lower ??= indoorSeed(reading))), 0);
    const k = model.thermal.outdoor_per_h + incoming.reduce((sum, rate) => sum + rate, 0);
    // No unmeasured heater/storage/solar credit. A mean is never relabelled as
    // an endpoint, including hourly observations and strong incoming exchange.
    const op = roomMeanObservation(k, 0, (reading.end_ms - reading.start_ms) / HOUR), rho = op.a / op.E;
    const value = rho * reading.mean_c + (op.effect - rho * op.V) * forcing;
    endpoints.set(tag, value);
    return value;
  };
  const cache = new Map<string, number>();
  return span => {
    const tag = intervalKey(span);
    if (cache.has(tag)) return cache.get(tag)!;
    const anchors: Array<{ at: number; temperature: number }> = [];
    for (const key of component) {
      const reading = latest(key, span.start_ms), model = models.get(key), reference = model?.reference_state;
      if (reading) anchors.push({ at: reading.end_ms, temperature: endpoint(key, reading) });
      else if (reference && reference.observations > 0 && reference.through_ms <= span.start_ms) {
        anchors.push({ at: reference.through_ms, temperature: reference.temperature_c });
      } else anchors.push({ at: span.start_ms, temperature: weather(span.start_ms) });
    }
    const from = Math.min(...anchors.map(anchor => anchor.at));
    // Use only observed weather over elapsed history plus the current nowcast.
    // Colder weather tomorrow cannot change a reconstructed temperature today.
    let outdoor = weather(from);
    for (const row of rows) if (row.start_ms >= from && row.start_ms < span.end_ms && finite(row.outdoor_c)) outdoor = Math.min(outdoor, row.outdoor_c);
    const lastEnd = rows.length ? rows.at(-1)!.start_ms + (rows.at(-1)!.duration_s ?? 900) * 1000 : from;
    if (span.end_ms > lastEnd) outdoor = Math.min(outdoor, currentOutdoor);
    const lower = Math.min(...anchors.map(anchor => coolMinimum(anchor.temperature, outdoor, loss, background,
      Math.max(0, span.end_ms - anchor.at) / HOUR)));
    const model = models.get(receiver)!, incoming = receiverRates, exchange = incoming.reduce((sum, rate) => sum + rate, 0);
    // A same-interval peer mean is already measured forcing. For an uncovered
    // span use its cooling endpoint, so no warm last-value hold is introduced.
    const value = exchange > 0 ? model.incoming.reduce((sum, edge, i) => sum + incoming[i] *
      (measuredMean(edge.from, span) ?? lower), 0) / exchange : lower;
    cache.set(tag, value);
    return value;
  };
}
