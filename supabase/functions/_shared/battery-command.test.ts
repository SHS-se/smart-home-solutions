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
  assertEquals(batteryCommand(input), {schema_version: 2, operation: "solar_charge",
    charge_limit_w: 8800, discharge_limit_w: 0,
    allow_grid_charge: false, allow_battery_export: false});
  const grid = batteryCommand({...input, pvW: 0});
  assertEquals(grid.operation, "grid_charge");
  assertEquals(grid.charge_limit_w, 523.94);
  assertEquals(grid.allow_grid_charge, true);
  const supply = batteryCommand({...input, pvW: 0, chargeW: 0, dischargeW: 2712});
  assertEquals(supply.operation, "supply_house");
  assertEquals(supply.discharge_limit_w, 2712);
  assertEquals(supply.charge_limit_w, 0);
});
