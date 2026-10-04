import { generateOptimisationPlan, type OptimisationSnapshot } from "./energy-optimisation.ts";
import { DEFAULT_VALUE_SETTINGS } from "./value-curves.ts";
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { NOW, PRICED_WEAR, assert, input, horizon, routedEvService } from "./energy-optimisation.fixture.ts";

Deno.test("no allocation is charged for more solar than the quarter had", () => {
  // `recostSlot` divides a quarter's spare PV between the stores charging in
  // it, and it counted a *discharging* store's output as spare. That is not
  // spare energy: it is a transfer the discharging store was already paid for
  // through its own allocation, so the charging store got a discount nobody
  // funded. One observed quarter had the pool book its whole 3.5 kW at the
  // 1.09 SEK/kWh export price while PV was under 1.2 kW and the import price
  // was 2.15 — the four dearest quarters of that day, made to look cheapest.
  //
  // The over-credit only appears where a discharging store puts out *more* than
  // the quarter's residual load, because only then is there a phantom surplus
  // to divide. So: no sun, a light house, a full battery whose top-of-curve
  // energy is worth little, and a cold pool drawing hard beside it.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: 1_000,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 16 && hour < 20 ? 2.4 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const plan = generateOptimisationPlan(
    horizon({
      slots: dark,
      outdoor_temperature_c: dark.map(() => 15),
      pool: { water_temperature_c: 24, volume_m3: 55 },
      battery: { ...base.battery!, capacity_kwh: 18.08, soc: 1 },
    }),
    new Date(NOW),
  );

  assertEquals(plan.status, "ready");
  const priority = plan.plans.priority;
  assert(
    priority.slots.some((slot) =>
      slot.battery_discharge_w > Math.max(0, slot.base_w - slot.pv_w) + 1 &&
      (slot.decision.store_allocations ?? []).some((part) =>
        part.direction === "charge"
      )
    ),
    "the fixture has to put a discharge beside a charge, or nothing is tested",
  );
  for (const slot of priority.slots) {
    const bookedSolarW = (slot.decision.store_allocations ?? [])
      .filter((part) => part.direction === "charge")
      .reduce((total, part) => total + part.solar_w, 0);
    const spareW = Math.max(0, slot.pv_w - slot.base_w);
    assert(
      bookedSolarW <= spareW + 1,
      `${slot.start}: ${bookedSolarW.toFixed(0)} W booked as solar against ` +
        `${spareW.toFixed(0)} W of surplus`,
    );
  }
});

Deno.test("every allocation is priced where it lands, and none of them loses", () => {
  // The auction values each move against the trajectory as it stood when that
  // move won, and every later allocation shifts the trajectory underneath it.
  // Two things must hold once the plan is settled: the state an allocation
  // records is the state the plan executes, and nothing survives that does not
  // pay for itself there. Observed failing: a battery charge booked at
  // 1.648 SEK/kWh against a projected 1.01 kWh state, executed at 6.09 kWh
  // where the same energy is worth 0.695, bought at 1.169.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 28.4, volume_m3: 55 },
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Tesla Model Y",
      connected: true,
      capacity_kwh: 77.25,
      soc: 0.56,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.level",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: "number.current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  assertEquals(plan.validation_errors, []);

  const losing: string[] = [];
  const misstated: string[] = [];
  let allocations = 0;
  for (const slot of plan.plans.priority.slots) {
    const battery = slot.decision.battery;
    for (const part of slot.decision.store_allocations) {
      allocations += 1;
      // A continuous heat-pump run repays its startup cost together. A mildly
      // losing quarter can be worth keeping when removing it adds a restart;
      // this is an economic trade-off, not a minimum runtime.
      //
      // Whole-schedule cost refinement can also retain a charge whose later
      // discharge repays it. Its standalone value is not the paired profit.
      // Rounding a sized request onto the battery's floor happens after
      // settlement and is chosen on the whole objective, so such a quarter can
      // fall a few öre short on its own: the household's price for commanding
      // no trickles.
      if (part.run_net_value_sek < -1e-6 && !part.minimum_adjusted && !part.cost_refined) {
        losing.push(
          `${part.store_key} ${part.direction} run from ${part.run_start_index}: ${
            part.run_net_value_sek.toFixed(4)
          } SEK`,
        );
      }
      // The battery publishes the executed trajectory beside the allocation's
      // own record, so the two disagreeing is the defect made visible.
      if (
        part.store_key === "battery" && battery &&
        Math.abs(part.state_before - battery.state_before) > 1e-6
      ) {
        misstated.push(
          `${slot.start}: booked at ${
            part.state_before.toFixed(4)
          } kWh, ran at ${battery.state_before.toFixed(4)} kWh`,
        );
      }
    }
  }

  assert(
    allocations > 20,
    `expected a busy plan, got ${allocations} allocations`,
  );
  assertEquals(
    misstated.slice(0, 3),
    [],
    "an allocation must record the state the plan executes",
  );
  assertEquals(
    losing.slice(0, 3),
    [],
    "a settled plan holds nothing that loses money where it lands",
  );
});

Deno.test("the plan explains why each store bought what it did", () => {
  // A pool one degree above the top of its own curve is right to do nothing.
  // Establishing that previously meant querying the database for the snapshot
  // and re-running the planner locally, because the plan said only that it was
  // valid. It now carries the comparison that produced the outcome.
  //
  // The air is held at the water temperature so the pool neither gains nor
  // loses, which is what isolates the subject. Over the fixture's 72 hours a
  // pool losing heat to 22 °C air falls about 3.4 °C — well into the steep part
  // of its curve — and buying cheap surplus now to prevent that is correct, not
  // a defect. It only looked like one while `retentionBySlot` discounted the
  // far end of the horizon to nothing (§8.13). What is under test here is the
  // marginal-value comparison, not the decay, so the fixture removes the decay.
  const base = horizon();
  const snapshot = horizon({
    pool: { water_temperature_c: 30.15, volume_m3: 55 },
    outdoor_temperature_c: base.slots.map(() => 30.15),
    capabilities: { ...base.capabilities, ev: true, pool: true },
    ev_battery: {
      name: "Tesla Model Y",
      connected: true,
      capacity_kwh: 77.25,
      soc: 0.56,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      available_from: base.slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.level",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: "number.current",
      },
    },
    services: [routedEvService(base)],
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  const byKey = new Map(
    plan.plans.priority.store_diagnostics.map((entry) => [entry.key, entry]),
  );

  const pool = byKey.get("pool")!;
  assertEquals(pool.planned_kwh, 0);
  assertEquals(pool.unit, "celsius");
  assertEquals(pool.state, 30.15);
  // Just past the top breakpoint the pool is worth a little rather than
  // nothing — the interpolated curve declines to zero at 31 °C instead of
  // falling off a step at 30 — so the honest reason is that what it is worth
  // does not clear the price, not that it is full.
  assertEquals(pool.reason, "value_below_price");
  assert(
    pool.marginal_value_sek_per_kwh > 0,
    "a pool just past its band is worth a little, not nothing",
  );
  assert(
    pool.marginal_value_sek_per_kwh < pool.cheapest_energy_sek_per_kwh,
    "a store declines when the cheapest energy costs more than it values",
  );

  // And a car below its own charge limit says the opposite, in the same units.
  const ev = byKey.get("ev")!;
  assertEquals(ev.reason, "scheduled");
  assert(ev.planned_kwh > 0, "a car below its charge limit takes energy");
  assert(
    ev.marginal_value_sek_per_kwh > ev.cheapest_energy_sek_per_kwh,
    "a store buys when its value beats the cheapest energy it could have used",
  );
});

Deno.test("a store the planner never saw says so instead of vanishing", () => {
  // The failure this exists to stop: a car connected below its own charge
  // limit, whose meter the website left in base load. `capabilities.ev` goes
  // false, no store is built, no bid is made, and the plan reports "ready"
  // with no errors — indistinguishable from a household that owns no car.
  const snapshot = horizon({
    capabilities: {
      pv: true,
      battery: true,
      pool: true,
      boiler: false,
      ev: false,
    },
    pool: { water_temperature_c: 26.5, volume_m3: 55 },
    ev_battery: {
      name: "Model Y",
      connected: true,
      capacity_kwh: 76.87,
      soc: 0.67,
      departure_target_soc: 0.8,
      charge_efficiency: 0.9,
      available_from: "2026-08-10T08:00:00.000Z",
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.cable",
        soc: "sensor.soc",
        target_soc: "number.limit",
        energy_remaining: null,
        charge_current: null,
      },
    },
  });

  const plan = generateOptimisationPlan(snapshot, new Date(NOW));
  const byKey = new Map(
    plan.plans.priority.store_diagnostics.map((entry) => [entry.key, entry]),
  );

  const ev = byKey.get("ev");
  assert(
    ev !== undefined,
    "a connected vehicle must appear in the diagnostics",
  );
  assertEquals(ev.reason, "not_controllable");
  assertEquals(ev.planned_kwh, 0);
  // Null rather than zero: never considered is not the same claim as worth
  // nothing, and only one of them points at a setting to change.
  assertEquals(ev.marginal_value_sek_per_kwh, null);
  assert(
    ev.state !== null && ev.state > 0,
    "range is reported in the curve's units",
  );

  // The pool is routed, so it still reports a real comparison alongside it.
  const pool = byKey.get("pool")!;
  assertEquals(pool.reason, "scheduled");
  assert(
    pool.marginal_value_sek_per_kwh !== null,
    "a routed store reports what it was worth",
  );
});

Deno.test("every planned quarter records decision evidence and exact grid arithmetic", () => {
  const snapshot = horizon({
    capabilities: {
      pv: true,
      battery: true,
      pool: false,
      boiler: false,
      ev: false,
    },
    pool: null,
  });
  const archiveStart = Date.parse("2026-08-08T22:00:00.000Z");
  const archive = Array.from({ length: 96 }, (_value, index) => ({
    start_ts: new Date(archiveStart + index * 15 * 60_000).toISOString(),
    import_price_sek_per_kwh: index >= 68 && index < 80 ? 4.2 : 0.7,
  }));
  const plan = generateOptimisationPlan(snapshot, new Date(NOW), archive);
  const slots = plan.plans.priority.slots;

  assertEquals(plan.decision_diagnostics_version, 2);
  const batteryCurve = plan.battery_value_curve;
  assert(batteryCurve !== null, "the derived battery curve must be published");
  assertEquals(batteryCurve.schema_version, 2);
  assertEquals(batteryCurve.source, "automatic");
  assertEquals(batteryCurve.state_basis, "usable_kwh_above_min_soc");
  assertEquals(batteryCurve.curve.unit, "kwh");
  assert(
    batteryCurve.curve.points.length > 2,
    "curve breakpoints are required",
  );
  assert(
    Math.abs(
      batteryCurve.covering_window.reduce(
        (sum, slice) => sum + slice.battery_energy_kwh,
        0,
      ) - batteryCurve.curve_input.expected_draw_kwh,
    ) < 1e-6,
    "published covering slices must reproduce the curve input",
  );
  assertEquals(
    generateOptimisationPlan(snapshot, new Date(NOW), [], plan.price_outlook),
    plan,
    "snapshot, solve time and resolved outlook must replay bit for bit",
  );
  assert(
    slots.some((slot) => slot.decision.store_allocations.length > 0),
    "the fixture must expose at least one accepted curve allocation",
  );
  for (const slot of slots) {
    assertEquals(slot.decision.schema_version, 1);
    assert(slot.decision.battery !== null, "battery evidence is required");
    const balance = slot.decision.grid_balance;
    const residual = balance.load_w + balance.battery_charge_w - balance.pv_w -
      balance.battery_discharge_w;
    assert(
      Math.abs(residual - balance.residual_w) < 0.05,
      `${slot.start}: recorded residual does not match its operands`,
    );
  }
});

Deno.test("a dispatched battery is not failed against a floor it was never given", () => {
  // The live plan behind this: a battery starting at 15.9% against a 20%
  // terminal reserve. The plan raised it to 17.9% and reported itself
  // infeasible for the improvement, because `terminal_soc_min` reaches the
  // dispatch nowhere — the store's floor is `min_soc` — so the auction was
  // free to end anywhere above 5% and was then judged against 20%. No plan
  // could have passed except one that force-charged at any price, which is the
  // hard target §8.4 deleted.
  //
  // Power here is cheap enough that `batteryValueCurve` values stored energy
  // at nothing once wear is subtracted, so the battery correctly ends low. At
  // ordinary prices it grid-charges to full even across a sunless horizon,
  // which is why this went unnoticed for so long. The wear is stated rather
  // than inherited, because it is that subtraction that sets the scene here.
  const base = horizon();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const cheapSlots = base.slots.map((slot, index) => ({
    ...slot,
    start: new Date(start + index * 15 * 60_000).toISOString(),
    import_price_sek_per_kwh: index < 96 ? 0.35 : null,
    export_price_sek_per_kwh: index < 96 ? 0.1 : null,
  }));
  const withFloor = (
    floor: number,
    overrides: Partial<OptimisationSnapshot> = {},
  ) =>
    horizon({
      // Pool state is what makes the dispatch buildable at all: it refuses to
      // mix a measured store with a budgeted one, so a fixture without it is
      // never dispatched and would test nothing here.
      pool: { water_temperature_c: 30.9, volume_m3: 55 },
      outdoor_temperature_c: base.slots.map(() => 30.9),
      slots: cheapSlots,
      policy: { ...base.policy, terminal_soc_min: floor },
      value_settings: { ...PRICED_WEAR, vehicle_fallback_sek_per_km: null },
      ...overrides,
    });

  const dispatched = generateOptimisationPlan(withFloor(0.2), new Date(NOW));

  assertEquals(
    dispatched.plans.priority.dispatched_devices.includes("battery"),
    true,
  );
  assert(
    dispatched.plans.priority.summary.battery_soc_end < 0.2,
    `the floor has to bind, got ${dispatched.plans.priority.summary.battery_soc_end}`,
  );
  assertEquals(dispatched.validation_errors, []);
  assertEquals(dispatched.status, "ready");
  // The comparison stays legible: both numbers are published, so a reader that
  // wants to show "below the reserve" has them. What it is not is a verdict.
  assertEquals(dispatched.policy.terminal_soc_min, 0.2);

  // And the exemption is scoped to the store that prices its own terminal
  // state. A battery the dispatch never took is still planned by the block
  // model, which was given no terminal value either, so there the floor is the
  // only thing that says the plan ended low. Its own floor, because the block
  // model settles higher on the same prices.
  const blockModel = generateOptimisationPlan(
    withFloor(0.8, { schema_version: 5, pool: null }),
    new Date(NOW),
  );
  assertEquals(
    blockModel.plans.priority.dispatched_devices.includes("battery"),
    false,
  );
  assert(
    blockModel.validation_errors.some((error) =>
      error.includes("terminal SOC")
    ),
    `an undispatched battery still reports the floor, got ${
      JSON.stringify(blockModel.validation_errors)
    }`,
  );
});

Deno.test("a battery that charges in winter also discharges", () => {
  // No sun for the whole horizon, so every quarter is a deficit and the
  // covering window is the entire three days. Under the round-trip valuation
  // this plan charged 15 kWh and discharged in none of 288 quarters: a battery
  // that only ever accumulates, bought at prices it could never pay back.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      // A real day/night spread, which is the only thing a battery can trade.
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const plan = generateOptimisationPlan(
    horizon({
      slots: dark,
      outdoor_temperature_c: dark.map(() => -8),
      pool: { water_temperature_c: 30.9, volume_m3: 55 },
    }),
    new Date(NOW),
  );

  assertEquals(plan.status, "ready");
  const priority = plan.plans.priority;
  assertEquals(priority.dispatched_devices.includes("battery"), true);
  const charged = priority.slots.reduce(
    (total, slot) => total + slot.battery_charge_w / 1_000 * 0.25,
    0,
  );
  const returned = priority.slots.reduce(
    (total, slot) => total + slot.battery_discharge_w / 1_000 * 0.25,
    0,
  );
  assert(charged > 1, `a cheap night is worth storing, charged ${charged} kWh`);
  assert(
    returned > 1,
    `and a dear morning is what it was stored for, returned ${returned} kWh`,
  );
});

Deno.test("a shaped peak spreads a charge instead of concentrating it", () => {
  // Compare explicit shaping rates so this regression does not follow a
  // changed default. Charging must spread while still doing useful arbitrage.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 4.2 : hour >= 16 && hour < 20 ? 3.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const at = (rate: number) => {
    const plan = generateOptimisationPlan(
      horizon({
        slots: dark,
        value_curves: { battery: { unit: "kwh", points: [
          { at: 0, sek_per_unit: 1.5 }, { at: 17.176, sek_per_unit: 1.5 },
        ] } },
        outdoor_temperature_c: dark.map(() => -8),
        capabilities: { ...base.capabilities, pool: false },
        pool: null,
        // A pack whose charger can outrun the shaping, so the power it settles
        // at is a decision rather than the hardware limit.
        battery: { ...base.battery!, capacity_kwh: 18.08, charge_max_w: 8_800 },
        policy: {
          ...base.policy,
          peak_shaping_sek_per_kwh_per_kw: rate,
        } as OptimisationSnapshot["policy"],
      }),
      new Date(NOW),
    );
    const slots = plan.plans.priority.slots;
    const charging = slots.filter((slot) => slot.battery_charge_w > 1);
    return {
      status: plan.status,
      quarters: charging.length,
      peakChargeW: Math.max(...charging.map((slot) => slot.battery_charge_w)),
      peakImportW: Math.max(...slots.map((slot) => slot.grid_import_w)),
      kwh: charging.reduce(
        (total, slot) => total + slot.battery_charge_w / 1_000 * 0.25,
        0,
      ),
    };
  };

  const flat = at(0);
  const shaped = at(0.1);

  assertEquals(flat.status, "ready");
  assertEquals(shaped.status, "ready");
  assert(
    shaped.quarters > flat.quarters,
    `shaping spreads the charge: ${flat.quarters} quarters became ${shaped.quarters}`,
  );
  assert(
    shaped.peakChargeW < flat.peakChargeW,
    `and lowers the power it is drawn at: ${flat.peakChargeW} W became ${shaped.peakChargeW} W`,
  );
  assert(
    shaped.peakImportW < flat.peakImportW,
    `which is the point — the grid peak: ${flat.peakImportW} W became ${shaped.peakImportW} W`,
  );
  // Power moved, energy did not: this is not simply buying less.
  assert(
    shaped.kwh > flat.kwh * 0.8,
    `the same charge is still bought, ${flat.kwh} against ${shaped.kwh} kWh`,
  );
});

Deno.test("a winter covering window and its reference value use published prices only", () => {
  // The window ends where the battery can next be refilled. A surplus was the
  // only thing that counted as a refill, so a horizon with no sun had none: the
  // run was all 288 quarters and 273 kWh, the whole pack was priced against the
  // dearest hours in three days, and the curve said *full* under nearly every
  // condition (§8.16 requirement 3).
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const plan = generateOptimisationPlan(
    horizon({
      slots: dark,
      outdoor_temperature_c: dark.map(() => -8),
      pool: { water_temperature_c: 30.9, volume_m3: 55 },
      battery: { ...base.battery!, capacity_kwh: 18.08, charge_max_w: 8_800 },
    }),
    new Date(NOW),
  );

  assertEquals(plan.status, "ready");
  const curve = plan.battery_value_curve;
  assert(curve !== null, "a dispatched battery publishes its curve");
  const window = curve.covering_window;
  assert(
    window.length <= 96 && window.every(quarter => dark.find(s => s.start === quarter.start)?.import_price_sek_per_kwh !== null),
    `the window stays within the 96 published quarters: ${window.length}`,
  );
  // And it is a *dear* stretch, which is the half of the requirement a
  // longest-run rule gets wrong once a cheap hour also ends a run: the longest
  // gap between two refills is frequently a lull rather than the peak the
  // battery exists for. Every quarter in it must beat the horizon's typical
  // price, or the pack is being valued against ordinary hours again.
  const horizonPrices = plan.plans.priority.slots
    .filter(slot => slot.import_price_sek_per_kwh !== null)
    .map(slot => slot.import_price_sek_per_kwh!)
    .sort((left, right) => left - right);
  const median = horizonPrices[Math.floor(horizonPrices.length / 2)];
  const cheapestCovered = Math.min(
    ...window.map((quarter) => quarter.import_price_sek_per_kwh),
  );
  assert(
    cheapestCovered >= median,
    `the cheapest covered quarter (${cheapestCovered}) is no cheaper than the published median ${median}`,
  );
  // Covering-window value is capped by ordinary replacement cost. The dear
  // in-horizon load is priced separately by the joint transaction search.
  const dearestCovered = Math.max(
    ...window.map((quarter) => quarter.import_price_sek_per_kwh),
  );
  const battery = plan.battery!;
  // Against the wear the plan actually used, which it publishes. Reading the
  // shipped default back would assert nothing when that default moves.
  assertAlmostEquals(
    curve.automatic_curve.points[0].sek_per_unit,
    Math.min(
      curve.terminal_replacement_sek_per_kwh,
      dearestCovered * battery.discharge_efficiency -
        curve.curve_input.degradation_sek_per_kwh,
    ),
    0.02,
  );
});

Deno.test("§8.12 #11 — charge power gives way to the load already in the quarter", () => {
  // The envelope is the whole home's, not the battery's own (§8.16 requirement
  // 2). A per-device cap could not express this: it would leave the same peak
  // reachable by two other loads, and the figure a fuse and a tariff both care
  // about is the sum.
  //
  // Two plans differing only in how busy the house is during the charging
  // window, because a single plan cannot show it: with quiet quarters available
  // the battery simply charges in those, which is correct and tells us nothing.
  // Raising the whole window leaves it nowhere to escape to, so what it does
  // with its power is the only thing left to observe.
  //
  // The connection is widened to 20 kW so that the fuse can never be what backs
  // the charger off: at 4 kW of house it still leaves 16 kW against an 8.8 kW
  // charger. Two earlier versions of this test passed with shaping switched
  // off because `headroomW` was clipping against the *physical* limit — which
  // is precisely the envelope §8.16 requirement 2 says is not enough, so a test
  // that cannot tell the two apart is testing the wrong one.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const atHouseLoad = (houseW: number) => {
    const slots = base.slots.map((slot, index) => {
      const load = index < 48 ? houseW : 3_000;
      return {
        ...slot,
        start: new Date(start + index * 15 * 60_000).toISOString(),
        pv_forecast_w: 0,
        // Twelve cheap hours to charge in, then a dear evening to have charged
        // for. The price is flat across the window on purpose: if the battery
        // backed off because a quarter were dearer, this would be measuring the
        // energy objective it already had.
        base_load_forecast_w: load,
        import_price_sek_per_kwh: index < 96 ? (index < 48 ? 0.8 : 3.0) : null,
        export_price_sek_per_kwh: index < 96 ? 0.2 : null,
      };
    });
    const plan = generateOptimisationPlan(
      horizon({
        slots,
        outdoor_temperature_c: slots.map(() => -8),
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        grid: { import_limit_w: 20_000, export_limit_w: 20_000 },
        // Its own rate rather than the shipped default, so the test says what
        // it depends on. At the default this fixture's overshoot is small
        // enough that crossing the threshold genuinely is worth it — the cost
        // of 2.8 kW over is 0.59 SEK against 1.04 SEK of extra value — and
        // full power is then the right answer, not a defect.
        policy: {
          ...base.policy,
          peak_shaping_sek_per_kwh_per_kw: 0.1,
        } as OptimisationSnapshot["policy"],
        // Hold valuation fixed so changed demand tests shaping, not curve derivation.
        value_curves: { battery: { unit: "kwh", points: [
          { at: 0, sek_per_unit: 2 }, { at: 17.176, sek_per_unit: 1 },
        ] } },
        battery: {
          ...base.battery!,
          capacity_kwh: 18.08,
          soc: 0.05,
          charge_max_w: 8_800,
        },
      }),
      new Date(NOW),
    );
    const window = plan.plans.priority.slots.slice(0, 48);
    const charging = window.filter((slot) => slot.battery_charge_w > 1);
    return {
      status: plan.status,
      peakChargeW: charging.length === 0
        ? 0
        : Math.max(...charging.map((slot) => slot.battery_charge_w)),
      peakImportW: Math.max(...window.map((slot) => slot.grid_import_w)),
      kwh: charging.reduce(
        (total, slot) => total + slot.battery_charge_w / 1_000 * 0.25,
        0,
      ),
    };
  };

  const quiet = atHouseLoad(500);
  const busy = atHouseLoad(4_000);

  assertEquals(quiet.status, "ready");
  assertEquals(busy.status, "ready");
  assert(quiet.peakChargeW > 0, "the battery has to charge in the quiet house");
  assert(busy.peakChargeW > 0, "and in the busy one");
  assert(
    busy.peakChargeW < quiet.peakChargeW,
    `a busier house leaves the battery less power at the same price: ` +
      `${busy.peakChargeW} W against ${quiet.peakChargeW} W`,
  );
  // Which is the point: what it gives way to is the total, so the busy home's
  // grid peak does not simply rise by the whole extra 3.5 kW of house.
  assert(
    busy.peakImportW - quiet.peakImportW < 3_500,
    `the peak absorbs some of the extra house load rather than all of it: ` +
      `${busy.peakImportW} W against ${quiet.peakImportW} W`,
  );
});

Deno.test("a soft battery reserve cannot inflate terminal value beyond replacement cost", () => {
  // A sunless horizon isolates the reserve from free capacity-filling solar.
  // Starting below a soft reserve stays feasible, and a requested reserve may
  // not invent a worst-hour premium on energy left after the horizon.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: hour >= 16 && hour < 21 ? 5_000 : 2_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 6 && hour < 9 ? 3.2 : hour >= 16 && hour < 20 ? 2.9 : 0.8)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const at = (reserve: number) => {
    const plan = generateOptimisationPlan(
      horizon({
        slots: dark,
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        outdoor_temperature_c: dark.map(() => -8),
        battery: { ...base.battery!, capacity_kwh: 18.08, soc: 0.1 },
        policy: { ...base.policy, terminal_soc_min: reserve },
        value_settings: { ...PRICED_WEAR, vehicle_fallback_sek_per_km: null },
      }),
      new Date(NOW),
    );
    return {
      status: plan.status,
      errors: plan.validation_errors,
      end: plan.plans.priority.summary.battery_soc_end,
      curve: plan.battery_value_curve,
    };
  };

  const none = at(0.05);
  const held = at(0.4);

  assertEquals(none.status, "ready");
  assertEquals(held.status, "ready");
  // Starting under the reserve is not a fault, and never was the plan's doing.
  assertEquals(held.errors, []);
  assert(
    held.end >= none.end - 1e-6,
    `a soft reserve may preserve energy without an artificial spike premium`,
  );

  // Publish both the requested reserve and the effective replacement cap.
  const curve = held.curve!;
  assert(
    curve.curve_input.reserve_kwh > 0,
    "the reserve reaches the curve in its own units",
  );
  assertAlmostEquals(
    curve.automatic_curve.points[0].sek_per_unit,
    curve.terminal_replacement_sek_per_kwh,
    0.02,
  );
  assertEquals(none.curve!.curve_input.reserve_kwh, 0);
});

Deno.test("§8.19 — the home's own wear cost reaches the curve", () => {
  // The column existed, the resolver existed, and `deriveBatteryValueCurve`
  // read the shipped constant instead — so the setting was configurable and
  // inert, and every home was priced against a figure nobody had chosen.
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const base = horizon();
  // A night trough and an evening peak: the shape wear is a threshold on.
  const dark = base.slots.map((slot, index) => {
    const hour = ((index / 4) + 10) % 24;
    return {
      ...slot,
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: 0,
      base_load_forecast_w: 1_500,
      import_price_sek_per_kwh: index < 96
        ? (hour >= 17 && hour < 21 ? 1.35 : 0.9)
        : null,
      export_price_sek_per_kwh: index < 96 ? 0.2 : null,
    };
  });
  const at = (settings?: { battery_degradation_sek_per_kwh: number }) =>
    generateOptimisationPlan(
      horizon({
        slots: dark,
        pool: { water_temperature_c: 30.9, volume_m3: 55 },
        outdoor_temperature_c: dark.map(() => 12),
        battery: { ...base.battery!, capacity_kwh: 18.08, soc: 0.1 },
        value_settings: settings
          ? { ...settings, vehicle_fallback_sek_per_km: null }
          : undefined,
      }),
      new Date(NOW),
    );

  const priced = at({ battery_degradation_sek_per_kwh: 0.45 });
  const cheap = at({ battery_degradation_sek_per_kwh: 0.05 });

  // What the home asked for is what the curve was built from, and it says so.
  assertEquals(
    priced.battery_value_curve!.curve_input.degradation_sek_per_kwh,
    0.45,
  );
  assertEquals(
    cheap.battery_value_curve!.curve_input.degradation_sek_per_kwh,
    0.05,
  );

  // And it is a decision, not a label. A 1.35 against 0.9 evening is a 50%
  // spread: through 0.45 of wear the round trip needs 66% and this evening is
  // refused, through 0.05 it needs 17% and the evening is taken. The dear plan
  // is not quite idle — the shaped prior past the published window is dearer
  // than anything quoted, and a little trades against that — so what is
  // asserted is the size of the gap and not a zero.
  const cycled = (plan: ReturnType<typeof generateOptimisationPlan>) =>
    plan.plans.priority.slots.reduce(
      (total, slot) => total + slot.battery_discharge_w,
      0,
    );
  assert(
    cycled(cheap) > cycled(priced) * 10,
    `lowering the threshold must open the evening up: ` +
      `${cycled(priced)} against ${cycled(cheap)}`,
  );

  // A home that has never had a row keeps whatever the product ships.
  assertEquals(
    at().battery_value_curve!.curve_input.degradation_sek_per_kwh,
    DEFAULT_VALUE_SETTINGS.battery_degradation_sek_per_kwh,
  );
});
