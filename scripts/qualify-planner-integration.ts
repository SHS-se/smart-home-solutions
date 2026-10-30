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
  roomOperatingPower,
} from "../tests/planner-contracts/integration-oracles.ts";
import { fitRoom } from "../supabase/functions/_shared/device-learning/room/fit.ts";
import { roomObservations } from "../tests/planner-contracts/synthetic.ts";
import type { OptimisationSnapshot } from "../supabase/functions/_shared/planner/planning-contracts.ts";
import { nativePlanner } from "../supabase/functions/_shared/planner-wasm/runtime.ts";
import { nativeBattery } from "../supabase/functions/_shared/planner/battery-instruction.ts";
import { qualifyPoolCapture } from "../tests/planner-integration/pool-capture.ts";

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
{
  const produced = JSON.parse(await command(python, [bridge, haRepo, "produce-battery"]));
  const snapshot: OptimisationSnapshot = produced.snapshot;
  assertEquals(snapshot.schema_version, 11);
  assertEquals(snapshot.battery, {
    capacity_kwh: 10, soc: .5, min_soc: .1, max_soc: 1,
    charge_max_w: 4000, discharge_max_w: 5000,
    conversion: { revision: "synthetic-qualification-affine-v1",
      grid_charge: { gain: .8, overhead_w: 80 }, surplus_charge: { gain: .9, overhead_w: 45 },
      discharge: { gain: .75, overhead_w: 75 }, idle_loss_w: 60 },
    charge_efficiency: .9, discharge_efficiency: .8,
  }, "real producer must preserve the complete invented terminal/storage model");
  const basis = prepareRulesPlanningInput({ snapshot, now: snapshot.captured_at,
    price_archive: [], resolved_price_outlook: { shaped: true, observed_days: 3,
      effective_days: 3, level_sek_per_kwh: 1,
      shadow_import_sek_per_kwh: snapshot.slots.map(s => s.import_price_sek_per_kwh!) } },
    null, resolveRulePolicy());
  const plan = generateRulesPlan(basis).plan;
  const slots = plan.plans.priority.slots;
  const projected = nativePlanner().project(basis.problem, slots.map(s => ({
    pool_on: false, ev_amps: 0, ...nativeBattery(s.battery_instruction!),
  }))).outcome;
  assert(projected.kind === "projected");
  const quarters = projected.quarters;
  assert(quarters.some(q => q.charge_dc_w > 0), "synthetic cheap quarters must charge");
  assert(quarters.some(q => q.discharge_dc_w > 0), "synthetic dear quarters must supply the house");
  assert(quarters.some(q => q.battery_idle_w > 0), "inactive quarters retain installation demand");
  const reference = plan.battery_execution!;
  assertEquals(reference.schema, "battery-plan-execution-v3");
  assert("storage" in reference && "intervals" in reference);
  assertEquals(reference.storage, { charge_efficiency: .9, discharge_efficiency: .8 });
  let stored = 5;
  for (const [i, q] of quarters.entries()) {
    const h = basis.problem.slots[i].hours, house = slots[i].load_w - q.battery_idle_w;
    // Independent affine arithmetic: zero forecast PV in this plant means the
    // grid charging and discharge curves have exact closed forms.
    assertAlmostEquals(q.charge_w, q.charge_dc_w > 0 ? (q.charge_dc_w + 80) / .8 : 0, 1e-7);
    assertAlmostEquals(q.discharge_w, q.discharge_dc_w > 0 ? Math.max(0, .75 * q.discharge_dc_w - 75) : 0, 1e-7);
    assertAlmostEquals(q.net_w, house + q.charge_w - q.discharge_w + q.battery_idle_w, 1e-7);
    stored += h / 1000 * (q.charge_dc_w * .9 - q.discharge_dc_w / .8);
    assertAlmostEquals(q.battery_kwh!, stored, 1e-7);
    const row = reference.intervals[i];
    assertAlmostEquals(row.stored_end_mwh, stored * 1e6, .500001);
    assertAlmostEquals(row.installation_mwh, q.battery_idle_w * h * 1000, .500001);
    assertAlmostEquals(slots[i].battery_soc! * 10, stored, 1e-7);
  }
  const consumed = JSON.parse(await command(python, [bridge, haRepo, "consume-battery"], { plan, quarters }));
  assertEquals(consumed.admitted, true);
  assertEquals(consumed.storage, { charge_efficiency: .9, discharge_efficiency: .8 });
  assertEquals(consumed.rows.length, quarters.length);
  for (const [i, q] of quarters.entries()) {
    const actual = consumed.rows[i];
    assertAlmostEquals(actual.charge_ac_w, q.charge_w, 1e-7);
    assertAlmostEquals(actual.discharge_ac_w, q.discharge_w, 1e-7);
    assertAlmostEquals(actual.net_w, q.net_w, 1e-7);
    assertAlmostEquals(actual.battery_idle_w, q.battery_idle_w, 1e-7);
  }
  results.push({ scenario: "refined_battery", producer_schema: snapshot.schema_version,
    execution_schema: reference.schema, quarters: quarters.length, final_stored_kwh: stored });
}

for (const watts of [0, 1200]) {
  const produced = JSON.parse(await command(python, [bridge, haRepo, "produce-manual-pool", String(watts)]));
  results.push(await qualifyPoolCapture(produced, watts));
}
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
      11,
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
    snapshot.comfort = { ev: { floor_soc: .3 }, pool: { target_c: 30 } };
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
{
  const produced = JSON.parse(
    await command(python, [bridge, haRepo, "produce-thermostat"]),
  );
  const snapshot: OptimisationSnapshot = produced.snapshot;
  const heater = snapshot.device_models[0];
  roomOperatingPower(heater as Parameters<typeof roomOperatingPower>[0]);
  const fit = fitRoom(roomObservations(), 1200);
  assert(fit.ok);
  snapshot.outdoor_temperature_c = snapshot.slots.map(() => 10);
  snapshot.thermal_zones = [{
    key: "synthetic_room",
    name: "Synthetic room",
    device_keys: [heater.key],
    model: fit.model,
    start_temperature_c: 18,
    rated_power_w: heater.active_power_w!,
    comfort_min_c: snapshot.slots.map(() => 20),
    target_c: snapshot.slots.map(() => 20),
    comfort_max_c: snapshot.slots.map(() => 20.5),
    maximum_power_w_by_slot: snapshot.slots.map(() => heater.active_power_w!),
    unplanned_power_w: heater.forecast_w_by_slot,
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
      room: "thermostat",
    }),
  );
  assertEquals(consumed.admitted, true);
  assert(
    consumed.commands.some((c: { domain: string; service: string }) =>
      c.domain === "climate" && c.service === "set_temperature"
    ),
  );
  const scheduled =
    plan.execution_plan!.plans.priority.slots[0].device_commands[heater.key];
  assert(scheduled.type === "setpoint");
  assertEquals(
    consumed.commands.find((c: { domain: string; service: string }) =>
      c.domain === "climate" && c.service === "set_temperature"
    ).value,
    scheduled.target_c,
  );
  const projection = plan.execution_plan!.thermal_projection!.zones[0];
  assert(
    projection.planned_temperature_c.at(-1)! >= 20,
    "idle-at-capture synthetic heater must recover comfort",
  );
  assert(projection.planned_power_w.some((w) => w > 300));
  assert(projection.planned_power_w.every((w) => w >= 0 && w <= 1200 + 1e-6));
  results.push({
    scenario: "idle_thermostat",
    observed_on_w: heater.active_power_w,
    final_temperature_c: projection.planned_temperature_c.at(-1),
    native_commands: consumed.commands,
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
