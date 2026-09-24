import { describeThrown } from "./ha-api-contract.ts";
import {
  COST_CURVE_EVALUATIONS,
  type CostCurveInput,
  costCurveKey,
  type CostCurveRecord,
  samePublishedPrices,
} from "./battery-cost-curve.ts";
import type { CostCurveProgress, CostCurveStep } from "./battery-cost-step.ts";
import { EnergyPlanningError } from "./energy-planning-client.ts";
import { ENERGY_PLANNING_PROTOCOL } from "./energy-planning-protocol.ts";
import { validateCurve } from "./store-value.ts";

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}
interface SelectionResult extends PromiseLike<QueryResult> {
  single(): PromiseLike<QueryResult>;
  maybeSingle(): PromiseLike<QueryResult>;
}
interface SelectionQuery extends SelectionResult {
  order(column: string, options: { ascending: boolean }): SelectionQuery;
  limit(count: number): SelectionQuery;
  eq(column: string, value: unknown): SelectionQuery;
  is(column: string, value: null): SelectionQuery;
  select(columns: string): SelectionResult;
}
export interface CostCurveDatabase {
  from(table: string): unknown;
}
interface SelectionTable {
  upsert(
    value: unknown,
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): PromiseLike<QueryResult>;
  select(columns: string): SelectionQuery;
  update(value: unknown): SelectionQuery;
}
interface StoredSelection {
  key: string;
  input: CostCurveInput;
  progress: CostCurveProgress;
  revision: number;
  record: CostCurveRecord | null;
}
export interface CostCurvePending { pending: true; retry_after_ms: number }
export type CostCurveResolution =
  | { selection: CostCurveRecord; input: CostCurveInput }
  | CostCurvePending;
const pending = (retry_after_ms = 1000): CostCurvePending => ({ pending: true, retry_after_ms });
// Leave room within one device request for authentication, storage and transfer.
// Search progress already belongs to the price-release row, not the HTTP request.
const MAX_WORKER_CALLS = 8;
const BATCH_MS = 8_000;

const TABLE = "energy_optimisation_battery_cost_curves";
const COLUMNS = "key,input,progress,revision,record";

function stored(result: QueryResult): StoredSelection {
  if (result.error) {
    throw new EnergyPlanningError(
      `Battery curve storage failed: ${result.error.message}`,
    );
  }
  if (!result.data) {
    throw new EnergyPlanningError("Battery curve selection is missing");
  }
  return result.data as StoredSelection;
}

/** First insert owns the source. A CAS loser resumes the winner, never its own input. */
export async function resolveCostCurve(
  db: CostCurveDatabase,
  homeId: string,
  customerId: string,
  input: CostCurveInput,
  connection: { url: string; planningSecret: string; requestId: string },
  fetcher: typeof fetch = fetch,
): Promise<CostCurveResolution> {
  input = {
    ...input,
    snapshot: { ...input.snapshot, battery_cost_curve: undefined },
  };
  // Adapt the transport builder once; keep Supabase generics outside the domain.
  const table = () => db.from(TABLE) as SelectionTable;
  const latest = await table().select(COLUMNS).eq("home_id", homeId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) {
    throw new EnergyPlanningError(
      `Battery curve storage failed: ${latest.error.message}`,
    );
  }
  if (latest.data) {
    const previous = stored(latest);
    if (
      previous.key === await costCurveKey(previous.input) &&
      samePublishedPrices(previous.input, input)
    ) {
      if (previous.record) {
        return { selection: previous.record, input: previous.input };
      }
      input = previous.input;
    }
  }
  const key = await costCurveKey(input);
  const inserted = await table().upsert({
    home_id: homeId,
    customer_id: customerId,
    key,
    input,
    progress: { evaluations: [] },
    revision: 0,
  }, { onConflict: "home_id,key", ignoreDuplicates: true });
  if (inserted.error) {
    throw new EnergyPlanningError(
      `Battery curve storage failed: ${inserted.error.message}`,
    );
  }
  const read = async () =>
    stored(
      await table().select(COLUMNS)
        .eq("home_id", homeId).eq("key", key).single(),
    );
  let row = await read();
  if (row.record) return { selection: row.record, input: row.input };
  if (!connection.url || !connection.planningSecret) {
    throw new EnergyPlanningError("Planning worker is not configured");
  }
  const started = performance.now();
  const signal = AbortSignal.timeout(20_000);
  for (let calls = 0; calls < MAX_WORKER_CALLS; calls++) {
    if (signal.aborted) {
      throw new EnergyPlanningError(
        "Battery curve batch exceeded the 20-second request deadline",
      );
    }
    let response: Response;
    try {
      response = await fetcher(
        `${connection.url}/functions/v1/energy-optimisation-plan-step`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shs-planning-secret": connection.planningSecret,
            "x-request-id": connection.requestId,
          },
          body: JSON.stringify({
            protocol: ENERGY_PLANNING_PROTOCOL,
            kind: "cost_curve",
            input: row.input,
            progress: row.progress,
          }),
          signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "RateLimitError" &&
          "retryAfterMs" in error && typeof error.retryAfterMs === "number" &&
          Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
        return pending(Math.ceil(error.retryAfterMs));
      }
      console.error("[ENERGY-PLANNING] worker transport failed", {
        request_id: connection.requestId,
        name: error instanceof Error ? error.name : null,
        detail: describeThrown(error),
        retry_after_ms: error && typeof error === "object" && "retryAfterMs" in error
          ? error.retryAfterMs : null,
      });
      throw new EnergyPlanningError(
        signal.aborted
          ? "Battery curve batch exceeded the 20-second request deadline"
          : `Planning worker could not be reached: ${describeThrown(error)}`,
      );
    }
    let body: CostCurveStep & {
      protocol: number;
      request_id: string;
      error?: string;
      detail?: string;
    };
    try {
      body = await response.json();
      if (!body || typeof body !== "object") {
        throw new Error("Invalid planning response");
      }
    } catch {
      throw new EnergyPlanningError(
        `Planning worker returned HTTP ${response.status} without a planning response`,
      );
    }
    if (!response.ok) {
      const invalid = response.status === 400 &&
        body.error === "invalid_snapshot";
      throw new EnergyPlanningError(
        invalid
          ? body.detail ?? "Invalid planning snapshot"
          : `Planning worker returned HTTP ${response.status}${
            body.error ? ` (${body.error})` : ""
          }`,
        invalid ? 400 : 502,
      );
    }
    if (
      body.protocol !== ENERGY_PLANNING_PROTOCOL ||
      body.request_id !== connection.requestId
    ) {
      throw new EnergyPlanningError(
        "Planning worker response protocol or request ID mismatch",
      );
    }
    if (body.done === true) {
      if (
        !body.record || body.record.key !== key ||
        !Number.isFinite(body.record.bill_before_sek) ||
        !Number.isFinite(body.record.bill_after_sek) ||
        body.record.source_snapshot_id !== row.input.snapshot.snapshot_id ||
        !Number.isInteger(body.record.evaluations) ||
        body.record.evaluations < 1 ||
        body.record.evaluations > COST_CURVE_EVALUATIONS ||
        !Number.isFinite(Date.parse(body.record.published_until)) ||
        !body.record.curve || body.record.curve.unit !== "kwh" ||
        !Array.isArray(body.record.curve.points) ||
        body.record.curve.points.some((point) =>
          !point || typeof point !== "object"
        ) ||
        validateCurve(body.record.curve) !== null
      ) {
        throw new EnergyPlanningError(
          "Planning worker returned an invalid battery curve record",
        );
      }
    } else if (
      body.done !== false || !body.progress ||
      !Array.isArray(body.progress.evaluations) ||
      body.progress.evaluations.length > COST_CURVE_EVALUATIONS ||
      body.progress.evaluations.some((entry) =>
        !entry || !Number.isFinite(entry.bill_sek)
      ) ||
      (body.progress.current !== undefined &&
        (!body.progress.current ||
          !Array.isArray(body.progress.current.completed)))
    ) {
      throw new EnergyPlanningError(
        "Planning worker returned an invalid battery curve continuation",
      );
    }
    const result = await table().update({
      revision: row.revision + 1,
      ...(body.done === true
        ? { record: body.record, progress: { evaluations: [] } }
        : { progress: body.progress }),
    }).eq("home_id", homeId).eq("key", key).eq("revision", row.revision)
      .is("record", null).select(COLUMNS).maybeSingle();
    if (result.error) {
      throw new EnergyPlanningError(
        `Battery curve storage failed: ${result.error.message}`,
      );
    }
    row = result.data ? stored(result) : await read();
    // Even a finished batch is acknowledged separately from the final plan:
    // its next request can use the whole planning deadline.
    if (row.record || performance.now() - started >= BATCH_MS) return pending();
  }
  return pending();
}
