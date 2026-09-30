/** Explicit battery-terminal DC power; directional installation loss curves. */
import { z } from "zod";
const curve = z.object({
  gain: z.number().finite().positive().max(1),
  overhead_w: z.number().finite().min(0).max(10000),
}).strict();
export const conversionSchema = z.object({
  revision: z.string().min(1).max(128),
  grid_charge: curve,
  surplus_charge: curve,
  discharge: curve,
  idle_loss_w: z.number().finite().min(0).max(10000),
}).strict();
export interface Curve {
  gain: number;
  overhead_w: number;
}
export interface Conversion {
  revision: string;
  grid_charge: Curve;
  surplus_charge: Curve;
  discharge: Curve;
  idle_loss_w: number;
}
export const outputPower = (c: Curve, input: number) =>
  input > 0 ? Math.max(0, c.gain * input - c.overhead_w) : 0;
export const inputPower = (c: Curve, output: number) =>
  output > 0 ? (output + c.overhead_w) / c.gain : 0;
export const solarCapacity = (c: Conversion, pv: number, house: number) =>
  outputPower(c.surplus_charge, Math.max(0, pv - house));
export function chargeInputs(
  c: Conversion,
  dc: number,
  pv: number,
  house: number,
) {
  const solar = Math.min(dc, solarCapacity(c, pv, house));
  return {
    solar: inputPower(c.surplus_charge, solar),
    grid: inputPower(c.grid_charge, Math.max(0, dc - solar)),
  };
}
export function convertedFlows(
  c: Conversion,
  charge: number,
  discharge: number,
  pv: number,
  house: number,
) {
  const inputs = chargeInputs(c, charge, pv, house);
  // Preserve installation overhead when configured efficiency-only curves are
  // active. Fitted directional overhead already present in the flows counts
  // once, including discharge below the curve's clamped zero crossing.
  const chargeFixed = (inputs.solar > 0
    ? c.surplus_charge.overhead_w / c.surplus_charge.gain : 0) +
    (inputs.grid > 0 ? c.grid_charge.overhead_w / c.grid_charge.gain : 0);
  const dischargeFixed = discharge > 0 ? c.discharge.overhead_w : 0;
  const represented = chargeFixed + Math.min(dischargeFixed, c.discharge.gain * discharge);
  return {
    charge: inputs.solar + inputs.grid,
    solar: inputs.solar,
    discharge: outputPower(c.discharge, discharge),
    idle: Math.max(c.idle_loss_w, chargeFixed + dischargeFixed) - represented,
  };
}
export function gridPower(
  c: Conversion,
  charge: number,
  discharge: number,
  pv: number,
  house: number,
) {
  const f = convertedFlows(c, charge, discharge, pv, house);
  return house - pv + f.charge - f.discharge + f.idle;
}
