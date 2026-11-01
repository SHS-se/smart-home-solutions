/** Closed, TEST research products for Nordic week-ahead flow-based net positions. */
import {
  marketBodyBase64,
  readMarketProvider,
} from "./market-provider-response.ts";
import { NEIGHBOUR_EIC } from "./entsoe-market-data.ts";
export type NucsDataset =
  | "nucs_week_ahead_available"
  | "nucs_week_ahead_unavailable"
  | "nucs_week_ahead_ntc"
  | "nucs_transmission_outages";
export function nucsParameters(query: unknown): URLSearchParams {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("Invalid NUCS query");
  }
  const q = query as Record<string, unknown>;
  const pair = q.dataset === "nucs_week_ahead_ntc" ||
    q.dataset === "nucs_transmission_outages";
  if (
    Object.keys(q).sort().join(",") !==
      (pair
        ? "dataset,direction,from,neighbour,provider,to"
        : "dataset,direction,from,provider,to") ||
    q.provider !== "nucs" ||
    ![
      "nucs_week_ahead_available",
      "nucs_week_ahead_unavailable",
      "nucs_week_ahead_ntc",
      "nucs_transmission_outages",
    ].includes(String(q.dataset)) ||
    !["import", "export"].includes(String(q.direction)) ||
    (pair && !Object.hasOwn(NEIGHBOUR_EIC, String(q.neighbour)))
  ) throw new Error("Unsupported NUCS product");
  const parse = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(value)
    ) throw new Error("Invalid NUCS time");
    const at = Date.parse(value);
    if (
      !Number.isFinite(at) || at % 60_000 ||
      new Date(at).toISOString().slice(0, 16) !== value.slice(0, 16)
    ) throw new Error("Invalid NUCS time");
    return at;
  };
  const from = parse(q.from), to = parse(q.to);
  if (to <= from || to - from > 14 * 86_400_000) {
    throw new Error("NUCS research window must be at most fourteen days");
  }
  const compact = (at: number) =>
    new Date(at).toISOString().replace(/[-:]/g, "").replace("T", "").slice(
      0,
      12,
    );
  // NUCS primary references: web-api-di-1-8-forecasted-week-ahead-transfer-capacities-111.html
  // and web-api-di-2-1-changes-in-actual-availability-in-the-transmission-grid-101b.html.
  const params = new URLSearchParams({
    documentType: q.dataset === "nucs_week_ahead_ntc"
      ? "A61"
      : q.dataset === "nucs_week_ahead_unavailable"
      ? "B31"
      : "A78",
    periodStart: compact(from),
    periodEnd: compact(to),
  });
  if (pair) {
    const neighbour = NEIGHBOUR_EIC[q.neighbour as keyof typeof NEIGHBOUR_EIC];
    params.set(
      "in_Domain",
      q.direction === "import" ? "10Y1001A1001A46L" : neighbour,
    );
    params.set(
      "out_Domain",
      q.direction === "import" ? neighbour : "10Y1001A1001A46L",
    );
    if (q.dataset === "nucs_week_ahead_ntc") {
      params.set("contract_MarketAgreement.Type", "A02");
    }
  } else {
    params.set("processType", "A31");
    params.set("fbForecast", "true");
    params.set(
      q.direction === "import" ? "in_Domain" : "out_Domain",
      "10Y1001A1001A46L",
    );
  }
  return params;
}

import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";
import { marketXmlBodies } from "./market-xml.ts";
import {
  type EntsoeInterval,
  parseEntsoeResponse,
} from "./entsoe-market-data.ts";
export type NucsArchiveDataset =
  | "nucs_week_ahead_ntc"
  | "nucs_transmission_outages";
type Xml = Record<string, unknown>;
const list = (v: unknown): unknown[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
function object(v: unknown): Xml {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("Invalid NUCS XML");
  }
  return v as Xml;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new Error("Missing NUCS field");
  return v.trim();
}
function optional(v: unknown): string | null {
  return v === undefined ? null : text(v);
}
export interface NucsDocument {
  provider: "nucs";
  kind: "weekly_ntc" | "outage_notices";
  in_domain: string;
  out_domain: string;
  semantics:
    | "published_directional_ntc_not_joint_flow_based_capacity"
    | "native_notices_not_additive_capacity";
  capacity_intervals: EntsoeInterval[];
  notices: {
    id: string;
    revision: string;
    created_at: string;
    status: string | null;
    process: string | null;
    reasons: unknown[];
    series: Xml[];
  }[];
}
export async function parseNucsResponse(
  bytes: Uint8Array,
  query: {
    dataset: NucsArchiveDataset;
    neighbour: keyof typeof NEIGHBOUR_EIC;
    direction: "import" | "export";
    from: string;
    to: string;
  },
) {
  const params = nucsParameters({ provider: "nucs", ...query }),
    inDomain = params.get("in_Domain")!,
    outDomain = params.get("out_Domain")!;
  const document: NucsDocument = {
    provider: "nucs",
    kind: query.dataset === "nucs_week_ahead_ntc"
      ? "weekly_ntc"
      : "outage_notices",
    in_domain: inDomain,
    out_domain: outDomain,
    semantics: query.dataset === "nucs_week_ahead_ntc"
      ? "published_directional_ntc_not_joint_flow_based_capacity"
      : "native_notices_not_additive_capacity",
    capacity_intervals: [],
    notices: [],
  };
  for (const body of await marketXmlBodies(bytes)) {
    if (/<!DOCTYPE/i.test(body) || XMLValidator.validate(body) !== true) {
      throw new Error("Malformed NUCS XML");
    }
    const parsed = object(
      new XMLParser({
        removeNSPrefix: true,
        parseTagValue: false,
        trimValues: true,
        ignoreAttributes: true,
      }).parse(body),
    );
    const roots = Object.keys(parsed).filter((k) => !k.startsWith("?"));
    if (roots.length !== 1) throw new Error("Invalid NUCS root");
    const root = roots[0], doc = object(parsed[root]);
    if (root === "Acknowledgement_MarketDocument") {
      const reasons = list(doc.Reason).map(object);
      if (
        reasons.length &&
        reasons.every((r) =>
          r.code === "999" && /no matching data found/i.test(text(r.text))
        )
      ) {
        return {
          status: "no_data" as const,
          reason: reasons.map((r) => r.text).join("; "),
        };
      }
      throw new Error("NUCS provider acknowledgement");
    }
    if (
      text(doc.type) !==
        (query.dataset === "nucs_week_ahead_ntc" ? "A61" : "A78")
    ) throw new Error("Unexpected NUCS document type");
    const series = list(doc.TimeSeries).map(object);
    if (
      !series.length ||
      !series.some((s) =>
        s["in_Domain.mRID"] === inDomain && s["out_Domain.mRID"] === outDomain
      )
    ) throw new Error("NUCS response does not match requested border");
    if (query.dataset === "nucs_week_ahead_ntc") {
      if (
        series.some((s) =>
          s["in_Domain.mRID"] !== inDomain ||
          s["out_Domain.mRID"] !== outDomain ||
          s["quantity_Measure_Unit.name"] !== "MAW"
        )
      ) throw new Error("Unexpected NUCS capacity series");
      const values = parseEntsoeResponse(body);
      if (values.status !== "data") {
        throw new Error("Missing NUCS capacity document");
      }
      document.capacity_intervals.push(...values.intervals);
    }
    document.notices.push({
      id: text(doc.mRID),
      revision: text(doc.revisionNumber),
      created_at: text(doc.createdDateTime),
      status: doc.docStatus === undefined
        ? null
        : optional(object(doc.docStatus).value),
      process: optional(doc["process.processType"]),
      reasons: list(doc.Reason),
      series,
    });
  }
  return { status: "data" as const, document };
}
export async function captureNucsEvidence(
  query: Parameters<typeof parseNucsResponse>[1],
  token: string,
  fetchProvider: typeof fetch = fetch,
) {
  const empty = {
    http_status: null as number | null,
    body_sha256: null as string | null,
    raw_base64: null as string | null,
    error_code: null as string | null,
    request: query,
  };
  if (!token) {
    return {
      ...empty,
      status: "transport_error" as const,
      error_code: "nucs_token_not_configured",
    };
  }
  const url = new URL("https://www.nucs.net/api");
  url.search = nucsParameters({ provider: "nucs", ...query }).toString();
  url.searchParams.set("securityToken", token);
  return nucsEvidenceFromResponse(query, await readMarketProvider(url, token, fetchProvider));
}

/** Parse provider bytes obtained through the private research endpoint. */
export async function nucsEvidenceFromResponse(
  query: Parameters<typeof parseNucsResponse>[1],
  response: Awaited<ReturnType<typeof readMarketProvider>>,
) {
  const empty = { http_status: null as number | null, body_sha256: null as string | null,
    raw_base64: null as string | null, error_code: null as string | null, request: query };
  if (!response) {
    return {
      ...empty,
      status: "transport_error" as const,
      error_code: "nucs_transport_failed",
    };
  }
  const bytes = response.bytes;
  const held = {
    ...empty,
    http_status: response.http_status,
    raw_base64: marketBodyBase64(bytes),
    body_sha256: response.body_sha256,
  };
  const ok = response.http_status >= 200 && response.http_status < 300;
  try {
    const parsed = await parseNucsResponse(bytes, query);
    if (parsed.status === "no_data") {
      return {
        ...held,
        status: "no_data" as const,
        error_code: "no_matching_data",
      };
    }
    if (!ok) {
      return {
        ...held,
        status: "provider_error" as const,
        error_code: `http_${response.http_status}`,
      };
    }
    return { ...held, status: "data" as const, document: parsed.document };
  } catch {
    return {
      ...held,
      status: ok ? "parse_error" as const : "provider_error" as const,
      error_code: ok
        ? "unsupported_or_invalid_nucs_document"
        : `http_${response.http_status}`,
    };
  }
}
