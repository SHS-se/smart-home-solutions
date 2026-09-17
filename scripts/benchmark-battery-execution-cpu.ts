/** Cold-process policy benchmark: deno run scripts/benchmark-battery-execution-cpu.ts ac|dc
 * Timings are observational, never a validity gate. Hash verifies identical wire output.
 */
import { cpuUsage } from "node:process";
import { executionFixtureRequest } from "./generate-battery-execution-fixtures.ts";
import { compileBatteryExecutionPolicy } from "../supabase/functions/_shared/battery-execution-policy.ts";

export function benchmarkRequest(dc: boolean) {
  const request = executionFixtureRequest(288),
    p = request.problem,
    b = p.plant.equipment[0];
  if (b.kind !== "battery") throw new Error("Expected fixture battery");
  b.state_kwh = { ...b.state_kwh, min: 0, max: 17.176, initial: 11.28192 };
  b.charge_max_w = 8800;
  b.discharge_max_w = 9600;
  b.export_allowed.fill(false);
  request.permissions.battery_export_allowed = false;
  request.domain.energy_kwh = [0, 17.176];
  if (dc) {
    request.identity.response_model_revision = "pv-first-dc-v2";
    b.conversion = {
      revision: "benchmark",
      grid_charge: { gain: .948, overhead_w: 36 },
      surplus_charge: { gain: .95, overhead_w: 0 },
      discharge: { gain: .974, overhead_w: 143 },
      idle_loss_w: 124,
    };
  }
  p.plant.residual_loads[1].power_w.fill(0);
  p.plant.pv_w = p.intervals.map((_, i) =>
    Math.max(0, 4000 * Math.sin((i % 96 - 24) * Math.PI / 48))
  );
  p.plant.residual_loads[0].power_w = p.intervals.map((_, i) =>
    1000 + (i % 96 >= 40 && i % 96 < 72 ? 2000 : 0)
  );
  request.future_supply_bound_w = p.intervals.map((_, i) =>
    Math.max(0, p.plant.residual_loads[0].power_w[i] - p.plant.pv_w[i])
  );
  p.economics.import_sek_per_kwh = p.intervals.map((_, i) =>
    i % 96 >= 60 && i % 96 < 80 ? 2.5 : 1
  );
  p.economics.terminal[0].curve.points = Array.from(
    { length: 81 },
    (_, i) => ({ at: i * 17.176 / 80, sek_per_unit: .8 * (1 - i / 80) }),
  );
  request.search = {
    energy_levels_kwh: [],
    retained_per_level: 2,
    max_interval_evaluations: 8_000_000,
  };
  return request;
}
if (import.meta.main) {
  const mode = Deno.args[0] ?? "dc";
  if (!["ac", "dc"].includes(mode)) throw new Error("Expected ac or dc");
  const request = benchmarkRequest(mode === "dc");
  const start = performance.now(), cpu = cpuUsage();
  const result = compileBatteryExecutionPolicy(request);
  const elapsed = performance.now() - start, used = cpuUsage(cpu);
  if (result.status !== "compiled") throw new Error(JSON.stringify(result));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(result)),
  );
  console.log(
    JSON.stringify({
      mode,
      intervals: 288,
      wall_ms: elapsed,
      cpu_ms: (used.user + used.system) / 1000,
      cells: result.policy.continuation.cells.length,
      sha256: Array.from(
        new Uint8Array(digest),
        (x) => x.toString(16).padStart(2, "0"),
      ).join(""),
    }),
  );
}
