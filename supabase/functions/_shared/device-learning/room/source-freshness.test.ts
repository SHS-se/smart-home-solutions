import { assertEquals, assertStrictEquals } from "@std/assert";
import { type ProbeEvidence, qualifyProbeFreshness } from "./source-freshness.ts";

const HOUR = 3_600_000;

const probe = (key: string, evidence: Partial<ProbeEvidence> = {}): ProbeEvidence => ({
  source_key: key, area_key: key, mean: 20, unchanged: true, joint_unchanged: null,
  cohort_key: null, reported: null, unavailable: null, ...evidence,
});

function interval(index: number, probes: ProbeEvidence[], house: number | null = null, duration: 900 | 3600 = 3600) {
  return {
    start_ts: new Date(index * duration * 1000).toISOString(),
    duration_s: duration, temperature_source_key: "room", probe_evidence: probes,
    room_temperature_c: 20 as number | null, house_temperature_c: house, heat_w: 250 + index,
  };
}

// Synthetic source that normally changes on every observation. Exercise a
// long joint freeze while its heater continues reporting real watts.
function jointFreeze(reportsEveryOtherHour = false) {
  return Array.from({ length: 840 }, (_, i) => {
    const quiet = i >= 100 && i < 260;
    return interval(i, [probe("room", {
      unchanged: quiet, joint_unchanged: quiet,
      reported: reportsEveryOtherHour && quiet && i % 2 === 0 ? true : null,
    })]);
  });
}

Deno.test("a verified report splits inference and a quiet joint signal alone cannot establish its normal cadence", () => {
  const observed = jointFreeze(true);
  const alwaysQuiet = Array.from({ length: 840 }, (_, i) => interval(i, [probe("room", { joint_unchanged: true })]));
  for (const rows of [observed, alwaysQuiet]) {
    const result = qualifyProbeFreshness(rows);
    assertEquals(result.report.room, { inferred: 0, unavailable: 0, unverified: 0 });
    assertEquals(result.rows, rows);
  }
});

Deno.test("corroborated reporting freeze qualifies the temperature only and is independent of read paging or order", () => {
  const observed = jointFreeze();
  const result = qualifyProbeFreshness(observed);
  assertEquals(result.report.room, { inferred: 160, unavailable: 0, unverified: 0 });
  assertEquals(result.rows.map(row => row.heat_w), observed.map(row => row.heat_w));
  assertEquals(result.rows.map(row => row.room_temperature_c), observed.map((_, i) => i >= 100 && i < 260 ? null : 20));
  assertEquals(observed[100].room_temperature_c, 20);
  assertStrictEquals(result.rows[99], observed[99]);
  const reversedPages = [observed.slice(501), observed.slice(171, 501), observed.slice(0, 171)].flat().reverse();
  const rerun = qualifyProbeFreshness(reversedPages);
  assertEquals(rerun.report, result.report);
  const byTime = new Map(result.rows.map(row => [row.start_ts, row]));
  for (const [i, row] of rerun.rows.entries()) {
    assertEquals(row.start_ts, reversedPages[i].start_ts);
    assertEquals(row, byTime.get(row.start_ts));
  }
  // Later corroborating reports reverse the inference on the next read.
  const corrected = qualifyProbeFreshness(jointFreeze(true));
  assertEquals(corrected.report.room.inferred, 0);
  assertEquals(corrected.rows[145].room_temperature_c, 20);
});

Deno.test("missing companions and genuinely stable quantization remain usable", () => {
  const stable = Array.from({ length: 24 * 182 }, (_, i) => {
    const hour = i % 24, day = Math.floor(i / 24);
    const previousHour = (i + 23) % 24;
    const quiet = hour < 9 && previousHour < 9;
    const unchanged = quiet || hour % 3 !== 0;
    const joint = quiet || unchanged && (hour + day) % 5 !== 0;
    return interval(i, [probe("room", { unchanged, joint_unchanged: i < 800 ? null : joint })]);
  });
  const result = qualifyProbeFreshness(stable);
  assertEquals(result.report.room.inferred, 0);
  assertEquals(result.rows, stable);
});

Deno.test("out-of-sync probe facts cannot qualify a corrected raw room mean", () => {
  const observed = jointFreeze();
  observed[150].room_temperature_c = 20.25;
  const result = qualifyProbeFreshness(observed);
  assertEquals(result.rows[150].room_temperature_c, 20.25);
  assertEquals(result.rows[151].room_temperature_c, null);
  assertEquals(result.report.room, { inferred: 159, unavailable: 0, unverified: 1 });
});

Deno.test("native gaps and resolution changes do not create a long contiguous freeze", () => {
  const base = jointFreeze();
  const gapped = base.filter((_, i) => i < 100 || i >= 260 || i % 2 === 0);
  const distinctResolution = Array.from({ length: 640 }, (_, i) =>
    interval(i + 400, [probe("room", { joint_unchanged: true })], null, 900));
  const result = qualifyProbeFreshness([...gapped, ...distinctResolution]);
  assertEquals(result.report.room.inferred, 0);
  assertEquals(result.rows, [...gapped, ...distinctResolution]);
});

Deno.test("only complete verified bridge evidence with activity on another bridge can qualify a shared freeze", () => {
  function bridgeEvidence(unrelated: boolean, reported: boolean) {
    return Array.from({ length: 840 }, (_, i) => {
      const quiet = i >= 100 && i < 108;
      return interval(i, [
        probe("room", { cohort_key: "bridge", joint_unchanged: quiet || i % 2 === 0 }),
        probe("peer", { cohort_key: "bridge", joint_unchanged: quiet || i % 2 === 1,
          reported: reported && quiet && i % 2 === 0 ? true : null }),
        probe("outside-bridge", { joint_unchanged: false, cohort_key: unrelated ? "other-bridge" : null }),
      ], 20);
    });
  }
  const result = qualifyProbeFreshness(bridgeEvidence(true, false));
  assertEquals(result.report.room.inferred, 8);
  assertEquals(result.rows[100].room_temperature_c, null);
  assertEquals(qualifyProbeFreshness(bridgeEvidence(false, false)).report.room.inferred, 0);
  assertEquals(qualifyProbeFreshness(bridgeEvidence(true, true)).report.room.inferred, 0);
});

Deno.test("explicit unavailability updates the house median by physical area and keeps the measured heat", () => {
  const original = interval(0, [
    probe("room", { mean: 40, area_key: "shared", unavailable: true, reported: true }),
    probe("another", { mean: 12, area_key: "shared" }),
    probe("east", { mean: 18 }), probe("west", { mean: 22 }), probe("north", { mean: 26 }),
  ], 24);
  const { rows: [result], report } = qualifyProbeFreshness([original]);
  assertEquals(result.room_temperature_c, null);
  assertEquals(result.house_temperature_c, 20);
  assertEquals(result.heat_w, original.heat_w);
  assertStrictEquals(result.probe_evidence, original.probe_evidence);
  assertEquals(report, { room: { inferred: 0, unavailable: 1, unverified: 0 },
    house: { inferred: 0, unavailable: 1, unverified: 0 } });
});

Deno.test("leave house unknown when qualified coverage or the original household boundary is missing", () => {
  const thirdArea = interval(0, [
    probe("room", { unavailable: true, mean: 20 }), probe("east", { mean: 22 }), probe("west", { mean: 24 }),
  ], 22);
  const unverified = { ...thirdArea, start_ts: new Date(HOUR).toISOString(), house_temperature_c: 25 };
  const noHouse = { ...thirdArea, start_ts: new Date(2 * HOUR).toISOString(), house_temperature_c: null };
  const { rows, report } = qualifyProbeFreshness([thirdArea, unverified, noHouse]);
  assertEquals(rows.map(row => row.house_temperature_c), [null, null, null]);
  assertEquals(report.house, { unavailable: 2, inferred: 0, unverified: 1 });
});

Deno.test("only the fitted room's exact temperature source is masked", () => {
  const raw = interval(0, [probe("historical-source", { unavailable: true })]);
  const { rows: [actual], report } = qualifyProbeFreshness([raw]);
  assertStrictEquals(actual, raw);
  assertEquals(report.room.unavailable, 0);
  const legacy = { ...raw, temperature_source_key: null };
  assertStrictEquals(qualifyProbeFreshness([legacy]).rows[0], legacy);
});

Deno.test("named peers use their own physical freshness and independently qualified chronological prefixes", () => {
  // Independent synthetic frozen peer, with the receiver still reporting.
  const raw = jointFreeze().map(row => ({ ...row, temperature_source_key: "receiver",
    probe_evidence: [...row.probe_evidence.map(p => ({ ...p, area_key: "peer" })),
      probe("receiver", { mean: 19, joint_unchanged: false })] }));
  const full = qualifyProbeFreshness(raw, ["peer", "missing"]);
  assertEquals(full.rows[150].peer_temperatures_c, { peer: null, missing: null });
  assertEquals(full.rows[10].peer_temperatures_c, { peer: 20, missing: null });
  assertEquals(full.rows[150].heat_w, raw[150].heat_w);
  assertEquals(qualifyProbeFreshness(raw.slice(100, 260), ["peer"]).rows[50].peer_temperatures_c, { peer: 20 });
  assertEquals(raw[150].probe_evidence[0].mean, 20);
  const repaired = raw.map(row => ({ ...row, probe_evidence: row.probe_evidence.map(p => ({ ...p, reported: true })) }));
  assertEquals(qualifyProbeFreshness(repaired, ["peer"]).rows[150].peer_temperatures_c, { peer: 20 });
  assertEquals(qualifyProbeFreshness([{ ...raw[0], probe_evidence: null }], ["peer"]).rows[0].peer_temperatures_c, { peer: null });
});
