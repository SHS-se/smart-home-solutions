import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { PoolSourceKernel, validateHeaterSource, parseDeviceModels, poolInventoryC, stepPool, stepPoolThermal, type HeaterState, type PoolConditions, type PoolTransition, type PublishedHeater, type ThermalStoreModel } from "./device-models.ts";

const store: ThermalStoreModel = { capacity_kwh_per_c: 63.965, response_time_constant_h: 0.675,
  loss: { kind: "measured", points: [{ at_c: 29, c_per_h: -0.0409231 }] } };
const heater: PublishedHeater = { compressor_w: 3200, auxiliary_w: 80, heat_w: 3200 * 0.06564008 * 63.965,
  response: { kind: "bergvarme", startup: [
    { elapsed_seconds: 0, electric_fraction: 0, heat_fraction: 0 },
    { elapsed_seconds: 335, electric_fraction: 0, heat_fraction: 0 },
    { elapsed_seconds: 1080, electric_fraction: 1, heat_fraction: 1 },
  ] } };

Deno.test("pool reservoir conserves heat and composes across a linear-input split", () => {
  for (const pending of [0, 8.1]) for (const [start, end] of [[0, 0], [12000, 12000], [0, 12000], [12000, 0]]) {
    const initial = { water_c: 29.64, pending_heat_kwh: pending };
    const whole = stepPoolThermal(store, initial, start, end, 12, 0.75);
    const intermediate = start + (end - start) * 0.21 / 0.75;
    const first = stepPoolThermal(store, initial, start, intermediate, 12, 0.21);
    const split = stepPoolThermal(store, first, intermediate, end, 12, 0.54);
    assertAlmostEquals(whole.water_c, split.water_c, 1e-12);
    assertAlmostEquals(whole.pending_heat_kwh, split.pending_heat_kwh, 1e-12);
    const delivered = (whole.water_c - initial.water_c + 0.0409231 * 0.75) * store.capacity_kwh_per_c;
    const supplied = (start + end) / 2 / 1000 * 0.75;
    assertAlmostEquals(delivered + whole.pending_heat_kwh, supplied + pending, 1e-10);
    assertAlmostEquals(poolInventoryC(store, whole.water_c, whole.pending_heat_kwh), initial.water_c + (pending + supplied) / store.capacity_kwh_per_c - 0.0409231 * 0.75, 1e-12);
  }
});

Deno.test("tiny response phases retain nonnegative pending heat on rising and falling ramps", () => {
  const tiny = { ...store, response_time_constant_h: 1e6 };
  const initial = { water_c: 29.64, pending_heat_kwh: 0 };
  for (const [start, end] of [[12000, 0], [0, 12000]]) {
    const q = stepPoolThermal(tiny, initial, start, end, 12, 1e-8);
    assert(q.pending_heat_kwh >= 0);
    assertAlmostEquals(q.pending_heat_kwh, 6000 / 1000 * 1e-8, 1e-20);
  }
});

Deno.test("deterministic response agrees with exponential decay across tiny and saturated intervals", () => {
  const model: ThermalStoreModel = { capacity_kwh_per_c: 1, response_time_constant_h: 1,
    loss: { kind: "measured", points: [{ at_c: 0, c_per_h: 0 }] } };
  const cases = [0, 1e-15, 1e-12, 1e-8, 0.0000999, 0.0001001, 0.125, 0.12371042471042472, 40, 1000,
    ...Array.from({ length: 1024 }, (_, i) => (i + 0.123) / 77)];
  for (const hours of cases) {
    const q = stepPoolThermal(model, { water_c: 0, pending_heat_kwh: 1 }, 0, 0, 0, hours);
    assertAlmostEquals(q.water_c, -Math.expm1(-hours), 2e-15);
    assertAlmostEquals(q.pending_heat_kwh, Math.exp(-hours), 2e-15);
  }
});

Deno.test("pool startup integration is independent of interval boundaries", () => {
  const conditions: PoolConditions = { water_c: 29.64, pending_heat_kwh: 0, outdoor_c: 12, seconds: 2700, stop_c: null };
  const whole = stepPool(store, heater, { kind: "off", seconds: 2000 }, true, conditions);
  const first = stepPool(store, heater, { kind: "off", seconds: 2000 }, true, { ...conditions, seconds: 756 });
  const second = stepPool(store, heater, first.next, true, { ...conditions, water_c: first.water_c, pending_heat_kwh: first.pending_heat_kwh, seconds: 1944 });
  assertAlmostEquals(whole.water_c, second.water_c, 1e-12);
  assertAlmostEquals(whole.pending_heat_kwh, second.pending_heat_kwh, 1e-12);
  assertAlmostEquals(whole.electric_w * 2700, first.electric_w * 756 + second.electric_w * 1944, 1e-8);
  assertEquals(whole.next, second.next);
  assertEquals(whole.start, { off_seconds: 2000 });
  assertEquals(second.start, null);
});

Deno.test("learned response predicts the held-out short run without discarding the post-stop contribution", () => {
  // Oct13 14:30–15:15 Stockholm; held-state compressor energy integrated from
  // history (51).csv. Parameters were fitted excluding this run and its tail.
  const energy = [0.3355852644058068, 0.744291527498232, 0.7465057691658868];
  let state = { water_c: 29.64, pending_heat_kwh: 0 };
  for (const kwh of energy) {
    const heatW = kwh / 0.25 * 1000 * 0.06564008 * store.capacity_kwh_per_c;
    state = stepPoolThermal(store, state, heatW, heatW, 12, 0.25);
  }
  assertAlmostEquals(state.water_c - 29.64, 0.01127327374187459, 1e-10);
  assert(state.pending_heat_kwh > 4.9);
  const tail = stepPoolThermal(store, state, 0, 0, 12, 1);
  assert(tail.pending_heat_kwh > 0 && tail.pending_heat_kwh < state.pending_heat_kwh);
  assert(tail.water_c > state.water_c);
});

Deno.test("pool thermostat catches an interior peak and continues the pending off-tail", () => {
  const model: ThermalStoreModel = { capacity_kwh_per_c: 1, response_time_constant_h: 0.25,
    loss: { kind: "measured", points: [{ at_c: 29, c_per_h: -0.4 }] } };
  const machine: PublishedHeater = { compressor_w: 5, auxiliary_w: 0, heat_w: 20, response: { kind: "steady" } };
  const initial = { water_c: 29, pending_heat_kwh: 1 };
  const uncut = stepPoolThermal(model, initial, 20, 20, 12, 3);
  assert(uncut.water_c < 29.4);
  const q = stepPool(model, machine, { kind: "steady" }, true,
    { ...initial, seconds: 10800, outdoor_c: 12, stop_c: 29.4 });
  assert(q.next.kind === "off");
  assertAlmostEquals(q.next.seconds, (3 - 0.15452056181291723) * 3600, 1e-8);
  assertAlmostEquals(q.water_c, 28.803084240746138, 1e-10);
  assert(q.pending_heat_kwh > 0);
  assert(q.electric_w > 0 && q.electric_w < machine.compressor_w);
});

Deno.test("an off or thermostat-disabled pool still delivers pending heat", () => {
  for (const on of [true, false]) {
    const q = stepPool(store, heater, { kind: "off", seconds: 60 }, on,
      { water_c: 30, pending_heat_kwh: 8.1, outdoor_c: 12, seconds: 900, stop_c: 29.5 });
    assertEquals(q.electric_w, 0);
    assertEquals(q.start, null);
    assertEquals(q.next, { kind: "off", seconds: 960 });
    assert(q.water_c > 30);
    assert(q.pending_heat_kwh < 8.1);
  }
});

Deno.test("zero response time is explicit direct transfer", () => {
  const direct = { ...store, response_time_constant_h: 0 };
  const q = stepPool(direct, heater, { kind: "off_unobserved" }, true,
    { water_c: 29.64, pending_heat_kwh: 0, outdoor_c: 12, seconds: 2700, stop_c: null });
  assertEquals(q.pending_heat_kwh, 0);
  assertAlmostEquals(q.water_c, 29.64 + q.heat_w / 1000 / store.capacity_kwh_per_c * 0.75 - 0.0409231 * 0.75, 1e-12);
});

Deno.test("direct response releases carried energy before evaluating the hardware stop", () => {
  const direct = { ...store, response_time_constant_h: 0 };
  for (const on of [true, false]) {
    const q = stepPool(direct, heater, { kind: "off", seconds: 60 }, on,
      { water_c: 29.64, pending_heat_kwh: store.capacity_kwh_per_c * 0.1, outdoor_c: 12, seconds: 900, stop_c: 29.7 });
    assertEquals(q.electric_w, 0);
    assertEquals(q.pending_heat_kwh, 0);
    assertAlmostEquals(q.water_c, 29.74 - 0.0409231 * 0.25, 1e-12);
  }
});

Deno.test("device publication requires an explicit physically valid response time", () => {
  const pool = { store, heater: { setting_unit: "on", selected_setting: 1, control: "switch" as const,
    auxiliary_w: 0, operating_points: [{ setting: 1, electric_w: 3200, heat_w: 12000 }] } };
  assertThrows(() => parseDeviceModels({ pool: { ...pool, store: { ...store, response_time_constant_h: -1 } } }));
});

interface Golden { name: string; store: ThermalStoreModel; heater: PublishedHeater; state: HeaterState; on: boolean; conditions: PoolConditions; expected: PoolTransition }
const vectors: Golden[] = JSON.parse(Deno.readTextFileSync(new URL("../../../../planner-core/models/pool-thermal-transitions.json", import.meta.url)));
Deno.test("TypeScript matches shared pool-thermal transition vectors", () => {
  for (const vector of vectors) {
    const q = stepPool(vector.store, vector.heater, vector.state, vector.on, vector.conditions);
    for (const field of ["electric_w", "compressor_w", "auxiliary_w", "heat_w", "water_c", "pending_heat_kwh"] as const) {
      assertAlmostEquals(q[field], vector.expected[field], 1e-10, `${vector.name}: ${field}`);
    }
    assertAlmostEquals(q.source_depletion_kwh ?? 0, vector.expected.source_depletion_kwh ?? 0, 1e-10);
    assertEquals(q.next, vector.expected.next);
    assertEquals(q.start, vector.expected.start);
  }
});

Deno.test("continuous source transition agrees with independent ODE integration and composes", () => {
  for (let i = 0; i < 24; i++) {
    const capacity = 64, tau = [.1,.5,1,2][i%4], rate = [.05,.5,2][i%3], beta = .01, cop = 4.2;
    const hours = .25+(i%5)*.3, power = i%4, slope = (3-power)/hours;
    const initial = [30,1+i%4,i%3*5], dt = hours/2000;
    const kernel = new PoolSourceKernel(capacity,tau,{recovery_rate_per_h:rate,heat_loss_per_kwh:beta},cop);
    const q = kernel.piece(...initial as [number,number,number],power,slope,hours,-.01);
    const first = kernel.piece(...initial as [number,number,number],power,slope,hours*.37,-.01);
    const split = kernel.piece(first.water_c,first.pending_heat_kwh,first.source_depletion_kwh,power+slope*hours*.37,slope,hours*.63,-.01);
    let z = initial;
    const derivative = (v: number[], t: number) => {
      const p=power+slope*t, heat=cop*p*(1-beta*v[2]);
      return [v[1]/tau/capacity-.01,heat-v[1]/tau,p-rate*v[2]];
    };
    for(let step=0;step<2000;step++) {
      const t=step*dt,k1=derivative(z,t),k2=derivative(z.map((v,j)=>v+dt*k1[j]/2),t+dt/2),
        k3=derivative(z.map((v,j)=>v+dt*k2[j]/2),t+dt/2),k4=derivative(z.map((v,j)=>v+dt*k3[j]),t+dt);
      z=z.map((v,j)=>v+dt*(k1[j]+2*k2[j]+2*k3[j]+k4[j])/6);
    }
    for(const [j,field] of ['water_c','pending_heat_kwh','source_depletion_kwh'].entries()) {
      assertAlmostEquals(q[field as keyof typeof q],z[j],1e-9);
      assertAlmostEquals(q[field as keyof typeof q],split[field as keyof typeof split],1e-10);
    }
  }
});

Deno.test("a short source stop preserves depletion and restarting cannot reset it", () => {
  const v=vectors.find(v=>v.name==='source off recovery')!;
  const off=stepPool(v.store,v.heater,v.state,false,v.conditions);
  assert(off.source_depletion_kwh! > v.conditions.source_depletion_kwh!*.95);
  const next=stepPool(v.store,v.heater,off.next,true,{...v.conditions,water_c:off.water_c,pending_heat_kwh:off.pending_heat_kwh,source_depletion_kwh:off.source_depletion_kwh});
  assert(next.source_depletion_kwh! > off.source_depletion_kwh!);
  assertThrows(()=>stepPool(v.store,v.heater,v.state,true,{...v.conditions,source_depletion_kwh:undefined}),Error,'source memory');
});

Deno.test("source hardware stop detects a peak even when a complete interval would end below the threshold", () => {
  const v=vectors.find(v=>v.name==='source interior threshold')!;
  const unclipped=stepPool(v.store,v.heater,v.state,true,{...v.conditions,stop_c:null});
  assert(unclipped.water_c < v.conditions.stop_c!);
  const clipped=stepPool(v.store,v.heater,v.state,true,v.conditions);
  assert(clipped.compressor_w < unclipped.compressor_w);
  assert(clipped.next.kind==='off');
});

Deno.test("source gain remains positive at startup overshoot power", () => {
  const source = {recovery_rate_per_h:.1,heat_loss_per_kwh:.02};
  const published = {...heater,compressor_w:3000,source,response:{kind:'bergvarme' as const,startup:[
    {elapsed_seconds:0,electric_fraction:2,heat_fraction:1}, {elapsed_seconds:900,electric_fraction:1,heat_fraction:1}]}};
  assertThrows(()=>validateHeaterSource(published),Error,'every published power');
});
