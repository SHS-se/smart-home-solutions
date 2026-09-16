import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  policyDeliveryFixture,
  policyExchangeFixture,
} from "../../../scripts/generate-battery-policy-delivery-fixture.ts";
import {
  type BatteryExchangePorts,
  buildBatteryPolicyRequest,
  handleBatteryPolicyExchange,
} from "./battery-policy-exchange.ts";
import { compileBatteryExecutionPolicy } from "./battery-execution-policy.ts";
import { generateOptimisationPlanWithBatteryProjection } from "./energy-optimisation.ts";
import { energyPlanningStep } from "./energy-planning-step.ts";
import type { EnergyPlanningContinuation } from "./energy-planning-protocol.ts";
import { mixedModeSnapshot } from "../../../scripts/generate-ha-plan-fixture.ts";

Deno.test("Verification conditions only the battery and survives every serialized planning stage", () => {
  const s = mixedModeSnapshot();
  s.operating_scope.modes.$battery = "control_verification";
  const direct = generateOptimisationPlanWithBatteryProjection(
    s,
    new Date(s.captured_at),
  );
  const p = direct.battery_projection;
  assert(p.status === "ready");
  assertEquals(p.provenance.branch, "battery_verification");
  assertEquals(direct.plan.execution_plan!.battery, null);
  assertEquals(
    p.problem.plant.residual_loads[0].power_w,
    direct.plan.execution_plan!.plans.priority.slots.map((s) => s.load_w),
  );
  let continuation: EnergyPlanningContinuation | undefined;
  for (let n = 0; n < 64; n++) {
    const step = energyPlanningStep({
      snapshot: s,
      now: s.captured_at,
      price_archive: [],
    }, continuation);
    if (step.done === true) {
      assertEquals({
        plan: step.plan,
        battery_projection: step.battery_projection,
      }, direct);
      return;
    }
    continuation = JSON.parse(JSON.stringify(step.continuation));
  }
  throw new Error("staged verification did not complete");
});

Deno.test("native permissions narrow matching quarters without leaking current restrictions into the future", () => {
  const f = policyExchangeFixture();
  f.request.native_context.future_permissions[0].grid_charge_allowed = false;
  const built = buildBatteryPolicyRequest(f.stored, f.request, f.now);
  assert(built.status === "ready");
  const b = built.request.problem.plant.equipment[0];
  assert(b.kind === "battery");
  assertEquals(built.request.permissions.grid_charge_allowed, false);
  assertEquals(b.grid_charge_allowed.slice(0, 2), [false, true]);
  const result = compileBatteryExecutionPolicy(built.request);
  assert(result.status === "compiled", JSON.stringify(result));
  assertEquals(result.policy.permissions.grid_charge_allowed, false);
  assertEquals(result.policy.actuals_origin_ms, f.now);
  assertEquals(built.energy_origin_kwh, .05 * 18.08);
});

Deno.test("supply accounting restores Verification components and shares PV proportionally", () => {
  const f = policyExchangeFixture();
  const p = f.stored.battery_projection;
  assert(p?.status === "ready");
  const mutable = structuredClone(f.stored);
  assert(mutable.battery_projection?.status === "ready");
  mutable.battery_projection.problem.plant.pv_w[0] = 1000;
  for (
    const [scope, expected] of [
      [{ kind: "whole_house" }, 1800],
      [{ kind: "none" }, 0],
      [{ kind: "selected", include_base: true, planned_device_keys: [] }, 450],
      [{
        kind: "selected",
        include_base: false,
        planned_device_keys: ["pool_heater"],
      }, 900],
      [{
        kind: "selected",
        include_base: true,
        planned_device_keys: ["pool_pump"],
      }, 900],
    ] as const
  ) {
    const input = {
      ...f.request,
      native_context: { ...f.request.native_context, supply_scope: scope },
    };
    const built = buildBatteryPolicyRequest(mutable, input, f.now);
    assert(built.status === "ready", JSON.stringify(built));
    assertAlmostEquals(built.request.future_supply_bound_w[0], expected, 1e-8);
  }
});

Deno.test("source and native admission reject stale, missing, unknown or unacknowledged evidence", () => {
  const f = policyExchangeFixture();
  const cases: [unknown, typeof f.stored, number, string][] = [
    [
      { ...f.request, native_context: null },
      f.stored,
      f.now,
      "native_context_required",
    ],
    [{ ...f.request, problem: {} }, f.stored, f.now, "invalid_request"],
    [
      { ...f.request, plan_id: "00000000-0000-4000-8000-000000000001" },
      f.stored,
      f.now,
      "superseded_plan",
    ],
    [
      f.request,
      { ...f.stored, ha_ack_status: "pending" },
      f.now,
      "plan_not_acknowledged",
    ],
    [
      f.request,
      { ...f.stored, fixed_plan_revision: 1 },
      f.now,
      "fixed_plan_authority",
    ],
    [
      f.request,
      f.stored,
      f.request.native_context.valid_until_ms,
      "native_context_expired_or_different_cut",
    ],
    [
      {
        ...f.request,
        native_context: {
          ...f.request.native_context,
          source_cut_ms: f.now + 1,
        },
      },
      f.stored,
      f.now,
      "native_context_expired_or_different_cut",
    ],
    [
      {
        ...f.request,
        native_context: { ...f.request.native_context, future_permissions: [] },
      },
      f.stored,
      f.now,
      "invalid_request",
    ],
    [
      {
        ...f.request,
        native_context: {
          ...f.request.native_context,
          energy_basis: "absolute_kwh",
        },
      },
      f.stored,
      f.now,
      "invalid_request",
    ],
    [
      {
        ...f.request,
        native_context: {
          ...f.request.native_context,
          supply_scope: {
            kind: "selected",
            include_base: false,
            planned_device_keys: ["unknown"],
          },
        },
      },
      f.stored,
      f.now,
      "unknown_planned_supply_member",
    ],
  ];
  for (const [request, stored, now, reason] of cases) {
    const built = buildBatteryPolicyRequest(stored, request, now);
    assert(built.status === "blocked");
    assert(built.reasons.includes(reason), JSON.stringify(built));
  }
});

Deno.test("delivery is home-authenticated, bounded, and never grants physical authority", async () => {
  const f = policyExchangeFixture();
  const homes: string[] = [];
  let authorized = true, subscribed = true, calls = 0, current = f.stored;
  const ports: BatteryExchangePorts = {
    authenticate: async () =>
      authorized ? { homeId: "home-1", subscriptionActive: subscribed } : null,
    load: async (home) => {
      homes.push(home);
      return current;
    },
    now: () => f.now,
    compile: async (request) => {
      calls++;
      return compileBatteryExecutionPolicy(request);
    },
  };
  const request = (body: unknown = f.request) =>
    new Request("https://test/policy", {
      method: "POST",
      headers: {
        "X-SHS-API-Version": "1",
        "X-Request-ID": "transport-request",
      },
      body: JSON.stringify(body),
    });
  authorized = false;
  assertEquals(
    (await handleBatteryPolicyExchange(request(), ports)).status,
    401,
  );
  assertEquals(homes, []);
  authorized = true;
  subscribed = false;
  assertEquals(
    (await handleBatteryPolicyExchange(request(), ports)).status,
    402,
  );
  assertEquals(homes, []);
  subscribed = true;
  const result = await (await handleBatteryPolicyExchange(request(), ports))
    .json();
  assertEquals(result.api_version, 1);
  assertEquals(result.ok, true);
  assertEquals(result.request_id, "transport-request");
  assertEquals(result.data.request_id, f.request.request_id);
  assertEquals(result.data.status, "delivered");
  assertEquals(result.data.control_authority, false);
  assertEquals(result.data.native_context, f.request.native_context);
  assertEquals(calls, 1);
  assertEquals(homes, ["home-1", "home-1"]);
  assertEquals(
    (await handleBatteryPolicyExchange(
      request({ ...f.request, home_id: "other" }),
      ports,
    )).status,
    400,
  );
  ports.compile = async (req) => {
    current = { ...current, ha_ack_status: "rejected" };
    return compileBatteryExecutionPolicy(req);
  };
  const stale = await (await handleBatteryPolicyExchange(request(), ports))
    .json();
  assertEquals(stale.data.reasons, ["superseded_plan"]);
});

Deno.test("provider delivery fixture is the real compiler output and explicitly synthetic", async () => {
  const fixture = policyDeliveryFixture();
  assertEquals(fixture.synthetic, true);
  assertEquals(
    fixture,
    JSON.parse(
      await Deno.readTextFile(
        "contracts/ha-api/fixtures/battery-policy-delivery.json",
      ),
    ),
  );
});

Deno.test("zero-base partitions tolerate arithmetic noise but reject real excess", () => {
  const f = structuredClone(policyExchangeFixture());
  const p = f.stored.battery_projection;
  assert(p?.status === "ready");
  p.provenance.final_demand[0].house_w = 0.3;
  const external = p.provenance.operating_scope!.external_demands;
  for (
    const [key, watts] of [["pool_heater", 0.1], ["pool_pump", 0.2]] as const
  ) {
    external[key].recent_observation = {
      ...external[key].recent_observation!,
      average_w: watts,
    };
  }
  const request = {
    ...f.request,
    native_context: {
      ...f.request.native_context,
      supply_scope: {
        kind: "selected",
        include_base: true,
        planned_device_keys: [],
      },
    },
  };
  const built = buildBatteryPolicyRequest(f.stored, request, f.now);
  assert(built.status === "ready", JSON.stringify(built));
  assertEquals(built.request.future_supply_bound_w[0], 0);
  const all = buildBatteryPolicyRequest(f.stored, {
    ...request,
    native_context: {
      ...request.native_context,
      supply_scope: {
        kind: "selected",
        include_base: false,
        planned_device_keys: ["pool_heater", "pool_pump"],
      },
    },
  }, f.now);
  assert(all.status === "ready", JSON.stringify(all));
  assert(all.request.future_supply_bound_w[0] <= 0.3);
  external.pool_heater.recent_observation!.average_w = 0.101;
  assertEquals(buildBatteryPolicyRequest(f.stored, request, f.now), {
    status: "blocked",
    reasons: ["partition_exceeds_house"],
  });
});

Deno.test("production DC delivery binds conversion and planner scope", () => {
  const f = policyExchangeFixture();
  const conversion = {
    revision: "measured-installation",
    grid_charge: { gain: .95, overhead_w: 95 },
    surplus_charge: { gain: .95, overhead_w: 0 },
    discharge: { gain: .987, overhead_w: 161 },
    idle_loss_w: 0,
  };
  const request = {
    ...f.request,
    native_context: {
      ...f.request.native_context,
      response_model_revision: "pv-first-dc-v2",
      conversion,
    },
  };
  const built = buildBatteryPolicyRequest(f.stored, request, f.now);
  assert(built.status === "ready", JSON.stringify(built));
  const compiled = compileBatteryExecutionPolicy(built.request);
  assert(compiled.status === "compiled", JSON.stringify(compiled));
  assertEquals(compiled.policy.plant.conversion, conversion);
  const changed = buildBatteryPolicyRequest(f.stored, {
    ...request,
    native_context: {
      ...request.native_context,
      catalog_revision: "new-mode-epoch",
    },
  }, f.now);
  assert(changed.status === "ready");
  assert(
    changed.request.identity.scope_revision !==
      built.request.identity.scope_revision,
  );
  const widened = buildBatteryPolicyRequest(f.stored, {
    ...request,
    native_context: {
      ...request.native_context,
      supply_scope: { kind: "none" },
    },
  }, f.now);
  assert(widened.status === "blocked");
  assertEquals(widened.reasons, ["planner_supply_scope_mismatch"]);
});

Deno.test("battery policy errors use the SHS envelope before a body can be read", async () => {
  const f = policyExchangeFixture();
  const ports: BatteryExchangePorts = {
    authenticate: async () => ({ homeId: "home", subscriptionActive: true }),
    load: async () => null,
    compile: async (request) => compileBatteryExecutionPolicy(request),
    now: () => f.now,
  };
  const request = (body: string, method = "POST") =>
    new Request("https://test/policy", {
      method,
      headers: {
        "X-SHS-API-Version": "1",
        "X-Request-ID": "transport-request",
      },
      ...(method === "POST" ? { body } : {}),
    });
  for (
    const [body, method, status, code] of [
      ["", "GET", 405, "method_not_allowed"],
      ["{", "POST", 400, "invalid_body"],
      ["{}", "POST", 400, "invalid_body"],
      ["x".repeat(128001), "POST", 413, "request_too_large"],
    ] as const
  ) {
    const response = await handleBatteryPolicyExchange(
      request(body, method),
      ports,
    );
    const wire = await response.json();
    assertEquals(response.status, status);
    assertEquals(wire.api_version, 1);
    assertEquals(wire.ok, false);
    assertEquals(wire.request_id, "transport-request");
    assertEquals(response.headers.get("X-Request-ID"), "transport-request");
    assertEquals(wire.error_info.code, code);
  }
  const response = await handleBatteryPolicyExchange(
    request(JSON.stringify(f.request)),
    ports,
  );
  const wire = await response.json();
  assertEquals(wire.ok, true);
  assertEquals(wire.data.status, "blocked");
  assertEquals(wire.data.reasons, ["projection_unavailable"]);
});

function requestForInterval(
  f: ReturnType<typeof policyExchangeFixture>,
  offset: number,
) {
  const p = f.stored.battery_projection;
  assert(p?.status === "ready");
  return {
    ...structuredClone(f.request),
    native_context: {
      ...structuredClone(f.request.native_context),
      source_cut_ms: Date.parse(p.problem.intervals[offset].start),
      valid_until_ms: Date.parse(p.problem.intervals[offset].end),
      future_permissions: structuredClone(
        f.request.native_context.future_permissions.slice(offset),
      ),
    },
  };
}

Deno.test("one accepted plan supplies policies for partial, later and final captured quarters", () => {
  const f = policyExchangeFixture();
  const source = f.stored.battery_projection;
  assert(source?.status === "ready");
  const before = structuredClone(f.stored);
  for (const offset of [0, 1, 4, source.problem.intervals.length - 1]) {
    const input = requestForInterval(f, offset);
    const now = input.native_context.source_cut_ms + 30000;
    const built = buildBatteryPolicyRequest(f.stored, input, now);
    assert(built.status === "ready", JSON.stringify(built));
    const p = built.request.problem;
    assertEquals(p.intervals, source.problem.intervals.slice(offset));
    assertEquals(
      p.identity.intent_revision,
      source.problem.identity.intent_revision,
    );
    assertEquals(p.identity.actuals_watermark, p.intervals[0].start);
    assertEquals(p.plant.pv_w, source.problem.plant.pv_w.slice(offset));
    assertEquals(
      p.plant.residual_loads[0].power_w,
      source.problem.plant.residual_loads[0].power_w.slice(offset),
    );
    assertEquals(
      p.economics.import_sek_per_kwh,
      source.problem.economics.import_sek_per_kwh.slice(offset),
    );
    assertEquals(
      p.economics.export_sek_per_kwh,
      source.problem.economics.export_sek_per_kwh.slice(offset),
    );
    assertEquals(p.economics.terminal, source.problem.economics.terminal);
    const compiled = compileBatteryExecutionPolicy(built.request);
    assert(compiled.status === "compiled", JSON.stringify(compiled));
    assertEquals(
      compiled.policy.actuals_origin_ms,
      input.native_context.source_cut_ms,
    );
    assertEquals(
      compiled.policy.validity.until_ms,
      input.native_context.valid_until_ms,
    );
    assertEquals(
      compiled.policy.economics.import_sek_per_kwh,
      p.economics.import_sek_per_kwh[0],
    );
    assertEquals(
      compiled.policy.identity.intent_revision,
      f.request.snapshot_id,
    );
  }
  assertEquals(
    f.stored,
    before,
    "quarter selection must not alter the stored generation",
  );
});

Deno.test("later quarter uses its own permissions and external demand, never the initial observation", () => {
  const f = structuredClone(policyExchangeFixture());
  const p = f.stored.battery_projection;
  assert(p?.status === "ready");
  const input = requestForInterval(f, 1);
  input.native_context.future_permissions[0].grid_charge_allowed = false;
  input.native_context.supply_scope = { kind: "whole_house" };
  // Deliberately different first-quarter observations expose an index-zero reset.
  p.provenance.operating_scope!.external_demands.pool_heater.recent_observation!
    .average_w = 100000;
  const built = buildBatteryPolicyRequest(
    f.stored,
    input,
    input.native_context.source_cut_ms,
  );
  assert(built.status === "ready", JSON.stringify(built));
  const b = built.request.problem.plant.equipment[0];
  assert(b.kind === "battery");
  assertEquals(b.grid_charge_allowed.slice(0, 2), [false, true]);
  assertEquals(built.request.permissions.grid_charge_allowed, false);
  assertEquals(
    built.request.future_supply_bound_w[0],
    Math.max(0, p.provenance.final_demand[1].house_w - p.problem.plant.pv_w[1]),
  );
  input.native_context.future_permissions[0].start =
    p.problem.intervals[0].start;
  assertEquals(
    buildBatteryPolicyRequest(
      f.stored,
      input,
      input.native_context.source_cut_ms,
    ),
    { status: "blocked", reasons: ["future_permissions_mismatch"] },
  );
});

Deno.test("current-quarter policies cannot extend expired or advisory-only plan coverage", () => {
  const f = policyExchangeFixture();
  const input = requestForInterval(f, 1);
  const now = input.native_context.source_cut_ms;
  for (const key of ["binding_until", "valid_until"] as const) {
    const stored = structuredClone(f.stored);
    stored.plan[key] = new Date(now).toISOString();
    assertEquals(buildBatteryPolicyRequest(stored, input, now), {
      status: "blocked",
      reasons: ["plan_window_unavailable"],
    });
    stored.plan[key] = new Date(now + 30000).toISOString();
    const built = buildBatteryPolicyRequest(stored, input, now);
    assert(built.status === "ready");
    assertEquals(built.request.validity.until_ms, now + 30000);
  }
  assertEquals(
    buildBatteryPolicyRequest(
      f.stored,
      input,
      Date.parse(f.stored.plan.valid_until),
    ),
    { status: "blocked", reasons: ["plan_window_unavailable"] },
  );
});

Deno.test("a policy reply crossing its quarter boundary is discarded and the next quarter recovers", async () => {
  const f = policyExchangeFixture();
  let now = f.now;
  const ports: BatteryExchangePorts = {
    authenticate: async () => ({ homeId: "home", subscriptionActive: true }),
    load: async () => f.stored,
    now: () => now,
    compile: async (request) => {
      const result = compileBatteryExecutionPolicy(request);
      now = request.validity.until_ms;
      return result;
    },
  };
  const send = (body: unknown) =>
    handleBatteryPolicyExchange(
      new Request("https://test/policy", {
        method: "POST",
        headers: { "X-SHS-API-Version": "1" },
        body: JSON.stringify(body),
      }),
      ports,
    );
  const expired = await (await send(f.request)).json();
  assertEquals(expired.data.reasons, ["source_quarter_expired"]);
  ports.compile = async (request) => compileBatteryExecutionPolicy(request);
  const next = await (await send(requestForInterval(f, 1))).json();
  assertEquals(next.data.status, "delivered");
  assertEquals(next.data.policy.actuals_origin_ms, now);
  assertEquals(next.data.plan_id, f.stored.plan_id);
});
