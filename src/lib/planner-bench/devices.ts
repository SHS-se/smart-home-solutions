/** The same meter identities are supplied to historical planners and the referee. */
export const BENCH_DEVICE_KEYS = {
  poolPump: "sensor.pool_pump_energy",
  poolHeater: "sensor.pool_heater_energy",
  ev: "sensor.car_charging_total_energy",
} as const;
export const BENCH_DEVICES = [
  { key: BENCH_DEVICE_KEYS.poolPump, name: "Pool pump", schedulable: true },
  { key: BENCH_DEVICE_KEYS.poolHeater, name: "Pool heater", schedulable: true },
  { key: BENCH_DEVICE_KEYS.ev, name: "Car charging", schedulable: true },
];
