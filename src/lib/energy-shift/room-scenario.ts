import {
  backgroundRateForSlot, roomTransition, SLOT_HOURS, stepRoom, type DynamicThermalZoneModel, type ThermalZoneModel,
} from '../../../supabase/functions/_shared/planner/models/room/thermal.ts';

export const HEATING_HOURS = 2;
export const SCENARIO_HOURS = 6;

interface Scenario {
  startC: number;
  outdoorC: number;
  houseC: number;
  heaterW: number;
}

export function projectRoomCycle(model: ThermalZoneModel, { startC, outdoorC, houseC, heaterW }: Scenario): number[] {
  const transition = roomTransition(model, {
    hours: SLOT_HOURS, outdoor_c: outdoorC, house_c: houseC,
    background_c_per_h: backgroundRateForSlot(model, 0, [0]),
  });
  let state = { temperature_c: startC, stored_heat_c: 0 };
  const temperatures = [startC];
  for (let hour = 0; hour < SCENARIO_HOURS; hour += SLOT_HOURS) {
    state = stepRoom(transition, state, hour < HEATING_HOURS ? heaterW : 0);
    temperatures.push(state.temperature_c);
  }
  return temperatures;
}

export function projectDoorwayImpact(
  receiver: DynamicThermalZoneModel,
  doorway: { weight: number; usual: number },
  sourceC: readonly number[],
  houseC: number,
): number[] {
  const indoor = receiver.house_coupling_per_h!;
  // Take the difference between identical receiver scenarios, changing only
  // its indoor boundary. The source room supplies the temperature path, so
  // there is no need to extrapolate a single observation with persistence.
  const { decay, offset_c } = roomTransition(receiver, {
    hours: SLOT_HOURS, outdoor_c: 0, house_c: 1, background_c_per_h: 0,
  });
  const response = offset_c * doorway.weight / indoor;
  let impact = 0;
  const values = [impact];
  for (let slot = 1; slot < sourceC.length; slot++) {
    const sourceMean = (sourceC[slot - 1] + sourceC[slot]) / 2;
    impact = decay * impact + response * (sourceMean - houseC - doorway.usual);
    values.push(impact);
  }
  return values;
}
