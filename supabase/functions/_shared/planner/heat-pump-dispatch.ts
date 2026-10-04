import { parseHeaterResponse, projectHeatPumpResponse, type HeatPumpResponse } from "./device-models.ts";
import type { DispatchInputResponse } from "./dispatch-plan.ts";

/** Bind one device's immutable runtime to the generic dispatch response contract. */
export function heaterInputResponse(
  response: HeatPumpResponse,
  power: { compressor_w: number; auxiliary_w: number },
  elapsedSeconds: number | null,
): DispatchInputResponse {
  const model = parseHeaterResponse(response);
  const project = (commands: number[], hours: number[]) =>
    projectHeatPumpResponse(model, power, commands, hours, elapsedSeconds);
  return {
    project,
    afterPrefix: (commands, hours) => {
      const boundaries = project(commands, hours).elapsed_seconds_by_boundary;
      return heaterInputResponse(model, power, boundaries[boundaries.length - 1]);
    },
  };
}
