/** Private Home Assistant API envelope and compatibility contract.
 *
 * Normative source: contracts/ha-api/openapi.json. The legacy top-level fields
 * remain during the reader-first rollout described in architecture §5.7.6;
 * clients declaring API v1 receive a single copy in `data`.
 */

export const HA_API_VERSION = 1 as const;
export const HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = [5, 6, 7, 8] as const;
export const HA_SUPPORTED_PLAN_SCHEMA_VERSIONS = [5, 6, 7, 8] as const;
export const HA_MINIMUM_SNAPSHOT_SCHEMA_VERSION = 5 as const;
export const HA_MINIMUM_PLAN_SCHEMA_VERSION = 5 as const;

export const HA_API_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-request-id, x-shs-api-version, x-shs-integration-version",
  "Access-Control-Expose-Headers": "x-request-id",
};

export interface HaApiError {
  code: string;
  message: string;
  path: string | null;
  details: unknown;
  retryable: boolean;
}

/**
 * The correlation ids this server issues and the device echoes back.
 *
 * Plan ids and replan requests are both `gen_random_uuid()`, so the version and
 * variant nibbles are checked rather than the shape alone: an id the device
 * made up cannot complete a request the portal is waiting on.
 */
export const HA_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The replan columns of `energy_optimisation_current`. */
export interface HaReplanState {
  replan_request_id: string | null;
  replan_completed_request_id: string | null;
  replan_error: string | null;
}

/**
 * The replan this device is being asked for, if any.
 *
 * Requests stay on the row after they are answered, as the record of the last
 * one, so "asked for" is the difference between the requested and completed
 * ids rather than the presence of a request. A request this device has already
 * failed is withheld: it would otherwise be handed back on every poll, and the
 * household has already been told why it failed. Nothing is lost by that — the
 * next ordinary push carries fresh measurements and settles it anyway.
 */
export function pendingReplanRequestId(
  row: HaReplanState | null | undefined,
): string | null {
  if (!row?.replan_request_id) return null;
  if (row.replan_request_id === row.replan_completed_request_id) return null;
  return row.replan_error ? null : row.replan_request_id;
}

const PLAIN_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Name whatever was thrown, so a refused snapshot says why.
 *
 * Not everything throwable is an `Error`. A PostgREST failure arrives as a
 * plain `{ message, code, details, hint }`, and reporting that as "invalid
 * snapshot" told Home Assistant only that something had gone wrong, in a
 * message that read as though the snapshot itself were malformed.
 */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const { message, code, details, hint } = error as Record<string, unknown>;
    const parts = [
      typeof message === "string" ? message : null,
      code === undefined || code === null ? null : `code ${String(code)}`,
      typeof details === "string" ? details : null,
      typeof hint === "string" ? hint : null,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(" · ");
  }
  return "invalid snapshot";
}

export function haRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim() ?? "";
  return PLAIN_REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
}

const errorMessage = (code: string): string => ({
  client_upgrade_required:
    "The client and server do not share a supported API contract.",
  subscription_inactive: "The energy subscription is not active.",
  unauthorized: "The device credential was not accepted.",
  invalid_body: "The request body does not match the API contract.",
  internal_error: "The server could not complete the request.",
  method_not_allowed: "The HTTP method is not supported for this operation.",
  stale_plan_ack:
    "The acknowledgement does not name the current generated plan.",
}[code] ?? code.replaceAll("_", " "));

const retryableCode = (code: string): boolean =>
  [
    "internal_error",
    "storage_failed",
    "token_lookup_failed",
    "customer_lookup_failed",
  ].includes(code);

/**
 * Return the v1 envelope, retaining rollout aliases only for clients which
 * have not declared the v1 reader. This is the response constructor for the HA
 * routes, so request correlation and errors cannot drift endpoint by endpoint.
 */
export function haApiResponse(
  requestId: string,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
  clientApiVersion: string | null = null,
): Response {
  const headers = {
    ...HA_API_CORS_HEADERS,
    ...extraHeaders,
    "Content-Type": "application/json",
    "X-Request-ID": requestId,
  };
  if (status >= 400) {
    const legacy = body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
    const code = typeof legacy.error === "string"
      ? legacy.error
      : "internal_error";
    const path = typeof legacy.path === "string"
      ? legacy.path
      : typeof legacy.detail === "string" && /[.[\]]/.test(legacy.detail)
      ? legacy.detail
      : null;
    const error: HaApiError = {
      code,
      message: typeof legacy.message === "string"
        ? legacy.message
        : errorMessage(code),
      path,
      details: legacy.details ?? legacy.detail ?? null,
      retryable: typeof legacy.retryable === "boolean"
        ? legacy.retryable
        : retryableCode(code),
    };
    return new Response(
      JSON.stringify({
        api_version: HA_API_VERSION,
        request_id: requestId,
        ok: false,
        ...legacy,
        error: code,
        error_info: error,
      }),
      { status, headers },
    );
  }

  const aliases = clientApiVersion !== String(HA_API_VERSION) &&
      body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  return new Response(
    JSON.stringify({
      ...aliases,
      api_version: HA_API_VERSION,
      request_id: requestId,
      ok: true,
      data: body,
    }),
    { status, headers: { ...headers,
      Vary: [extraHeaders.Vary, "X-SHS-API-Version"].filter(Boolean).join(", "),
    } },
  );
}

export interface HaPlanningNegotiation {
  api_version?: unknown;
  accepted_plan_schema_versions?: unknown;
  integration_version?: unknown;
}

/** Validate explicit negotiation; a wholly absent block is a legacy v0 call. */
export function validatePlanningNegotiation(
  body: HaPlanningNegotiation,
  snapshotSchemaVersion: unknown,
): HaApiError | null {
  const declared = body.api_version !== undefined ||
    body.accepted_plan_schema_versions !== undefined ||
    body.integration_version !== undefined;
  if (!declared) return null;

  const accepted = body.accepted_plan_schema_versions;
  if (
    body.api_version !== HA_API_VERSION ||
    !Array.isArray(accepted) || accepted.length === 0 ||
    accepted.some((version) => !Number.isInteger(version)) ||
    typeof body.integration_version !== "string" ||
    body.integration_version.length < 1 || body.integration_version.length > 100
  ) {
    return {
      code: "client_upgrade_required",
      message: errorMessage("client_upgrade_required"),
      path: null,
      details: {
        server_api_version: HA_API_VERSION,
        supported_snapshot_schema_versions:
          HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
        supported_plan_schema_versions: HA_SUPPORTED_PLAN_SCHEMA_VERSIONS,
      },
      retryable: false,
    };
  }
  if (
    !HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.includes(
      snapshotSchemaVersion as 5 | 6 | 7 | 8,
    ) ||
    !accepted.includes(snapshotSchemaVersion)
  ) {
    return {
      code: "client_upgrade_required",
      message: errorMessage("client_upgrade_required"),
      path: "snapshot.schema_version",
      details: {
        received_snapshot_schema_version: snapshotSchemaVersion,
        accepted_plan_schema_versions: accepted,
        supported_snapshot_schema_versions:
          HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
        supported_plan_schema_versions: HA_SUPPORTED_PLAN_SCHEMA_VERSIONS,
      },
      retryable: false,
    };
  }
  return null;
}
