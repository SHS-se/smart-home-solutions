import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";
import type { PublishedCommandReference, PublishedCommandSlot } from "./rules-planner.ts";
import { ExecutionReplanError, parseExecutionChanges, parseExecutionReplan, shouldAdmitPlanningSnapshot, validateExecutionAvailability, validateExecutionReplan } from "./execution-replan.ts";

const accepted = "11111111-1111-4111-8111-111111111111";
const request = () => ({ request_id: "22222222-2222-4222-8222-222222222222", accepted_plan_id: accepted,
  observed_at: "2026-10-23T12:00:00Z", changes: [{ owner: "$ev", status: "temporarily_absent", cause: "cable_disconnected",
    blocked_intervals: [{ start: "2026-10-23T12:00:00Z", end: "2026-10-23T12:15:00Z" }] }] });
function capture() {
  const snapshot = mixedModeSnapshot();
  snapshot.operating_scope.modes.$ev = "controlling";
  snapshot.operating_scope.modes.$pool = "controlling";
  return snapshot;
}
function reference(snapshot = capture()) {
  const slot: PublishedCommandSlot = { start: "2026-10-23T12:00:00Z", pool_w: 1000, pool_permitted: true,
    ev_target_current_a: 10, ev_min_current_a: 6, ev_max_current_a: 16, boiler_permitted: false, boiler_expected_w: 0 };
  return { plan_id: accepted, slots: [slot], operating_scope: structuredClone(snapshot.operating_scope) };
}

Deno.test("execution admission bypasses ordinary same-price suppression without masquerading as manual", () => {
  const ordinary = { hasAcceptedPlan: true, pendingManual: false, newPublishedPrices: false, executionReplan: null };
  assertEquals(shouldAdmitPlanningSnapshot(ordinary), false);
  assertEquals(shouldAdmitPlanningSnapshot({ ...ordinary, executionReplan: parseExecutionReplan(request()) }), true);
  assertEquals(shouldAdmitPlanningSnapshot({ ...ordinary, pendingManual: true }), true);
  assertEquals(shouldAdmitPlanningSnapshot({ ...ordinary, newPublishedPrices: true }), true);
  assertEquals(shouldAdmitPlanningSnapshot({ ...ordinary, hasAcceptedPlan: false }), true);
});

Deno.test("execution evidence requires exact accepted identity, controlling authority and positive work in the blocked opportunity", () => {
  const snapshot = capture(); const ref = reference(snapshot); const evidence = parseExecutionReplan(request());
  assertEquals(validateExecutionReplan(evidence, ref, snapshot), evidence);
  assertThrows(() => validateExecutionReplan(evidence, { ...ref, plan_id: crypto.randomUUID() }, snapshot), ExecutionReplanError, "current HA-accepted");
  assertThrows(() => validateExecutionReplan(evidence, null, snapshot), ExecutionReplanError);
  assertThrows(() => validateExecutionReplan(evidence, { ...ref, slots: ref.slots.map(s => ({ ...s, ev_target_current_a: 0 })) }, snapshot), ExecutionReplanError, "accepted work");
  const later = parseExecutionReplan(request()); later.changes[0].blocked_intervals[0].start = "2026-10-24T12:00:00Z";
  later.changes[0].blocked_intervals[0].end = "2026-10-24T12:15:00Z";
  assertThrows(() => validateExecutionReplan(later, ref, snapshot), ExecutionReplanError, "accepted work");
  snapshot.operating_scope.modes.$ev = "control_verification";
  assertThrows(() => validateExecutionReplan(evidence, ref, snapshot), ExecutionReplanError, "controlling");
  snapshot.operating_scope.modes.$ev = "controlling";
  ref.operating_scope.modes.$ev = "planning";
  assertThrows(() => validateExecutionReplan(evidence, ref, snapshot), ExecutionReplanError, "controlling");
  const arbitrary = parseExecutionReplan(request()); arbitrary.changes[0].owner = "$household";
  assertThrows(() => validateExecutionReplan(arbitrary, ref, snapshot), ExecutionReplanError, "known");
});

Deno.test("recovery can replan an objective suppressed by a previously accepted fault", () => {
  const snapshot = capture(); const original = parseExecutionReplan(request());
  const ref = { ...reference(snapshot), slots: [] as PublishedCommandReference["slots"], execution_availability: original.changes };
  const recovered = parseExecutionReplan({ ...request(), changes: [{ owner: "$ev", status: "recovered", cause: "cable_connected", blocked_intervals: [] }] });
  assertEquals(validateExecutionReplan(recovered, ref, snapshot), recovered);
  assertThrows(() => validateExecutionReplan(recovered, { ...ref, execution_availability: [] }, snapshot), ExecutionReplanError);
});

Deno.test("malformed and ambiguous execution evidence fails explicitly", () => {
  for (const raw of [null, {}, { ...request(), changes: [] }, { ...request(), request_id: "bad" },
    { ...request(), changes: [request().changes[0], request().changes[0]] },
    { ...request(), observed_at: "yesterday" }, { ...request(), extra: true },
    { ...request(), changes: [{ ...request().changes[0], blocked_intervals: [{ start: "2026-10-23T12:00:00Z", end: "2026-10-23T12:00:00Z" }] }] },
    { ...request(), changes: [{ ...request().changes[0], status: "recovered" }] }]) {
    assertThrows(() => parseExecutionReplan(raw), ExecutionReplanError);
  }
  assertEquals(parseExecutionChanges([]), []);
  const noOpportunity = parseExecutionReplan({ ...request(), changes: [{ ...request().changes[0], blocked_intervals: [] }] });
  assertThrows(() => validateExecutionReplan(noOpportunity, reference(), capture()), ExecutionReplanError, "blocked accepted opportunity");
});

Deno.test("routine execution availability preserves only known unresolved controlling equipment", () => {
  const snapshot = capture();
  snapshot.execution_availability = parseExecutionReplan(request()).changes;
  validateExecutionAvailability(snapshot);
  for (const status of ["temporarily_absent", "faulted"] as const) {
    snapshot.execution_availability = [{ owner: "$ev", status, cause: "observed_during_off_slot", blocked_intervals: [] }];
    validateExecutionAvailability(snapshot);
  }
  snapshot.operating_scope.modes.$ev = "control_verification";
  assertThrows(() => validateExecutionAvailability(snapshot), ExecutionReplanError, "controlling");
  snapshot.operating_scope.modes.$ev = "controlling";
  snapshot.execution_availability = [{ owner: "$ev", status: "recovered", cause: "reconnected", blocked_intervals: [] }];
  assertThrows(() => validateExecutionAvailability(snapshot), ExecutionReplanError, "unresolved");
  snapshot.execution_availability = [{ ...parseExecutionReplan(request()).changes[0], owner: "unknown" }];
  assertThrows(() => validateExecutionAvailability(snapshot), ExecutionReplanError, "known");
});

Deno.test('model deviations are strict scoped requests and never execution unavailability', () => {
  const snapshot = capture();
  const raw = { ...request(), changes: [{owner:'$pool',status:'plan_deviation',cause:'pool_temperature_shortfall',
    magnitude:.5,persistence_ms:1_800_000,affected_intervals:request().changes[0].blocked_intervals}] };
  const parsed = parseExecutionReplan(raw);
  const ref = reference(snapshot);
  ref.slots[0].pool_w = 0;
  assertEquals(validateExecutionReplan(parsed, ref, snapshot), parsed);
  snapshot.execution_availability = parsed.changes;
  assertThrows(() => validateExecutionAvailability(snapshot), ExecutionReplanError, 'unresolved');
  for (const change of [{...raw.changes[0],magnitude:NaN}, {...raw.changes[0],persistence_ms:-1},
    {...raw.changes[0],owner:'$ev'}, {...raw.changes[0],blocked_intervals:[]}]) {
    assertThrows(() => parseExecutionReplan({...raw,changes:[change]}), ExecutionReplanError);
  }
});
