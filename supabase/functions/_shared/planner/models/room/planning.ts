import type { ConnectedRoomResponse } from "./connected-exchange.ts";

/** Provenance of the captured response, independent of response selection policy. */
export type RoomResponseSource =
  | { kind: "shared"; revision: string }
  | { kind: "general"; revision: string | number | null }
  | { kind: "band"; band_c: number; revision: string };

import type { PassiveRoomHeat, ThermalZoneModel } from "./thermal.ts";

/** Current inventory joined to a captured model; never stored in the forecast product. */
export interface PreparedRoom {
  connected_exchange?: ConnectedRoomResponse;
  key: string;
  name: string;
  device_keys: string[];
  model: ThermalZoneModel | null;
  model_warnings?: string[];
  /** The one response used at every quarter, and where it came from. */
  model_source?: RoomResponseSource;
  passive_heat?: PassiveRoomHeat;
  rated_power_w: number;
  maximum_power_w_by_slot: number[];
}
