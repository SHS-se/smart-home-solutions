import type { CostCurveResolution } from "./battery-cost-selection.ts";
import type { CostCurveInput } from "./battery-cost-curve.ts";
import { EnergyPlanningError } from "./energy-planning-client.ts";

export const batteryCurveCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
interface PortalHome {
  customerId: string;
  input: CostCurveInput;
}
export interface BatteryCurvePortalDependencies {
  /** Must read through caller RLS before returning any home data. */
  readHome(authorization: string, homeId: string): Promise<PortalHome | null>;
  resolve(
    homeId: string,
    home: PortalHome,
  ): Promise<CostCurveResolution>;
}

/** Only home_id is accepted: source measurements always come from the server. */
export async function handleBatteryCostCurve(
  request: Request,
  dependencies: BatteryCurvePortalDependencies,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: batteryCurveCorsHeaders,
    });
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: batteryCurveCorsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "unauthorized" }, 401);
  let homeId: string;
  try {
    const body = await request.json();
    if (typeof body?.home_id !== "string" || !body.home_id) {
      return json({ error: "home_id_required" }, 400);
    }
    homeId = body.home_id;
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  try {
    const home = await dependencies.readHome(authorization, homeId);
    if (!home) return json({ error: "not_found" }, 404);
    const result = await dependencies.resolve(homeId, home);
    return json(result, "pending" in result ? 202 : 200);
  } catch (error) {
    return json({
      error: "battery_curve_failed",
      detail: error instanceof Error ? error.message : String(error),
    }, error instanceof EnergyPlanningError ? error.status : 500);
  }
}
