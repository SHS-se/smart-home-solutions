// Test helper: a bench series built from plan-like slots, for the stats and
// score tests. The bench itself gets its series from the referee (referee.ts).

import type { BenchSeries } from './types';

interface PlanSlotLike {
  start: string;
  duration_hours?: number;
  binding: boolean;
  import_price_sek_per_kwh: number | null;
  export_price_sek_per_kwh: number | null;
  shadow_import_sek_per_kwh?: number;
  shadow_export_sek_per_kwh?: number;
  pv_w: number;
  load_w: number;
  pool_w: number;
  boiler_expected_w: number;
  ev_w: number;
  ev_soc: number | null;
  ev_connected: boolean;
  battery_charge_w: number;
  battery_discharge_w: number;
  battery_export_w?: number;
  battery_soc: number;
  grid_import_w: number;
  grid_export_w: number;
}

const r1 = (value: number) => Math.round(value * 10) / 10;
const r4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * @param poolStateC the scorer's pool temperature trajectory: the start state
 *   followed by one value per quarter, or null when the plan has no pool model.
 */
export function planSeries(slots: readonly PlanSlotLike[], poolStateC: readonly number[] | null): BenchSeries {
  const price = (quoted: number | null, shadow: number | undefined) =>
    quoted !== null && Number.isFinite(quoted) ? quoted : shadow ?? 0;
  const out: BenchSeries = {
    start: [], hours: [], published: [], importPrice: [], exportPrice: [],
    solarW: [], loadW: [], poolW: [], hotWaterW: [], carW: [],
    gridImportW: [], gridExportW: [], batteryChargeW: [], batteryDischargeW: [], baseLoadBatteryCoverW: [],
    homeSoc: [], homeStartSoc: null, carSoc: [], carConnected: [], poolC: [], costSek: [],
  };
  slots.forEach((slot, i) => {
    const hours = slot.duration_hours ?? 0.25;
    const buy = price(slot.import_price_sek_per_kwh, slot.shadow_import_sek_per_kwh);
    const sell = price(slot.export_price_sek_per_kwh, slot.shadow_export_sek_per_kwh);
    out.start.push(slot.start);
    out.hours.push(r4(hours));
    out.published.push(slot.binding ? 1 : 0);
    out.importPrice.push(r4(buy));
    out.exportPrice.push(r4(sell));
    out.solarW.push(r1(slot.pv_w));
    out.loadW.push(r1(slot.load_w));
    out.poolW.push(r1(slot.pool_w));
    out.hotWaterW.push(r1(slot.boiler_expected_w));
    out.carW.push(r1(slot.ev_w));
    out.gridImportW.push(r1(slot.grid_import_w));
    out.gridExportW.push(r1(slot.grid_export_w));
    out.batteryChargeW.push(r1(slot.battery_charge_w));
    out.batteryDischargeW.push(r1(slot.battery_discharge_w + (slot.battery_export_w ?? 0)));
    out.baseLoadBatteryCoverW.push(0);
    out.homeSoc.push(Number.isFinite(slot.battery_soc) ? r1(slot.battery_soc * 100) : null);
    out.carSoc.push(slot.ev_soc === null ? null : r1(slot.ev_soc * 100));
    out.carConnected.push(slot.ev_connected ? 1 : 0);
    const temp = poolStateC?.[i + 1];
    out.poolC.push(temp === undefined || temp === null || !Number.isFinite(temp) ? null : Math.round(temp * 1000) / 1000);
    out.costSek.push(r4((slot.grid_import_w * buy - slot.grid_export_w * sell) * hours / 1_000));
  });
  return out;
}
