/** Execute the pinned real HA producer → candidate planner → real HA executor.
 * All scenario data originates in ha_bridge.py's independent synthetic ports.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  generateRulesPlan,
  prepareRulesPlanningInput,
} from "../supabase/functions/_shared/rules-planner.ts";
import { resolveRulePolicy } from "../supabase/functions/_shared/planner-wasm/rule-policy.ts";
import {
  electricalOpening,
  roomExecution,
} from "../tests/planner-contracts/integration-oracles.ts";
import { fitRoom } from "../supabase/functions/_shared/device-learning/room/fit.ts";
import { roomObservations } from "../tests/planner-contracts/synthetic.ts";
import type { OptimisationSnapshot } from "../supabase/functions/_shared/planner/planning-contracts.ts";

const root = new URL("../", import.meta.url);
const decoder = new TextDecoder();

async function command(program: string, args: string[], input?: unknown) {
  const child = new Deno.Command(program, {
    args,
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let inputError: unknown;
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(JSON.stringify(input)));
      await writer.close();
    } catch (error) {
      inputError = error;
    } finally {
      writer.releaseLock();
    }
  }
  const result = await child.output();
  if (!result.success) {
    throw new Error(
      `${program} ${args.join(" ")} failed:\n${decoder.decode(result.stderr)}`,
    );
  }
  if (inputError) throw inputError;
  return decoder.decode(result.stdout);
}

const options = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  if (!["--ha-repo", "--python"].includes(Deno.args[i]) || !Deno.args[i + 1]) {
    throw new Error(
      "Use --ha-repo <pinned checkout> --python <Python >=3.12 with aiohttp and certifi>",
    );
  }
  options.set(Deno.args[i], Deno.args[i + 1]);
}
const haRepo = options.get("--ha-repo");
if (!haRepo) {
  throw new Error(
    "--ha-repo is required; qualification never selects an implicit sibling or floating revision",
  );
}
const python = options.get("--python") ?? "python3";
const pin = JSON.parse(
  await Deno.readTextFile(
    new URL("tests/planner-integration/ha-revision.json", root),
  ),
);
assertEquals(
  (await command("git", ["-C", haRepo, "rev-parse", "HEAD"])).trim(),
  pin.revision,
  "qualification requires the reviewed HA revision",
);
assertEquals(
  await command("git", [
    "-C",
    haRepo,
    "diff",
    "HEAD",
    "--",
    "custom_components/shs_energy",
    "app",
    "web/package.json",
    "apps/shs_energy",
  ]),
  "",
  "pinned production sources must be unchanged",
);
const bridge = new URL("tests/planner-integration/ha_bridge.py", root).pathname;
const results: Record<string, unknown>[] = [];
for (const evidence of ["missing", "configured"]) {
  const produced = JSON.parse(
    await command(python, [
      bridge,
      haRepo,
      "produce",
      "12",
      "connected",
      evidence,
    ]),
  );
  const pool = produced.snapshot.device_models.find((model: { key: string }) =>
    model.key === "synthetic_pool"
  );
  assertEquals(pool.active_power_w, evidence === "configured" ? 3600 : null);
  assertAlmostEquals(pool.forecast_w_by_slot[0], 1200, .001);
  if (evidence === "missing") {
    assert(
      pool.planning_warnings.some((warning: { code: string }) =>
        warning.code === "running_power_unknown"
      ),
    );
  }
  results.push({
    scenario: "electrical_evidence",
    evidence,
    on_bound_w: pool.active_power_w,
    expected_w: pool.forecast_w_by_slot[0],
  });
}

for (const amps of [12, 15]) {
  let connectedCurrents: number[] | null = null;
  for (const cable of ["connected", "disconnected"]) {
    const produced = JSON.parse(
      await command(python, [bridge, haRepo, "produce", String(amps), cable]),
    );
    assertEquals(produced.integration_version, pin.integration_version);
    assertEquals(produced.app_version, pin.app_version);
    assertEquals(produced.provenance, "independently_generated_synthetic");
    const snapshot: OptimisationSnapshot = produced.snapshot;
    assertEquals(
      snapshot.schema_version,
      10,
      "use the real current producer schema",
    );
    assertEquals(
      snapshot.slots.length,
      288,
      "the complete producer captures a 72h horizon",
    );
    assertEquals(snapshot.ev_battery!.connected, cable === "connected");
    const pool = snapshot.device_models.find((m) =>
      m.key === "synthetic_pool"
    )!;
    assertEquals(
      pool.active_power_w,
      3600,
      "reviewed ON draw must survive quarter means",
    );
    assertAlmostEquals(pool.forecast_w_by_slot[0], 1200, .001);
    assertAlmostEquals(
      snapshot.slots[0].base_load_forecast_w,
      500,
      .001,
      "producer separates modeled loads from household base",
    );
    // Server-owned preferences and accepted thermal calibration are supplied at
    // their actual boundary. Producer fields above are never repaired in the test.
    snapshot.comfort = { ev: { target_km: 300 }, pool: { target_c: 30 } };
    snapshot.outdoor_temperature_c = snapshot.slots.map(() => 10);
    snapshot.pool_model = {
      loss_kw_per_k: 0,
      rated_cop: 4,
      cop_per_air_c: null,
      heater_response: { kind: "steady" },
      hardware: snapshot.pool!.hardware!,
    };
    const basis = prepareRulesPlanningInput(
      {
        snapshot,
        now: snapshot.captured_at,
        price_archive: [],
        resolved_price_outlook: {
          shaped: true,
          observed_days: 1,
          effective_days: 1,
          level_sek_per_kwh: .2,
          shadow_import_sek_per_kwh: snapshot.slots.map((s) =>
            s.import_price_sek_per_kwh!
          ),
        },
      },
      null,
      resolveRulePolicy(),
    );
    const plan = generateRulesPlan(basis).plan;
    const slot = plan.execution_plan!.plans.priority.slots[0];
    electricalOpening(slot, amps, snapshot.grid.import_limit_w);
    const currents = plan.plans.priority.slots.map((s) =>
      s.ev_target_current_a
    );
    if (connectedCurrents) {
      assertEquals(
        currents,
        connectedCurrents,
        "cable telemetry must not change any future scheduled current",
      );
    } else connectedCurrents = currents;
    const consumed = JSON.parse(
      await command(python, [bridge, haRepo, "consume"], {
        plan,
        options: produced.options,
        amps,
        connected: cable === "connected",
      }),
    );
    assertEquals(consumed.admitted, true);
    assertEquals(consumed.pool_switch, "on");
    assertEquals(consumed.ev_current, cable === "connected" ? amps : 5);
    assertEquals(consumed.ev_switch, cable === "connected" ? "on" : "off");
    assertEquals(
      consumed.ev_condition,
      cable === "connected"
        ? null
        : { status: "temporarily_absent", cause: "vehicle_disconnected" },
    );
    results.push({
      amps,
      cable,
      producer_schema: snapshot.schema_version,
      published_schema: plan.schema_version,
      model_version: plan.model_version,
      commands: consumed.commands,
    });
  }
}
{
  const produced = JSON.parse(
    await command(python, [bridge, haRepo, "produce-room"]),
  );
  const snapshot: OptimisationSnapshot = produced.snapshot;
  assertEquals(snapshot.device_models.length, 1);
  assertEquals(snapshot.device_models[0].active_power_w, 1000);
  const fit = fitRoom(roomObservations(), 1000);
  assert(fit.ok, "independent excited synthetic plant must be learnable");
  snapshot.outdoor_temperature_c = snapshot.slots.map(() => 10);
  snapshot.thermal_zones = [{
    key: "synthetic_room",
    name: "Synthetic room",
    device_keys: ["synthetic_relay"],
    model: fit.model,
    start_temperature_c: 18,
    rated_power_w: 1000,
    comfort_min_c: snapshot.slots.map(() => 20),
    target_c: snapshot.slots.map(() => 20),
    comfort_max_c: snapshot.slots.map(() => 20.5),
    maximum_power_w_by_slot: snapshot.slots.map(() => 1000),
    unplanned_power_w: snapshot.slots.map(() => 300),
  }];
  const plan = generateRulesPlan(
    prepareRulesPlanningInput(
      {
        snapshot,
        now: snapshot.captured_at,
        price_archive: [],
        resolved_price_outlook: {
          shaped: true,
          observed_days: 1,
          effective_days: 1,
          level_sek_per_kwh: .2,
          shadow_import_sek_per_kwh: snapshot.slots.map((s) =>
            s.import_price_sek_per_kwh!
          ),
        },
      },
      null,
      resolveRulePolicy(),
    ),
  ).plan;
  const consumed = JSON.parse(
    await command(python, [bridge, haRepo, "consume"], {
      plan,
      options: produced.options,
      room: true,
    }),
  );
  assertEquals(consumed.admitted, true);
  const projection = plan.execution_plan!.thermal_projection!.zones[0];
  const temperature = roomExecution(consumed.relay_states, projection);
  results.push({
    scenario: "room",
    executed_quarters: consumed.relay_states.length,
    final_temperature_c: temperature,
    native_command_count: consumed.commands.length,
  });
}
console.log(
  JSON.stringify(
    {
      status: "passed",
      provenance: "independently_generated_synthetic",
      producer_revision: pin.revision,
      integration_version: pin.integration_version,
      app_version: pin.app_version,
      scenarios: results,
    },
    null,
    2,
  ),
);
