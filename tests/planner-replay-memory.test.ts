import { assert, assertEquals, assertThrows } from "@std/assert";
import { createWasmPlanner, createWasmReplayPlanner } from "../supabase/functions/_shared/planner-wasm/core.ts";
import { command, problem } from "./planner-wasm.fixture.ts";

const bytes = await Deno.readFile(new URL("../supabase/functions/_shared/planner-wasm/solver.wasm", import.meta.url));

Deno.test("10,000 replay projections retain one bounded memory and match independent native calls", () => {
  const cases = [0, 1, 2].map(i => {
    const p = structuredClone(problem());
    p.slots = p.slots.slice(0, 1);
    p.initial.battery_kwh = 3 + i;
    p.initial.ev_kwh = 20 + i * 10;
    p.initial.pool_c = 29 + i;
    p.initial.pool_pending_heat_kwh = i * .5;
    p.initial.heater_state = i === 0 ? { kind: "off_unobserved" } : { kind: "running", seconds: i * 900 };
    p.pool_store.response_time_constant_h = .675;
    p.heater.response = { kind: "bergvarme", startup: [
      { elapsed_seconds: 0, electric_fraction: .5, heat_fraction: 0 },
      { elapsed_seconds: 1200, electric_fraction: 1, heat_fraction: 1 },
    ] };
    const commands = [{ ...command(i !== 2), ev_amps: i === 1 ? 6 : 0 }];
    const expected = createWasmPlanner(bytes).project(p, commands).outcome;
    assertEquals(expected.kind, "projected");
    return { p, commands, expected };
  });
  const before = structuredClone(cases);
  const native = WebAssembly.Instance;
  let instances = 0;
  try {
    WebAssembly.Instance = new Proxy(native, { construct(target, args) {
      instances++;
      return Reflect.construct(target, args);
    } });
    const replay = createWasmReplayPlanner(bytes);
    let warmedBytes = 0;
    for (let i = 0; i < 10_000; i++) {
      const c = cases[i % cases.length], result = replay.project(c.p, c.commands);
      assertEquals(result.outcome, c.expected);
      if (i === 99) warmedBytes = result.wasm_memory_bytes;
      if (i > 99) assertEquals(result.wasm_memory_bytes, warmedBytes);
    }
    assertEquals(instances, 1);
    assertEquals(cases, before);
    const separate = createWasmReplayPlanner(bytes);
    assertEquals(separate.project(cases[0].p, cases[0].commands).outcome, cases[0].expected);
    assertEquals(instances, 2);
    const first = replay.solve(problem()).outcome;
    assertEquals(replay.solve(problem()).outcome, first);
    assertEquals(instances, 4, "optimizer solves must still own independent native state");
    assertEquals(replay.project(cases[0].p, cases[0].commands).outcome, cases[0].expected);
    assertEquals(instances, 4);
    const live = createWasmPlanner(bytes);
    live.project(cases[0].p, cases[0].commands);
    live.project(cases[0].p, cases[0].commands);
    assertEquals(instances, 6, "live/reference projections retain their original isolation");
  } finally { WebAssembly.Instance = native; }
});

Deno.test("a native failed outcome does not poison the replay allocator", () => {
  const replay = createWasmReplayPlanner(bytes), p = problem();
  const commands = p.slots.map(() => command());
  const invalid = structuredClone(p);
  invalid.battery.charge_efficiency = 1.1;
  assertEquals(replay.project(invalid, commands).outcome.kind, "failed");
  assertEquals(replay.project(p, commands).outcome.kind, "projected");
  assertEquals(replay.project(p, commands).outcome, createWasmPlanner(bytes).project(p, commands).outcome);
});

Deno.test("a trapped replay projection fails permanently without creating a replacement instance", () => {
  const native = WebAssembly.Instance, trap = new WebAssembly.RuntimeError("test projection trap");
  let instances = 0;
  try {
    WebAssembly.Instance = new Proxy(native, { construct(target, args) {
      instances++;
      const instance = Reflect.construct(target, args);
      return { exports: { ...instance.exports, planner_project: () => { throw trap; } } };
    } });
    const replay = createWasmReplayPlanner(bytes), p = problem(), commands = p.slots.map(() => command());
    assert(assertThrows(() => replay.project(p, commands)) === trap);
    assert(assertThrows(() => replay.project(p, commands)) === trap);
    assertEquals(instances, 1);
  } finally { WebAssembly.Instance = native; }
});
