// The household every bench test case is planned for, and what its owner
// wants (docs/planner-bench/test-cases.md).
//
// Numbers only: no physics, no money and no value curves. What a device does
// with its numbers is the planner's device models
// (supabase/functions/_shared/planner/device-models.ts), which the referee
// (referee.ts) steps for every planner version alike. The owner's wish is one
// number per store; a planner works its curves out from a case's prices,
// solar, temperature and history together with those targets.
//
// Changing either constant changes every result's input, so every result is
// run again. Adding a test case changes neither.

import { parseDeviceModels, type DeviceModels } from '../../../supabase/functions/_shared/planner/device-models';
import type { Targets } from './case';

export interface Household extends DeviceModels {
  site: {
    /** Nord Pool bidding zone the home buys in. */
    market_area: string;
    import_limit_w: number;
    export_limit_w: number;
    battery_export_enabled: boolean;
    battery_export_reserve_soc: number;
    battery_export_min_price_sek_per_kwh: number;
    battery_degradation_sek_per_kwh: number;
    /** State of charge the battery should not end the horizon below. */
    battery_terminal_soc_min: number;
  };
}

export const HOUSEHOLD: Household = {
  site: {
    market_area: "SE3", import_limit_w: 13_200, export_limit_w: 13_200,
    battery_export_enabled: true, battery_export_reserve_soc: 0.8, battery_export_min_price_sek_per_kwh: 2.5,
    battery_degradation_sek_per_kwh: 0.05, battery_terminal_soc_min: 0.2,
  },
  ...parseDeviceModels({
    battery: {
      capacity_kwh: 18.08, min_soc: 0.05, max_soc: 1,
      charge_max_w: 8_800, discharge_max_w: 9_600, charge_efficiency: 0.95, discharge_efficiency: 0.95,
    },
    car: {
      battery: { capacity_kwh: 75.6, kwh_per_km: 0.16, charge_efficiency: 0.92 },
      charger: { voltage_v: 230, phase_count: 3, min_current_a: 5, max_current_a: 16, current_step_a: 1 },
    },
    pool: {
      // 55 m³ of water. It loses its heat to the room and the ground around it, not to the weather: the
      // home's pool lost 2 to 3 kW at 30 °C on days of 13 °C and of 25 °C alike.
      store: { capacity_kwh_per_c: 63.965, loss: { kind: 'linear', kw_per_c: 0.13, surroundings_c: 13.5 } },
      heater: {
        // The home's ground-source heat pump heating the pool, as measured in September 2026 at the four
        // settings it has run at: compressor electricity in, heat out. Rounded figures from two weeks of
        // readings, taken as the bench's own. It runs at the setting the house runs at now.
        setting_unit: 'kw_thermal', control: 'switch', selected_setting: 12,
        operating_points: [
          { setting: 6, electric_w: 1_250, heat_w: 5_875 },
          { setting: 8, electric_w: 1_650, heat_w: 7_755 },
          { setting: 10, electric_w: 2_250, heat_w: 10_520 },
          { setting: 12, electric_w: 3_000, heat_w: 12_450 },
        ],
        // The circulation pump: it must run with the heat pump and heats nothing.
        auxiliary_w: 764,
      },
    },
  }),
};

/** Pool 30 °C, car 300 km. A case may override either. */
export const TARGETS: Targets = { pool_c: 30, ev_km: 300 };
