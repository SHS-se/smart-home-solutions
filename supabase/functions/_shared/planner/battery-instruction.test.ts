import { assertEquals } from "jsr:@std/assert@1";
import { batteryDemand, instructionFor, nativeBattery, profileFor } from "./battery-instruction.ts";

const LIMITS = { import_w: 15000, discharge_max_w: 9600 };
const MODELS = [
  { key: "sensor.water_boiler_energy", name: "Water boiler", category: "hot_water" },
  { key: "sensor.car_charging_total_energy", name: "Car charging total", category: "ev_charging" },
  { key: "sensor.pool_heater_energy", name: "Pool heater", category: "pool_heating" },
];
const quarter = (charge_w = 0, discharge_w = 0) => ({ charge_w, discharge_w });

Deno.test("each native candidate is stated as the instruction HA executes", () => {
  // Independent synthetic allocations retain the scored integer request, even
  // when inventory saturation produces a slightly smaller reference flow.
  const sized = instructionFor({ battery: "supply_house", charge_limit_w: 8800, discharge_limit_w: 865 }, quarter(0, 864), "p", LIMITS);
  assertEquals(sized, { kind: "supply", profile_id: "p", charge_ac_limit_w: 8800, discharge_ac_limit_w: 9600,
    response: { mode: "fixed", discharge_ac_w: 865, import_target_w: 15000 } });
  assertEquals(instructionFor({ battery: "shave_import", charge_limit_w: 8800, discharge_limit_w: 9600 }, quarter(0, 600), "p", LIMITS),
    { kind: "supply", profile_id: "p", charge_ac_limit_w: 8800, discharge_ac_limit_w: 9600,
      response: { mode: "import_target", import_target_w: 15000 } });
  // Automatic supply follows demand even when the forecast says it discharges nothing.
  assertEquals(instructionFor({ battery: "self_consumption", charge_limit_w: 8800, discharge_limit_w: 9600 }, quarter(), "p", LIMITS).kind, "supply");
  assertEquals(instructionFor({ battery: "grid_charge", charge_limit_w: 6001, discharge_limit_w: 0 }, quarter(6000.7), "p", LIMITS),
    { kind: "grid_charge", charge_ac_w: 6001 });
  assertEquals(instructionFor({ battery: "export", charge_limit_w: 0, discharge_limit_w: 9600 }, quarter(), "p", LIMITS), { kind: "idle" });
});

Deno.test("a committed quarter rebuilds exactly the candidate it was chosen as", () => {
  for (const command of [
    { battery: "supply_house", charge_limit_w: 8800, discharge_limit_w: 864 },
    { battery: "shave_import", charge_limit_w: 8800, discharge_limit_w: 9600 },
    { battery: "self_consumption", charge_limit_w: 0, discharge_limit_w: 9600 },
    { battery: "hold", charge_limit_w: 8800, discharge_limit_w: 0 },
    { battery: "idle", charge_limit_w: 0, discharge_limit_w: 0 },
  ] as const) {
    assertEquals(nativeBattery(instructionFor(command, quarter(), "p", LIMITS)), command);
  }
});

Deno.test("the demand lists every planned load and the battery never supplies the car", () => {
  const demand = batteryDemand(MODELS, [true, false, undefined]);
  assertEquals(demand.loads.map((l) => l.key), MODELS.map((m) => m.key).sort());
  assertEquals(demand.profiles, [
    { id: profileFor(true), include_base: true, eligible_keys: ["sensor.pool_heater_energy", "sensor.water_boiler_energy"] },
    { id: profileFor(false), include_base: true, eligible_keys: ["sensor.pool_heater_energy"] },
  ]);
  assertEquals(batteryDemand(MODELS, [true]).profiles.length, 1);
});
