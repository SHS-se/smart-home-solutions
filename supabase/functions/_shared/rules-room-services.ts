import type { RoomNetworkWork } from "./room-network-contract.ts";
import { prepareConnectedRoomStage, advanceConnectedRoomBarrier, compileConnectedRoomForecast, compileConnectedRoomCatalog, proposalDependencies, type ConnectedRoomCatalog, type ConnectedRoomProposalNetwork, type ConnectedRoomForecastRequest } from "./rules-connected-room-services.ts";
import type { RoomHeatingPlan } from "./room-heating-schedule.ts";
import { compileRoomSchedule, storeRoomCommands, electricalSource, schedulableRoomThermostat } from "./room-scheduling-inputs.ts";
import { roomHeater, roomHeaterState, roomHeaterCommand, roomHeaterDraw } from "./planner/room-heater.ts";
import { heatingModelRuns, type RoomHeatingModelUse } from "./planner/heating-bands.ts";
import { connectedRoomHeaterSupported, roomResponseEvidenceLimited } from "./planner/room-response.ts";
import { PlanningError, PlanningInputError } from "./planning-errors.ts";
import type { OptimisationSnapshot } from "./planner/planning-contracts.ts";
import type { DeviceCommand } from "./planner/device-commands.ts";
import { heaterResponse, isEquilibrium, usesHouse } from "./planner/models/room/thermal.ts";
import { planningWarning, type PlanningWarning } from "./planner/planning-warnings.ts";
import { projectThermostatQuarter, type ThermostatRoomState } from "./planner/thermostat.ts";
import { MAX_ROOM_RELAYS, planRoomHeating } from "./room-heating-schedule.ts";
import { commandOwner, unavailableOwner } from "./rules-commitments.ts";
import type { PlanningTrace } from "./planning-trace.ts";

export interface RoomServices {
  commands: Record<string, DeviceCommand[]>;
  power: Record<string, number[]>;
  room_power: Record<string, number[]>;
  temperature: Record<string, Array<number | null>>;
  unplanned_temperature: Record<string,Array<number|null>>;
  unplanned_power: Record<string, number[]>;
  expected_shortfall_c?: Record<string,number[]>;
  unplanned_expected_shortfall_c?: Record<string,number[]>;
  warnings: PlanningWarning[];
  heating_model_use?: Record<string, RoomHeatingModelUse>;
  network_forecast?: import("./planner/models/room/network.ts").ConnectedRoomForecastIdentity;
}

/** Marginal electricity prices before the household solve, per quarter. */
export interface RoomPrices {
  import_sek_per_kwh: number[];
  export_sek_per_kwh: number[];
  /** Forecast solar left after base, boiler and other fixed loads. */
  surplus_w: number[];
}

export interface RoomPlanningInputs {
  snapshot: OptimisationSnapshot;
  proposal_network?: ConnectedRoomProposalNetwork;
  retained: Retained;
  headroom?: number[];
  prices?: RoomPrices;
}

/** Intermediate state belongs to one immutable captured snapshot. */
export interface RoomPreparationProgress {
  snapshot_id: string;
  next_room: number;
  services: RoomServices;
  network_plans?: Record<string,RoomHeatingPlan>;
  network_disabled_keys?: string[];
  network_work?: RoomNetworkWork;
  /** Ordered proposals are complete; whole-network compilation owns the next bounded action. */
  forecast_pending?: true;
}

export function prepareRoomServices(snapshot: OptimisationSnapshot, retained: Retained = [], headroom?: number[], prices?: RoomPrices, trace?: PlanningTrace): RoomServices {
  const inputs={snapshot,retained,headroom,prices};
  let progress=prepareRoomBatch(inputs,trace,null,Infinity);
  while(progress.network_work || progress.forecast_pending)progress=prepareRoomBatch(inputs,trace,progress,Infinity);
  return progress.services;
}

/** Local bounded execution includes the same final forecast used by hosted jobs. */
export function prepareRoomBatch(inputs: RoomPlanningInputs, trace?: PlanningTrace,
  previous: RoomPreparationProgress | null = null, limit = 1): RoomPreparationProgress {
  return advanceRoomPreparation(inputs, trace, previous, limit, "evaluate");
}

/** Hosted preparation hands the final numerical problem to its durable owner.
 * This changes where work pauses, never the proposal or qualification policy. */
export function prepareRoomProposals(inputs: RoomPlanningInputs, trace?: PlanningTrace,
  previous: RoomPreparationProgress | null = null, limit = 1): { progress: RoomPreparationProgress; forecast?: ConnectedRoomForecastRequest } {
  const { captured_forecast, ...progress } = advanceRoomPreparation(inputs, trace, previous, limit, "capture");
  return { progress, ...(captured_forecast ? { forecast: captured_forecast } : {}) };
}

export function prepareOwnedRoomProposals(inputs: RoomPlanningInputs, previous: RoomPreparationProgress | null, trace?: PlanningTrace) {
  const { catalog, ...progress } = advanceRoomPreparation(inputs, trace, previous, 1, "catalog");
  return { progress, catalog };
}

/** Process the next room in the same order as local preparation. */
function advanceRoomPreparation(inputs: RoomPlanningInputs,
  trace: PlanningTrace | undefined, previous: RoomPreparationProgress | null, limit: number,
  completion: "evaluate" | "capture" | "catalog"): RoomPreparationProgress & { captured_forecast?: ConnectedRoomForecastRequest; catalog?: ConnectedRoomCatalog } {
  const { snapshot, retained, headroom, prices } = inputs;
  const roomNetwork = inputs.proposal_network ?? snapshot.room_network;
  const zones = snapshot.thermal_zones ?? [];
  const start = previous?.next_room ?? 0;
  const n = snapshot.slots.length;
  if (previous && (previous.snapshot_id !== snapshot.snapshot_id || !Number.isInteger(start) || start <= 0 || start > zones.length || start === zones.length && !previous.network_work && !previous.forecast_pending)) {
    throw new PlanningInputError("Room preparation continuation does not match the captured snapshot");
  }
  if(previous?.forecast_pending && (previous.forecast_pending !== true || start !== zones.length || previous.network_work || !roomNetwork)) {
    throw new PlanningInputError("Forecast compilation continuation does not match completed proposals");
  }
  const result: RoomServices = previous?.services ?? {
    commands: {}, power: {}, room_power: {}, temperature: {}, unplanned_temperature: {}, unplanned_power: {}, warnings: [],
  };
  let networkPlans = previous?.network_plans;
  const disabled = new Set(previous?.network_disabled_keys ?? []);
  const shared = snapshot.schema_version >= 12;
  const remaining = headroom?.slice() ?? snapshot.slots.map(() => Infinity);
  const surplus = prices?.surplus_w.map(w => Math.max(0, w)) ?? snapshot.slots.map(() => 0);
  // Reconstruct the budgets in the same subtraction order as a local solve.
  // Carrying just completed service results avoids a second source of truth.
  for (const zone of zones.slice(0, start)) {
    const watts = result.room_power[zone.key];
    if (!Array.isArray(watts) || watts.length !== n || !watts.every(Number.isFinite)) {
      throw new PlanningInputError("Room preparation continuation is missing completed demand");
    }
    for (let i = 0; i < n; i++) {
      remaining[i] = Math.max(0, remaining[i] - watts[i]);
      surplus[i] = Math.max(0, surplus[i] - watts[i]);
    }
  }
  const resetConnected=(keys:string[],error:unknown,completed:Zone[])=>{
    const affected=new Set(keys);
    for(;;){const before=affected.size;
      for(const node of roomNetwork?.nodes??[])for(const from of proposalDependencies(node)){
        if(affected.has(node.key)||affected.has(from)){affected.add(node.key);affected.add(from);}
      }
      if(affected.size===before)break;
    }
    for(const key of affected){disabled.add(key);if(networkPlans)delete networkPlans[key];}
    for(let i=0;i<n;i++){remaining[i]=headroom?.[i]??Infinity;surplus[i]=prices?.surplus_w[i]??0;}
    for(const prepared of completed){
      if(affected.has(prepared.key)){
        result.warnings=result.warnings.filter(w=>w.scope!==prepared.key);
        prepareEmpiricalRoom(snapshot,{...prepared,model:null},retained,remaining,surplus,result);
        result.warnings.push(planningWarning("room_evidence_unavailable",prepared.key,`${prepared.name}: the connected thermal commands could not be certified.`,
          "The affected rooms keep comfort instructions and measured electrical demand; other services continue.",{reason:error instanceof Error?error.message:String(error)}));
      }else for(let i=0;i<n;i++){remaining[i]=Math.max(0,remaining[i]-(result.room_power[prepared.key]?.[i]??0));surplus[i]=Math.max(0,surplus[i]-(result.room_power[prepared.key]?.[i]??0));}
    }
  };
  const next_room = Math.min(start + limit, zones.length);
  for (const zone of zones.slice(start, next_room)) {
    const complete = trace?.start("room_scheduling", { room_key: zone.key, slots: n });
    const members = snapshot.device_models.filter(m => zone.device_keys.includes(m.key));
    const relays = members.filter(m => m.control_type === "switch_schedule");
    if (shared) relays.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const thermostats = members.filter(m => m.control_type === "setpoint");
    let network: Record<string,RoomHeatingPlan> | undefined;
    try {
      if (!disabled.has(zone.key)) network=prepareConnectedRoomStage(inputs,zone,result,networkPlans,disabled,trace);
    } catch(error) {
      resetConnected([zone.key],error,zones.slice(0,zones.indexOf(zone)+1));
      complete?.();continue;
    }
    if (network) {
      networkPlans = network;
      // A later room can change any earlier thermostat's demand. Reconstruct
      // the whole ordered ledger from the authoritative joint replay.
      for (let i = 0; i < n; i++) {
        const used = zones.slice(0, zones.indexOf(zone) + 1).reduce((sum, room) => sum + (result.room_power[room.key]?.[i] ?? 0), 0);
        remaining[i] = Math.max(0, (headroom?.[i] ?? Infinity) - used);
        surplus[i] = Math.max(0, (prices?.surplus_w[i] ?? 0) - used);
      }
      complete?.();
      continue;
    }
    const temperature = zone.start_temperature_c;
    let comfortMisses = 0;
    result.room_power[zone.key] = [];
    result.temperature[zone.key] = [];
    result.unplanned_temperature[zone.key]=[];
    result.unplanned_power[zone.key]=[];
    for (const member of [...relays, ...thermostats]) {
      result.commands[member.key] = [];
      result.power[member.key] = [];
    }
    const outdoorKnown = snapshot.outdoor_temperature_c?.length === n &&
      snapshot.outdoor_temperature_c.every(v => typeof v === "number" && Number.isFinite(v));
    // A room coupled to the house cannot be run forward without it.
    const houseKnown = !zone.model || !usesHouse(zone.model) || (snapshot.house_temperature_c?.length === n &&
      snapshot.house_temperature_c.every(v => typeof v === "number" && Number.isFinite(v)));
    const executionUnknown = members.some(m => snapshot.slots.some(slot => unavailableOwner(snapshot, commandOwner(snapshot, m), slot.start)));
    const connectedModel=roomNetwork?.nodes.find(node=>node.key===zone.key)?.model;
    const limitedFit = roomResponseEvidenceLimited(zone.model_warnings) || !!connectedModel && !connectedRoomHeaterSupported(connectedModel);
    if (!disabled.has(zone.key) && !limitedFit && !executionUnknown && relays.length + thermostats.length && members.length <= MAX_ROOM_RELAYS && zone.model && !isEquilibrium(zone.model) && temperature !== null &&
      outdoorKnown && houseKnown && members.every(m => roomHeater(m) !== null) && thermostats.every(m => schedulableRoomThermostat(m, snapshot.operating_scope) && (m.active_power_w ?? 0) > 0) && heaterResponse(zone.model) >= 0 && (isEquilibrium(zone.model) || zone.model.cooling_constant_per_h >= 0)) {
      const scheduled = scheduleRoom(snapshot, zone, thermostats, relays, retained, remaining, surplus, prices, result, trace);
      comfortMisses=scheduled.misses;
      if(roomNetwork)networkPlans={...networkPlans,[zone.key]:scheduled.plan};
      if (comfortMisses) result.warnings.push(shortfall(zone, comfortMisses));
      complete?.();
      continue;
    }
    prepareEmpiricalRoom(snapshot, disabled.has(zone.key) ? {...zone,model:null} : zone, retained, remaining, surplus, result,
      !disabled.has(zone.key) && !!connectedModel && limitedFit);
    complete?.();
  }
  let networkWork:RoomNetworkWork|undefined, capturedForecast:ConnectedRoomForecastRequest|undefined, catalog:ConnectedRoomCatalog|undefined;
  // Whole-network compilation and catalog materialization must not share the
  // final room's bounded CPU request. Unbounded local execution uses the same
  // operations directly; the marker only records the durable pause boundary.
  const forecastPending=next_room===zones.length && !!roomNetwork && Number.isFinite(limit) && start<zones.length;
  if(next_room===zones.length && roomNetwork && !forecastPending){
    try {
      if (completion === "catalog") catalog=compileConnectedRoomCatalog(inputs,result,networkPlans,disabled);
      else if (completion === "capture") capturedForecast=compileConnectedRoomForecast(inputs,result,networkPlans,disabled);
      else networkWork=advanceConnectedRoomBarrier(inputs,result,networkPlans,disabled,previous?.network_work,trace,Number.isFinite(limit)&&start<zones.length);
    }
    catch(error){
      if (error instanceof PlanningError && error.code === "planner_upgraded") throw error;
      resetConnected(roomNetwork.nodes.filter(node=>!disabled.has(node.key)).map(node=>node.key),error,zones);
    }
  }
  return {snapshot_id: snapshot.snapshot_id, next_room, services: result, ...(networkPlans ? {network_plans: networkPlans} : {}), ...(disabled.size ? {network_disabled_keys:[...disabled]} : {}), ...(networkWork?{network_work:networkWork}:{}), ...(capturedForecast?{captured_forecast:capturedForecast}:{}), ...(catalog?{catalog}:{}), ...(forecastPending?{forecast_pending:true as const}:{})};
}

export type Zone = NonNullable<OptimisationSnapshot["thermal_zones"]>[number];
export type Member = OptimisationSnapshot["device_models"][number];
export type Retained = Array<{ device_commands?: Record<string, DeviceCommand>; device_loads_w?: Record<string, number> }>;


const shortfall = (zone: Zone, quarters: number) => planningWarning("comfort_shortfall", zone.key,
  `${zone.name}: ${quarters} quarters may be outside the requested comfort band.`,
  "The best attainable room schedule is included and household planning continues.", { quarters });

/** Native target actions and the resulting demand are solved together. */
function scheduleRoom(snapshot: OptimisationSnapshot, zone: Zone, members: Member[], relays: Member[],
  retained: Retained, remaining: number[], surplus: number[],
  prices: RoomPrices | undefined, result: RoomServices, trace?: PlanningTrace): {misses:number;plan:RoomHeatingPlan} {
  const n = snapshot.slots.length;
  const { quarters, controlled, interval_heaters } = compileRoomSchedule(snapshot, zone, [...members, ...relays], retained, remaining, surplus, prices, result);
  const plan = planRoomHeating(zone.start_temperature_c!, [], quarters, zone.start_stored_heat_c ?? 0, trace, interval_heaters);
  storeRoomCommands(result, controlled, retained, plan, quarters);
  let misses = 0, previousC = zone.start_temperature_c!;
  let unplanned: ThermostatRoomState = { temperature_c: zone.start_temperature_c!, stored_heat_c: zone.start_stored_heat_c ?? 0, heating_mask: 0 };
  for (let i = 0; i < n; i++) {
    const q = quarters[i];
    let baselineRelayW = 0;
    for (let j = 0; j < controlled.length; j++) {
      const fixed = q.fixed_relays[j];
      const on = fixed ?? (unplanned.temperature_c < zone.target_c[i] && baselineRelayW + q.relay_w[j] <= q.maximum_w);
      if (on) baselineRelayW += q.relay_w[j];
    }
    const baseline = projectThermostatQuarter(q, [], unplanned, [], baselineRelayW);
    unplanned = baseline.state;
    result.unplanned_temperature[zone.key].push(unplanned.temperature_c);
    result.unplanned_power[zone.key].push(baselineRelayW + baseline.thermostat_w.reduce((a, b) => a + b, 0));
    result.room_power[zone.key].push(plan.power_w[i]);
    result.temperature[zone.key].push(plan.temperature_c[i]);
    if (plan.shortfall_c[i] > 1e-6 || plan.temperature_c[i] > Math.max(zone.comfort_max_c[i], previousC) + 1e-6) misses++;
    previousC = plan.temperature_c[i];
    remaining[i] = Math.max(0, remaining[i] - plan.power_w[i]);
    surplus[i] = Math.max(0, surplus[i] - plan.power_w[i]);
  }
  return {misses,plan};
}

function prepareEmpiricalRoom(snapshot: OptimisationSnapshot, zone: Zone, retained: Retained,
  remaining: number[], surplus: number[], result: RoomServices, unconfirmedPeerHeat = false) {
  const n=snapshot.slots.length;
  const members=snapshot.device_models.filter(member=>zone.device_keys.includes(member.key));
  const limitedFit=roomResponseEvidenceLimited(zone.model_warnings);
  const offThermostat = members.some(m => m.control_type === "setpoint" && m.thermostat?.hvac_action === "off" &&
    !schedulableRoomThermostat(m, snapshot.operating_scope));
  const empiricalBaseline = limitedFit || offThermostat;
  const outdoorKnown=snapshot.outdoor_temperature_c?.length===n && snapshot.outdoor_temperature_c.every(Number.isFinite);
  if(result.expected_shortfall_c)delete result.expected_shortfall_c[zone.key];
  if(result.unplanned_expected_shortfall_c)delete result.unplanned_expected_shortfall_c[zone.key];
  result.room_power[zone.key]=[];result.temperature[zone.key]=[];result.unplanned_temperature[zone.key]=[];result.unplanned_power[zone.key]=[];
  for(const member of members){result.commands[member.key]=[];result.power[member.key]=[];}
  // Incomplete native/thermal evidence is an estimate, not an ideal heater.
  // Keep existing comfort intent and empirical electrical demand, without
  // inventing temperatures or an unseen thermostat's duty cycle.
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (const m of members) {
      const locked = retained[i]?.device_commands?.[m.key];
      if (unavailableOwner(snapshot, commandOwner(snapshot, m), snapshot.slots[i].start)) {
        result.commands[m.key].push({type: "unavailable", reason: "Equipment execution is unavailable until recovery is observed"});
        // An unavailable actuator can still be drawing power under its last
        // setting. Preserve measured demand; do not credit unconfirmed heat.
        const watts = m.forecast_w_by_slot[i];
        result.power[m.key].push(watts); total += watts;
        continue;
      }
      const heater = roomHeater(m);
      const heating = heater ? roomHeaterState(heater, locked) : undefined;
      const command: DeviceCommand = heating === undefined
        ? { type: "unavailable", reason: "Room heating state cannot support a new interval schedule; existing settings are retained" }
        : roomHeaterCommand(heater!, heating);
      result.commands[m.key].push(command);
      const watts = heating === undefined ? Math.max(0, m.forecast_w_by_slot[i])
        : heating ? roomHeaterDraw(heater!, snapshot.outdoor_temperature_c?.[i] ?? 0)?.watts ?? heater!.power.on_w : 0;
      result.power[m.key].push(watts); total += watts;
    }
    result.room_power[zone.key].push(total);
    result.temperature[zone.key].push(null);
    result.unplanned_temperature[zone.key].push(null);
    result.unplanned_power[zone.key].push(empiricalBaseline ? members.reduce((sum, member) => sum + member.forecast_w_by_slot[i], 0) : zone.unplanned_power_w[i]);
    remaining[i] = Math.max(0, remaining[i] - total);
    surplus[i] = Math.max(0, surplus[i] - total);
  }
  result.warnings.push(planningWarning("room_estimate", zone.key,
    offThermostat ? `${zone.name}: a thermostat is in Off mode. Its comfort target is retained for when heating resumes.`
      : limitedFit ? `${zone.name}: too few measured heating observations to plan preheating.`
      : `${zone.name}: the thermal or native thermostat forecast has incomplete evidence.`,
    unconfirmedPeerHeat
      ? "Comfort commands remain active. Electricity is estimated from history. Neighbour forecasts allow for passive exchange and omit additional heat from this room’s heater."
      : offThermostat ? "Electricity is estimated from measured history. The forecast excludes new heat from thermostats in Off mode."
      : "Compatible accepted heating intervals remain active; other intervals hold existing settings. Household consumption is estimated from measured history."));
  if (zone.model_source) {
    const source = zone.model_source;
    const empirical: RoomHeatingModelUse["thermal"] = [{ from: 0, through: n - 1, source: { kind: "empirical" } }];
    const baseline = !empiricalBaseline && zone.model && outdoorKnown ? {
      thermal: [{ from: 0, through: n - 1, source }],
      electrical: Object.fromEntries(members.map(member => [member.key, heatingModelRuns(
        snapshot.outdoor_temperature_c!.map(c => electricalSource(member,
          roomHeater(member) ? roomHeaterDraw(roomHeater(member)!, c!) : null)))])),
    } : undefined;
    (result.heating_model_use ??= {})[zone.key] = {
      thermal: empirical, electrical: Object.fromEntries(members.map(member => [member.key, empirical])),
      ...(baseline ? { baseline } : {}),
    };
  }
}
