// Synthetic sensitivity study; elapsed times are local measurements, not deployment guarantees.
import { compileBatteryPolicy } from "../supabase/functions/_shared/battery-policy.ts";
const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../docs/energy-optimisation/fixtures/battery-policy/fixed-tail-reversal.json",
      import.meta.url,
    ),
  ),
);
for (const n of [96, 288]) {
  for (const width of [1, 2]) {
    const c = structuredClone(fixture), p = c.problem, b = p.plant.equipment[0];
    const start = Date.parse(p.intervals[0].start);
    p.intervals = Array.from(
      { length: n },
      (_, i) => ({
        start: new Date(start + i * 900000).toISOString(),
        end: new Date(start + (i + 1) * 900000).toISOString(),
      }),
    );
    const hour = (i: number) => (8 + i / 4) % 24;
    p.plant.pv_w = Array.from(
      { length: n },
      (_, i) => Math.max(0, Math.sin((hour(i) - 6) * Math.PI / 12)) * 3000,
    );
    p.plant.residual_loads[0].power_w = Array.from(
      { length: n },
      (_, i) => hour(i) > 17 && hour(i) < 22 ? 1800 : 600,
    );
    p.economics.import_sek_per_kwh = Array.from(
      { length: n },
      (_, i) => hour(i) > 17 && hour(i) < 22 ? 3 : 0.5,
    );
    p.economics.export_sek_per_kwh = Array(n).fill(0.2);
    p.economics.ramp_sek_per_kw = 0.02;
    b.state_kwh = {
      initial: 5,
      min: 0,
      max: 10,
      provenance: "synthetic benchmark",
    };
    b.charge_max_w = b.discharge_max_w = 4000;
    b.charge_efficiency = b.discharge_efficiency = 0.95;
    b.wear_sek_per_kwh = 0.05;
    for (const key of ["available", "grid_charge_allowed", "export_allowed"]) {
      b[key] = Array(n).fill(true);
    }
    c.alternatives[1].current.actions[0].export_w = 400;
    c.search.energy_levels_kwh = [4, 5, 6];
    c.search.retained_per_level = width;
    c.search.max_interval_evaluations = 40_000_000;
    const startMs = performance.now();
    const r = compileBatteryPolicy(c);
    const ms = performance.now() - startMs;
    console.log(JSON.stringify({
      n,
      width,
      ms,
      status: r.status,
      ...(r.status === "compiled"
        ? {
          work: r.work,
          rank: r.ranking,
          costs: r.alternatives.map(
            (a) => [a.id, a.full.total_sek, a.search.pruned_prefixes],
          ),
          optimality: r.coverage.optimality,
        }
        : { result: r }),
    }));
    if (r.status !== "compiled") {
      Deno.exitCode = 1;
    }
  }
}
