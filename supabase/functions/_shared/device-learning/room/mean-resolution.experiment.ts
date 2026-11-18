/** Independently generated synthetic falsification experiment, not a contract
 * asserting that today's biased coefficients are correct. Run with `deno run`.
 * A thermostat can switch within an hourly Recorder interval. Its real energy
 * and mean temperature do not necessarily equal the constant-mean-power
 * trajectory assumed by the learning operator. A family-selection score does
 * not repair that missing timing information or establish physical truth.
 */
import { fitIndependentRoomBand, type RoomMeanQuarter } from "./mean-observations.ts";

function closedLoop(timeConstant: number, quantization: "sensor" | "hour"): RoomMeanQuarter[] {
  let temperature = 20, on = false;
  const rows: RoomMeanQuarter[] = [], exchange = 1 / timeConstant;
  for (let i = 0; i < 30; i++) {
    const house = 21 + .3 * Math.sin(i / 7), outdoor = -5 + 2 * Math.sin(i / 5);
    let room = 0, energy = 0;
    for (let second = 0; second < 3600; second++) {
      if (temperature < 19.8) on = true;
      if (temperature > 20.2) on = false;
      const power = on ? 1500 : 0;
      const rate = .0015 * power + .4 * exchange * (house - temperature) + .6 * exchange * (outdoor - temperature);
      const midpoint = temperature + rate / 7200;
      room += quantization === "sensor" ? Math.round(midpoint * 10) / 10 : midpoint;
      energy += power;
      temperature += rate / 3600;
    }
    rows.push({ start_ms: i * 3600000, duration_s: 3600,
      room_c: quantization === "hour" ? Math.round(room / 3600 * 10) / 10 : room / 3600,
      house_c: house, outdoor_c: outdoor, heat_w: energy / 3600, cooling: false, solar_w_per_m2: null });
  }
  return rows;
}

if (import.meta.main) for (const timeConstant of [10, 30]) for (const quantization of ["sensor", "hour"] as const) {
  const result = fitIndependentRoomBand(closedLoop(timeConstant, quantization), () => true).result;
  console.log(JSON.stringify({ synthetic: true, true_time_constant_h: timeConstant, true_gain_c_per_kwh: 1.5,
    quantization, result }));
}
