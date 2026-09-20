import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { batteryCommand } from "./battery-command.ts";

Deno.test("source and destination produce distinct executable operations", () => {
  const base = {
    baseline: false,
    loadW: 3000,
    pvW: 0,
    chargeMaxW: 8800,
    dischargeMaxW: 9600,
    exportEnabled: true,
  };
  const cases = [
    [{ chargeW: 0, dischargeW: 0 }, "hold"],
    [{ chargeW: 2000, dischargeW: 0 }, "grid_charge"],
    [{ chargeW: 2000, dischargeW: 0, pvW: 6000 }, "solar_charge"],
    [{ chargeW: 0, dischargeW: 2000 }, "supply_house"],
    [{ chargeW: 0, dischargeW: 5000 }, "export"],
    [{ chargeW: 0, dischargeW: 0, baseline: true }, "self_consumption"],
  ] as const;
  for (const [flows, operation] of cases) {
    const command = batteryCommand({ ...base, ...flows });
    assertEquals(command.operation, operation);
    assertEquals(command.allow_grid_charge, operation === "grid_charge");
    assertEquals(command.allow_battery_export, operation === "export");
  }
  assertThrows(
    () =>
      batteryCommand({
        ...base,
        exportEnabled: false,
        chargeW: 0,
        dischargeW: 5000,
      }),
    Error,
    "not authorized",
  );
});

Deno.test("solar capture permits rated charging while grid replenishment retains its ceiling", () => {
  const input = {baseline: false, loadW: 2712.6, pvW: 3236.54,
    chargeW: 523.94, dischargeW: 0, chargeMaxW: 8800, dischargeMaxW: 9600,
    exportEnabled: false};
  assertEquals(batteryCommand(input), {schema_version: 3, operation: "solar_charge",
    charge_limit_w: 8800, discharge_limit_w: 0,
    allow_grid_charge: false, allow_battery_export: false});
  const grid = batteryCommand({...input, pvW: 0});
  assertEquals(grid.operation, "grid_charge");
  assertEquals(grid.charge_limit_w, 523.94);
  assertEquals(grid.allow_grid_charge, true);
  const supply = batteryCommand({...input, pvW: 0, chargeW: 0, dischargeW: 2712});
  assertEquals(supply.operation, "supply_house");
  assertEquals(supply.discharge_limit_w, 2712);
  // Supplying the house caps what leaves the pack, never what a sunny minute
  // inside the quarter may put back into it.
  assertEquals(supply.charge_limit_w, 8800);
});


Deno.test("full household supply follows actual deficit while partial allocations remain capped", () => {
  // 15 September 17:30 capture: 405.60 W was predicted, but actual demand
  // exceeded it. Predicted flow must not become a load-following ceiling.
  const input = {baseline: false, loadW: 833.16, pvW: 427.56,
    chargeW: 0, dischargeW: 405.6, chargeMaxW: 8800, dischargeMaxW: 9600,
    exportEnabled: false};
  const command = batteryCommand(input);
  assertEquals(command, {schema_version: 3, operation: "supply_house",
    charge_limit_w: 8800, discharge_limit_w: 9600,
    allow_grid_charge: false, allow_battery_export: false});
  // Serialization rounds the allocation to 0.01 W, but inputs may be unrounded.
  assertEquals(batteryCommand({...input, loadW: 833.164}).discharge_limit_w, 9600);
  assertEquals(batteryCommand({...input, loadW: 833.156}).operation, "supply_house");
  for (const [loadW, pvW, dischargeW, ceiling] of [
    [3000, 0, 2000, 2000], // deliberate import: preserve the economic allocation
    [12000, 0, 9600, 9600], // power limited: cannot exceed battery rating
    [833.16, 427.56, 0, 0], // hold is not inferred as permission to supply
    [3000, 4000, 0, 0], // no forecast deficit creates no discharge permission
  ]) {
    assertEquals(batteryCommand({...input, loadW, pvW, dischargeW}).discharge_limit_w, ceiling);
  }
  const exported = batteryCommand({...input, dischargeW: 1000, exportEnabled: true});
  assertEquals(exported.operation, "export");
  assertEquals(exported.discharge_limit_w, 1000);
});


Deno.test("only a completed export comparison closes the charge permission", () => {
  // The dispatcher answers two questions per quarter. Declining to spend stored
  // energy is not a decision to send this quarter's surplus to the grid.
  const base = {
    baseline: false,
    chargeW: 0,
    dischargeW: 0,
    loadW: 800,
    pvW: 1250,
    chargeMaxW: 8800,
    dischargeMaxW: 9600,
    exportEnabled: false,
  };
  const held = batteryCommand(base);
  assertEquals(held.operation, "hold");
  assertEquals(held.charge_limit_w, 8800);
  assertEquals(held.discharge_limit_w, 0);
  const forgone = batteryCommand({ ...base, forgoSurplus: true });
  assertEquals(forgone.operation, "idle");
  assertEquals(forgone.charge_limit_w, 0);
  assertEquals(forgone.discharge_limit_w, 0);
  assertEquals(forgone.allow_grid_charge, false);
  assertEquals(forgone.allow_battery_export, false);
  // A sized purchase or sale keeps the ceiling the planner chose.
  assertEquals(
    batteryCommand({ ...base, pvW: 0, chargeW: 2000, forgoSurplus: true })
      .charge_limit_w,
    2000,
  );
  assertEquals(
    batteryCommand({
      ...base,
      dischargeW: 5000,
      exportEnabled: true,
      forgoSurplus: true,
    }).charge_limit_w,
    0,
  );
});
