/** Explicit battery-terminal DC power; directional installation loss curves. */
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

/** Pure boundary check shared by device validation and the transport schema. */
export function validConversion(value: unknown): value is Conversion {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const curve = (v: unknown) => record(v) && Object.keys(v).length === 2
    && finite(v.gain) && v.gain > 0 && v.gain <= 1
    && finite(v.overhead_w) && v.overhead_w >= 0 && v.overhead_w <= 10000;
  return record(value) && Object.keys(value).length === 5
    && typeof value.revision === 'string' && value.revision.length > 0 && value.revision.length <= 128
    && curve(value.grid_charge) && curve(value.surplus_charge) && curve(value.discharge)
    && finite(value.idle_loss_w) && value.idle_loss_w >= 0 && value.idle_loss_w <= 10000;
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

/** AC allocation for an explicitly sized terminal DC purchase, solar first. */
export function chargeAcPower(c: Conversion, dc: number, pv: number, house: number): number {
  const inputs = chargeInputs(c, dc, pv, house);
  return inputs.solar + inputs.grid;
}

/** Exact inverse of chargeInputs, including an unproductive solar branch and
 * the grid branch's fixed activation overhead. */
export function chargeDcPower(c: Conversion, ac: number, pv: number, house: number): number {
  const solarDc = solarCapacity(c, pv, house);
  const solarAc = inputPower(c.surplus_charge, solarDc);
  if (solarDc === 0) return outputPower(c.grid_charge, ac);
  if (ac <= solarAc) return outputPower(c.surplus_charge, ac);
  return solarDc + outputPower(c.grid_charge, ac - solarAc);
}

export const dischargeDcPower = (c: Conversion, ac: number): number => inputPower(c.discharge, ac);

/** Source-independent automatic command ceilings. The physical projector
 * always enforces actual terminal ratings and stored headroom. */
export function batteryAcCeilings(b: RefinedBattery) {
  const c = b.conversion;
  return { charge_w: b.charge_max_w / Math.min(c.grid_charge.gain, c.surplus_charge.gain)
      + c.grid_charge.overhead_w / c.grid_charge.gain + c.surplus_charge.overhead_w / c.surplus_charge.gain,
    discharge_w: outputPower(c.discharge, b.discharge_max_w) };
}

/** Ratings are terminal DC; the ratios describe terminal ↔ stored energy only. */
export interface RefinedBattery {
  capacity_kwh: number;
  min_soc: number;
  max_soc: number;
  charge_max_w: number;
  discharge_max_w: number;
  charge_efficiency: number;
  discharge_efficiency: number;
  conversion: Conversion;
}

export function batteryAcLimits(b: RefinedBattery, stored: number, hours: number, pv: number, house: number) {
  const chargeDc = Math.min(b.charge_max_w, Math.max(0, b.max_soc * b.capacity_kwh - stored) * 1000 / hours / b.charge_efficiency);
  const dischargeDc = Math.min(b.discharge_max_w, Math.max(0, stored - b.min_soc * b.capacity_kwh) * 1000 / hours * b.discharge_efficiency);
  return { charge_w: chargeAcPower(b.conversion, chargeDc, pv, house), discharge_w: outputPower(b.conversion.discharge, dischargeDc) };
}

/** The same installation law as the native planner and Python executor. */
export function refinedBatteryFlow(b: RefinedBattery, request: {
  stored_kwh: number; hours: number; charge_w: number; discharge_w: number; pv_w: number; house_w: number;
}) {
  const { stored_kwh: stored, hours, pv_w: pv, house_w: house } = request;
  const wantedCharge = Math.min(b.charge_max_w, chargeDcPower(b.conversion, request.charge_w, pv, house));
  const wantedDischarge = Math.min(b.discharge_max_w, dischargeDcPower(b.conversion, request.discharge_w));
  const ceiling = Math.max(b.max_soc * b.capacity_kwh, stored), floor = Math.min(b.min_soc * b.capacity_kwh, stored);
  const charge = Math.min(wantedCharge, (ceiling - stored) * 1000 / hours / b.charge_efficiency
    + wantedDischarge / (b.charge_efficiency * b.discharge_efficiency));
  const discharge = Math.min(wantedDischarge, (stored - floor) * 1000 / hours * b.discharge_efficiency
    + charge * b.charge_efficiency * b.discharge_efficiency);
  const f = convertedFlows(b.conversion, charge, discharge, pv, house);
  return { charge_w: f.charge, discharge_w: f.discharge, charge_dc_w: charge, discharge_dc_w: discharge,
    battery_idle_w: f.idle, battery_kwh: stored + hours / 1000 * (charge * b.charge_efficiency - discharge / b.discharge_efficiency) };
}

/** Terminal inventory is valued at rated grid-refill power. This is a stated
 * economic convention; forward physics always uses the actual power/source. */
export function gridKwhPerStoredKwh(b: Pick<RefinedBattery, 'conversion' | 'charge_max_w' | 'charge_efficiency'>): number {
  return inputPower(b.conversion.grid_charge, b.charge_max_w) / (b.charge_max_w * b.charge_efficiency);
}
