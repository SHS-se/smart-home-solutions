import { assertEquals } from "@std/assert";
import { PoolMeanObservation, poolQuarterMean } from "./observations.ts";

// Independently specified synthetic states; expected values pinned before
// coefficient preparation, including equal-rate and small-rate limit branches.
const vectors: { parameters: ConstructorParameters<typeof PoolMeanObservation>;
  readings: { state: [number, number, number, number]; expected: number }[] }[] = [
  {"parameters":[0.25,60,0,4.5,-0.02,null],"readings":[{"state":[30,2,4,3],"expected":30.025624999999998},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":25.00875},{"state":[31,1,3,0],"expected":30.9975}]},
  {"parameters":[0.25,60,0.7,4.5,-0.02,null],"readings":[{"state":[30,2,4,3],"expected":30.005872181172577},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":25.01463607487206},{"state":[31,1,3,0],"expected":31.000151385077505}]},
  {"parameters":[0.25,60,0.7,4.5,-0.02,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025}],"readings":[{"state":[30,2,4,3],"expected":30.00555421633366},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":25.014390986148012},{"state":[31,1,3,0],"expected":31.000151385077505}]},
  {"parameters":[0.25,60,0.7,4.5,-0.02,{"recovery_rate_per_h":1.4285714285714286,"heat_loss_per_kwh":0.025}],"readings":[{"state":[30,2,4,3],"expected":30.005577580970588},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":25.01440912427325},{"state":[31,1,3,0],"expected":31.000151385077505}]},
  {"parameters":[0.25,60,1000,4.5,-0.02,{"recovery_rate_per_h":0.001,"heat_loss_per_kwh":1e-05}],"readings":[{"state":[30,2,4,3],"expected":29.997506509824834},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":24.997513436324105},{"state":[31,1,3,0],"expected":30.99750208315973}]},
  {"parameters":[0.25,60,100000,4.5,-0.02,{"recovery_rate_per_h":1e-06,"heat_loss_per_kwh":1e-07}],"readings":[{"state":[30,2,4,3],"expected":29.997500065104106},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":24.99750013437488},{"state":[31,1,3,0],"expected":30.997500020833314}]},
  {"parameters":[0.25,60,0,4.5,-0.02,{"recovery_rate_per_h":0.18,"heat_loss_per_kwh":0.025}],"readings":[{"state":[30,2,4,3],"expected":30.02268039575412},{"state":[29,0,0,0],"expected":28.9975},{"state":[25,6,8,1.2],"expected":25.006505562284037},{"state":[31,1,3,0],"expected":30.9975}]},
  {"parameters":[0.016666666666666666,1,0.005,1,0,{"recovery_rate_per_h":128,"heat_loss_per_kwh":1}],"readings":[{"state":[30,2,4,3],"expected":31.401254857117795},{"state":[29,0,0,0],"expected":29},{"state":[25,6,8,1.2],"expected":29.24244403378516},{"state":[31,1,3,0],"expected":31.710702198004174}]},
];

Deno.test("prepared pool observations preserve all original readings exactly", () => {
  for (const { parameters, readings } of vectors) {
    const observation = new PoolMeanObservation(...parameters);
    for (const { state, expected } of readings) {
      assertEquals(observation.read(...state), expected);
      assertEquals(poolQuarterMean(...state, ...parameters), expected);
    }
  }
});
