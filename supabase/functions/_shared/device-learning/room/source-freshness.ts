/** Neutral facts supplied by the exact room-air sources at one native interval. */
export interface ProbeEvidence {
  source_key: string;
  area_key: string;
  mean: number | null;
  unchanged: boolean | null;
  joint_unchanged: boolean | null;
  cohort_key: string | null;
  reported: boolean | null;
  unavailable: boolean | null;
}

interface Observation {
  start_ts: string;
  duration_s?: 900 | 3600;
  temperature_source_key?: string | null;
  probe_evidence?: ProbeEvidence[] | null;
  room_temperature_c: number | null;
  house_temperature_c: number | null;
  heat_w: number | null;
}

export interface ProbeFreshnessReport {
  room: { inferred: number; unavailable: number; unverified: number };
  house: { inferred: number; unavailable: number; unverified: number };
}

interface Interval {
  at: number;
  probes: ProbeEvidence[];
}

interface ProbeSeries {
  signals: Uint8Array;
  cohorts: Uint32Array;
  inferred: Uint8Array;
}

const STILL = 1;
const CHANGED = 2;
const REPORTED = 4;
const STATE = 3;
const HOUR_MS = 3_600_000;
// The app's house_temperature_quarters requires three distinct areas.
const MIN_HOUSE_AREAS = 3;
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

function median(values: number[]) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function houseMedian(probes: ProbeEvidence[], keep: (probe: ProbeEvidence) => boolean) {
  const areas = new Map<string, number[]>();
  for (const probe of probes) {
    if (!finite(probe.mean) || !keep(probe)) continue;
    const readings = areas.get(probe.area_key);
    if (readings) readings.push(probe.mean);
    else areas.set(probe.area_key, [probe.mean]);
  }
  if (areas.size < MIN_HOUSE_AREAS) return null;
  const value = median([...areas.values()].map(median));
  const lower = Math.floor(value * 10_000);
  // Python rounds exact ties to even. At this precision a binary halfway
  // value must be a multiple of 1/32.
  return Number.isInteger(value * 32) && value * 10_000 - lower === 0.5
    ? (lower + Math.abs(lower % 2)) / 10_000
    : Number(value.toFixed(4));
}

function ordinaryCounts(signals: Uint8Array, classes: Uint8Array) {
  const counts = new Uint32Array(48);
  for (let i = 0; i < signals.length; i++) {
    const bit = signals[i] & STATE;
    if (bit) counts[classes[i] * 2 + bit - 1]++;
  }
  return counts;
}

/** Jeffreys posterior predictive code for consecutive unchanged observations. */
function unchangedBits(still: number, changed: number, length: number) {
  let nats = 0;
  for (let i = 0; i < length; i++) nats += Math.log1p((changed + 0.5) / (still + 0.5 + i));
  return nats / Math.LN2;
}

function liveBits(
  signals: Uint8Array,
  classes: Uint8Array,
  counts: Uint32Array,
  tested: Uint32Array,
  outside: Uint32Array,
  first: number,
  end: number,
  joins: Uint8Array,
) {
  outside.set(counts);
  tested.fill(0);
  for (let i = first; i < end; i++) {
    const category = classes[i] * 2;
    outside[category]--;
    tested[category]++;
  }
  // Neither the run nor its bounding observations can calibrate the run.
  for (const boundary of [joins[first] ? first - 1 : -1, joins[end] ? end : -1]) {
    if (boundary < 0) continue;
    const bit = signals[boundary] & STATE;
    if (bit) outside[classes[boundary] * 2 + bit - 1]--;
  }
  let still = 0, changed = 0, unrepresented = 0, score = 0;
  for (let i = 0; i < outside.length; i += 2) {
    const zeros = outside[i], ones = outside[i + 1], length = tested[i];
    still += zeros;
    changed += ones;
    if (zeros + ones) score += unchangedBits(zeros, ones, length);
    else unrepresented += length;
  }
  if (!changed) return 0;
  // Pool an otherwise unrepresented age or clock class under the source's
  // known ordinary cadence, integrating uncertainty once over that suffix.
  return score + unchangedBits(still, changed, unrepresented);
}

function qualifyRuns(
  signals: Uint8Array,
  joins: Uint8Array,
  clock: Uint8Array,
  sourceCount: number,
  record: (first: number, end: number) => void,
  corroborated?: (first: number, end: number) => boolean,
) {
  const ages = new Uint8Array(signals.length);
  let run = 0, observed = 0, changed = 0;
  for (let i = 0; i < signals.length; i++) {
    if (!joins[i]) run = 0;
    ages[i] = 32 - Math.clz32(run);
    const bit = signals[i] & STATE;
    run = bit === STILL ? run + 1 : 0;
    observed += Number(bit !== 0);
    changed += Number(bit === CHANGED);
  }
  if (!changed) return;
  const ageCounts = ordinaryCounts(signals, ages), clockCounts = ordinaryCounts(signals, clock);
  const tested = new Uint32Array(48), outside = new Uint32Array(48);
  const selectionBits = Math.ceil(Math.log2(sourceCount)) + Math.ceil(Math.log2(observed));
  const maxBitsPerInterval = Math.log2(2 * (observed + 1));
  let first = -1;
  for (let end = 0; end <= signals.length; end++) {
    const unchanged = signals[end] === STILL;
    if (first >= 0 && (!unchanged || !joins[end])) {
      const length = end - first;
      // A prefix code identifies the physical source, a start opportunity and
      // an Elias gamma-coded length. The mathematical bound avoids evaluating
      // candidates that cannot save any bits under either ordinary model.
      const freezeBits = selectionBits + 2 * (31 - Math.clz32(length)) + 1;
      if (length * maxBitsPerInterval > freezeBits &&
        (!corroborated || corroborated(first, end)) &&
        liveBits(signals, ages, ageCounts, tested, outside, first, end, joins) > freezeBits &&
        liveBits(signals, clock, clockCounts, tested, outside, first, end, joins) > freezeBits) {
        record(first, end);
      }
      first = -1;
    }
    if (unchanged && first < 0) first = end;
  }
}

function inferFrozen(intervals: Interval[], durationMs: number) {
  const n = intervals.length;
  const series = new Map<string, ProbeSeries>();
  const groups = new Map<string, { id: number; members: Set<ProbeSeries> }>();
  const joins = new Uint8Array(n), clock = new Uint8Array(n);
  const activeCohort = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const { at, probes } = intervals[i];
    joins[i] = Number(i > 0 && intervals[i - 1].at + durationMs === at);
    clock[i] = (Math.floor(at / HOUR_MS) % 24 + 24) % 24;
    for (const probe of probes) {
      let source = series.get(probe.source_key);
      if (!source) {
        source = { signals: new Uint8Array(n), cohorts: new Uint32Array(n), inferred: new Uint8Array(n) };
        series.set(probe.source_key, source);
      }
      const reported = probe.reported === true && probe.unavailable !== true;
      const bit = !finite(probe.mean) || probe.unavailable === true || probe.joint_unchanged === null
        ? 0
        : probe.joint_unchanged === false ? CHANGED : probe.unchanged === true ? STILL : 0;
      source.signals[i] = bit | (reported ? REPORTED : 0);
      if (probe.cohort_key === null) continue;
      let cohort = groups.get(probe.cohort_key);
      if (!cohort) {
        cohort = { id: groups.size + 1, members: new Set() };
        groups.set(probe.cohort_key, cohort);
      }
      cohort.members.add(source);
      source.cohorts[i] = cohort.id;
      if (reported || bit === CHANGED) {
        activeCohort[i] = activeCohort[i] === 0 || activeCohort[i] === cohort.id ? cohort.id : -1;
      }
    }
  }
  const cohorts = [...groups.values()].filter(group => group.members.size > 1);
  const sourceCount = series.size + cohorts.length;
  for (const { signals, inferred } of series.values()) {
    qualifyRuns(signals, joins, clock, sourceCount, (first, end) => inferred.fill(1, first, end));
  }
  for (const { id, members } of cohorts) {
    const joint = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let allKnown = true, bit = STILL;
      for (const member of members) {
        const signal = member.cohorts[i] === id ? member.signals[i] : 0;
        allKnown &&= Boolean(signal & STATE);
        if (signal & CHANGED) bit = CHANGED;
        if (signal & REPORTED) {
          allKnown = false;
          break;
        }
      }
      if (allKnown) joint[i] = bit;
    }
    qualifyRuns(joint, joins, clock, sourceCount,
      (first, end) => {
        for (const member of members) member.inferred.fill(1, first, end);
      },
      (first, end) => {
        for (let i = first; i < end; i++) if (activeCohort[i] !== 0 && activeCohort[i] !== id) return true;
        return false;
      });
  }
  return series;
}

/** Qualify only temperatures used for learning. No raw evidence is mutated. */
export function qualifyProbeFreshness<T extends Observation>(rows: readonly T[]): { rows: T[]; report: ProbeFreshnessReport } {
  const report: ProbeFreshnessReport = {
    room: { inferred: 0, unavailable: 0, unverified: 0 },
    house: { inferred: 0, unavailable: 0, unverified: 0 },
  };
  const byDuration = new Map<number, Array<Interval & { index: number; row: T }>>();
  const qualified = [...rows];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row.probe_evidence?.length) continue;
    const at = Date.parse(row.start_ts);
    if (!Number.isFinite(at)) continue;
    const duration = (row.duration_s ?? 900) * 1000;
    const bucket = byDuration.get(duration);
    const interval = { at, probes: row.probe_evidence, index, row };
    if (bucket) bucket.push(interval);
    else byDuration.set(duration, [interval]);
  }
  for (const [duration, intervals] of byDuration) {
    intervals.sort((a, b) => a.at - b.at);
    const series = inferFrozen(intervals, duration);
    for (let i = 0; i < intervals.length; i++) {
      const { probes, index, row } = intervals[i];
      const reason = (probe: ProbeEvidence) => probe.unavailable === true
        ? "unavailable"
        : series.get(probe.source_key)?.inferred[i] ? "inferred" : null;
      let roomReason: ReturnType<typeof reason> = null;
      let houseInferred = false, houseUnavailable = false;
      for (const probe of probes) {
        const issue = reason(probe);
        if (probe.source_key === row.temperature_source_key) {
          // A partial upload can briefly pair the old probe facts with a
          // corrected raw mean. An inference only qualifies the observed mean
          // supporting it. An explicit unavailable event applies to the source.
          if (issue === "inferred" && row.room_temperature_c !== null && probe.mean !== row.room_temperature_c) {
            report.room.unverified++;
          } else roomReason = issue;
        }
        if (finite(probe.mean)) {
          houseInferred ||= issue === "inferred";
          houseUnavailable ||= issue === "unavailable";
        }
      }
      let house = row.house_temperature_c;
      if (house !== null && (houseInferred || houseUnavailable)) {
        report.house.inferred += Number(houseInferred);
        report.house.unavailable += Number(houseUnavailable);
        if (houseMedian(probes, () => true) === house) {
          house = houseMedian(probes, probe => reason(probe) === null);
        } else {
          report.house.unverified++;
          house = null;
        }
      }
      if (roomReason && row.room_temperature_c !== null) report.room[roomReason]++;
      const room = roomReason ? null : row.room_temperature_c;
      if (room !== row.room_temperature_c || house !== row.house_temperature_c) {
        qualified[index] = { ...row, room_temperature_c: room, house_temperature_c: house };
      }
    }
  }
  return { rows: qualified, report };
}
