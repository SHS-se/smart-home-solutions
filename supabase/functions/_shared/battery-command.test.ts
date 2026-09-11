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
