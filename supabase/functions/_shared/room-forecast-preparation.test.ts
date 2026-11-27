import { assert, assertEquals, assertThrows } from "@std/assert";
import { connectedRoomSnapshot } from "./room-network.fixture.ts";
import { prepareRoomProposals, prepareRoomServices, type RoomPlanningInputs, type RoomPreparationProgress } from "./rules-room-services.ts";
import { applyConnectedRoomForecast, type ConnectedRoomForecastRequest } from "./rules-connected-room-services.ts";
import { nativePlanner } from "./planner-wasm/runtime.ts";
import type { NativeRoomNetworkAdvanceInput } from "./room-network-contract.ts";
import { PlanningError } from "./planning-errors.ts";

Deno.test("frozen proposal context applies the same qualified commands and demand as local preparation", () => {
  const snapshot = connectedRoomSnapshot(true);
  for (const node of snapshot.room_network!.nodes) {
    node.model.thermal_noise_c2_per_h = 0;
    for (const row of node.posterior.covariance) row.fill(0);
    for (const hypothesis of node.process_belief.hypotheses) {
      for (const row of hypothesis.posterior.covariance) row.fill(0);
      for (const edge of hypothesis.incoming) if (edge.kind === "log_ou") {
        edge.reversion_per_h = 0; edge.stationary_variance = 0;
      }
    }
  }
  const count = snapshot.slots.length;
  const input: RoomPlanningInputs = { snapshot, retained: [], headroom: Array(count).fill(4000),
    prices: { import_sek_per_kwh: Array(count).fill(1), export_sek_per_kwh: Array(count).fill(0), surplus_w: Array(count).fill(0) } };
  const local = structuredClone(input);
  let progress: RoomPreparationProgress | null = null, forecast: ConnectedRoomForecastRequest | undefined;
  let actions=0;
  do {
    actions++;
    const next = prepareRoomProposals(input, undefined, progress);
    progress = next.progress; forecast = next.forecast;
    if(progress.forecast_pending) {
      assertEquals(progress.next_room,snapshot.thermal_zones!.length);
      assertEquals(forecast,undefined,"the final ordered proposal does not compile the network");
      assertEquals(progress.network_work,undefined);
      progress=JSON.parse(JSON.stringify(progress));
    }
  } while (progress!.next_room < snapshot.thermal_zones!.length || progress!.forecast_pending);
  assertEquals(actions,snapshot.thermal_zones!.length+1,"compilation gets its own bounded action");
  assert(forecast);
  assertEquals(progress!.network_work, undefined, "the hosted proposal phase does not run a numerical trajectory");
  const frozen = JSON.parse(JSON.stringify(forecast)) as ConnectedRoomForecastRequest;
  let request: NativeRoomNetworkAdvanceInput = { ...frozen.nativeInput, target_trajectories: 64, max_minute_steps: 8192 };
  const planner = nativePlanner();
  for (;;) {
    const advanced = planner.roomNetworkAdvance(request);
    request = { ...request, work: advanced.work };
    if (!advanced.reached_target) continue;
    assert(advanced.work.deterministic);
    const output = planner.roomNetworkFinalize({ network: request.network, work: advanced.work });
    applyConnectedRoomForecast(input, progress!.services, frozen.context, output, advanced.work.statistics);
    break;
  }
  assertEquals(progress!.services, prepareRoomServices(local.snapshot, local.retained, local.headroom, local.prices));
  assertEquals(snapshot.room_network!.forecast, local.snapshot.room_network!.forecast);
  assertEquals(snapshot.room_network!.forecast.replicate_trajectories, [1,0,0,0]);
  assertEquals(snapshot.room_network!.forecast.replayed_paths, 1);
});

Deno.test("fresh forecasts freeze the bounded policy and completed historical forecasts replay their draw counts", () => {
  const snapshot = connectedRoomSnapshot(true), forecast = snapshot.room_network!.forecast;
  assertEquals(forecast.accuracy_revision, "connected_integration_accuracy_v3");
  assertEquals(forecast.trajectories, undefined);
  assertEquals(forecast.replayed_paths, undefined);
  assertEquals(forecast.replicate_trajectories, undefined);

  const previous = structuredClone(snapshot);
  previous.room_network!.forecast.accuracy_revision = "connected_integration_accuracy_v2";
  const upgraded = assertThrows(() => prepareRoomServices(previous), PlanningError);
  assertEquals(upgraded.code, "planner_upgraded");
  assertEquals(upgraded.disposition, "recapture");
  const run = (s: typeof snapshot) => {
    const n = s.slots.length;
    return prepareRoomServices(s, [], Array(n).fill(4000), {import_sek_per_kwh:Array(n).fill(1),
      export_sek_per_kwh:Array(n).fill(0), surplus_w:Array(n).fill(0)});
  };
  const fresh = run(snapshot).network_forecast!;
  assertEquals(fresh.trajectories, 64);
  assertEquals(fresh.replicate_trajectories, [16,16,16,16]);
  Object.assign(previous.room_network!.forecast, {trajectories:128,replayed_paths:128,replicate_trajectories:[32,32,32,32]});
  const recorded = structuredClone(previous.room_network!.forecast);
  assertEquals(run(previous).network_forecast, recorded);
});
