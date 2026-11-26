import { assert, assertEquals } from "@std/assert";
import { connectedIntegrationAccuracy, type ConnectedIntegrationStatistics } from "./planner/models/room/ensemble-accuracy.ts";

// Independently constructed replicate estimates for three complete command
// vectors. They share uncertain background costs and comfort outcomes.
const layout = { hours: [.25], deadlineResolved: true, rooms: 1, nodes: 1, slots: 1, roomPowerW: [1200], actuatorPowerW: [1200], roomNodeIndexes: [0], maximumPricePerKwh: .2 };
function estimates(change: (values: number[], replicate: number) => void = () => {}): ConnectedIntegrationStatistics {
  const replicates = Array.from({ length: 4 }, (_, r) => {
    const values = Array.from({ length: 3 }, (_, command) => [100, 22, 22, 1 + r + command / 100, 100, 100 * r + command]).flat();
    change(values, r);
    return { trajectories: 16, total: values.map(v => v * 16) };
  });
  return { trajectories: 64, total: replicates[0].total.map((_, i) => replicates.reduce((sum, r) => sum + r.total[i], 0)), replicates, infeasible: [0, 0, 0] };
}
Deno.test("connected integration resolves paired command outcomes without demanding precise common background cost", () => {
  const result = connectedIntegrationAccuracy(estimates(), layout);
  assert(result.converged);
  assert(result.maximum_error_ratio < 1e-10);
});
Deno.test("uncertain paired command cost and published endpoints independently require more integration", () => {
  const cost = connectedIntegrationAccuracy(estimates((v, r) => { v[11] += r / 2; }), layout);
  assertEquals(cost.converged, false);
  assertEquals(cost.next_trajectories, 128);
  const temperature = connectedIntegrationAccuracy(estimates((v, r) => { v[1] += r / 5; }), layout);
  assertEquals(temperature.converged, false);
  assert(temperature.maximum_temperature_error_c > .05);
});

Deno.test("unselectable feasible-seed and already-infeasible commands cannot delay publication", () => {
  const seedNoise = estimates((v, r) => { v[13] += r; v[17] += r; });
  assert(connectedIntegrationAccuracy(seedNoise, layout).converged);
  seedNoise.infeasible = [1, 1, 0];
  assertEquals(connectedIntegrationAccuracy(seedNoise, layout).converged, false);
  const rejectedNoise = estimates((v, r) => { v[1] += r; v[5] += r; });
  rejectedNoise.infeasible[0] = 1;
  assert(connectedIntegrationAccuracy(rejectedNoise, layout).converged);
});

Deno.test("native rejection certificate only resolves precision of a proposal when literal remains feasible", () => {
  const stats = estimates((v, r) => { v[1] += r; });
  assert(connectedIntegrationAccuracy(stats, { ...layout, proposalRejected: true }).converged);
  stats.infeasible[1] = 1;
  assertEquals(connectedIntegrationAccuracy(stats, { ...layout, proposalRejected: true }).converged, false);
});

Deno.test("deadline uncertainty requires continuation even when continuous outcomes are precise", () => {
  assertEquals(connectedIntegrationAccuracy(estimates(), { ...layout, deadlineResolved: false }).converged, false);
  assert(connectedIntegrationAccuracy(estimates(), { ...layout, deadlineResolved: false, proposalRejected: true }).converged);
});

Deno.test("horizon shortfall precision integrates paired quarters with their actual durations", () => {
  const slots = 2, stride = 11;
  const replicates = Array.from({ length: 4 }, (_, r) => {
    const values = Array.from({ length: 3 }, () => [100,100,22,22,22,22,2,2,100,100,1]).flat();
    // Large opposing quarter uncertainty cancels in the actual .25h/.5h
    // comparator integral, while both deadline states remain positive.
    values[6] += r / 4; values[7] -= r / 8;
    return { trajectories: 16, total: values.map(v => v * 16) };
  });
  const stats = { trajectories: 64, total: replicates[0].total.map((_,i)=>replicates.reduce((sum,r)=>sum+r.total[i],0)), replicates, infeasible:[0,0,0] };
  const options = { ...layout, slots, hours:[.25,.5] };
  assert(connectedIntegrationAccuracy(stats, options).converged);
  // The same quarter errors do not cancel at equal interval duration.
  assertEquals(connectedIntegrationAccuracy(stats, { ...options, hours:[.25,.25] }).converged, false);
  assertEquals(stats.total.length, stride * 3);
});
