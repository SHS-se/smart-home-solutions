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
      "source_quarter_expired",
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
  assertEquals(result.status, "delivered");
  assertEquals(result.control_authority, false);
  assertEquals(result.native_context, f.request.native_context);
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
  assertEquals(stale.reasons, ["superseded_plan"]);
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
