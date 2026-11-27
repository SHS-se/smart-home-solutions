/** Native NUCS forecasted Nordic flow-based publications. */
export const NUCS_FLOW_PRODUCTS = {
  nucs_week_ahead_domain: {
    process: "A31",
    product: "domain",
    horizon: "week",
  },
  nucs_week_ahead_available: {
    process: "A31",
    product: "available",
    horizon: "week",
  },
  nucs_week_ahead_unavailable: {
    process: "A31",
    product: "unavailable",
    horizon: "week",
  },
  nucs_month_ahead_domain: {
    process: "A32",
    product: "domain",
    horizon: "month",
  },
  nucs_month_ahead_available: {
    process: "A32",
    product: "available",
    horizon: "month",
  },
  nucs_month_ahead_unavailable: {
    process: "A32",
    product: "unavailable",
    horizon: "month",
  },
} as const;
export type NucsFlowDataset = keyof typeof NUCS_FLOW_PRODUCTS;
export interface NucsFlowQuery {
  dataset: NucsFlowDataset;
  from: string;
  to: string;
}
export function isNucsFlowDataset(value: unknown): value is NucsFlowDataset {
  return typeof value === "string" && Object.hasOwn(NUCS_FLOW_PRODUCTS, value);
}
export function nucsFlowParameters(value: unknown): URLSearchParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid NUCS flow-based query");
  }
  const q = value as Record<string, unknown>;
  if (
    ![
      "dataset,from,provider,to",
      "dataset,from,provider,publication_id,publication_revision,to",
    ].includes(Object.keys(q).sort().join(",")) ||
    q.provider !== "nucs" || !isNucsFlowDataset(q.dataset)
  ) throw new Error("Unsupported NUCS flow-based query");
  const parse = (v: unknown) => {
    if (
      typeof v !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(v)
    ) throw new Error("Invalid NUCS time");
    const ms = Date.parse(v);
    if (
      !Number.isFinite(ms) || ms % 60_000 ||
      new Date(ms).toISOString().slice(0, 16) !== v.slice(0, 16)
    ) throw new Error("Invalid NUCS time");
    return ms;
  };
  const spec = NUCS_FLOW_PRODUCTS[q.dataset],
    from = parse(q.from),
    to = parse(q.to);
  if (
    spec.product !== "domain" &&
    ("publication_id" in q || "publication_revision" in q)
  ) throw new Error("Publication IDs require a domain query");
  if (
    to <= from || to - from > (spec.horizon === "week" ? 15 : 63) * 86_400_000
  ) throw new Error("NUCS flow-based window exceeds collection bounds");
  const compact = (ms: number) =>
    new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const params = new URLSearchParams({
    processType: spec.process,
    fbForecast: "true",
    periodStart: compact(from),
    periodEnd: compact(to),
  });
  if (spec.product === "domain") {
    if (
      q.publication_id !== undefined || q.publication_revision !== undefined
    ) {
      if (
        typeof q.publication_id !== "string" ||
        !q.publication_id.trim() ||
        typeof q.publication_revision !== "string" ||
        !/^\d+$/.test(q.publication_revision)
      ) throw new Error("Invalid NUCS publication identity");
      return new URLSearchParams({
        mRID: q.publication_id,
        documentVersion: q.publication_revision,
        fbBatch: "true",
      });
    }
    params.set("fbCriticalBranch", "true");
  } else {
    params.set("documentType", spec.product === "available" ? "A78" : "B31");
    // Forecasted publications contain all Nordic zones even with an area filter.
    params.set("in_Domain", "10Y1001A1001A46L");
  }
  return params;
}

import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";

type Element = Record<string, unknown>;
const list = (v: unknown): unknown[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
function element(v: unknown): Element {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("Invalid NUCS element");
  }
  return v as Element;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new Error("Missing NUCS field");
  return v.trim();
}
function optional(v: unknown): string | null {
  return v === undefined || v === "" ? null : text(v);
}
function numeric(v: unknown): number {
  const n = Number(text(v));
  if (!Number.isFinite(n)) throw new Error("Invalid NUCS number");
  return n;
}
function timestamp(v: unknown): number {
  const ms = Date.parse(text(v));
  if (!Number.isFinite(ms)) throw new Error("Invalid NUCS timestamp");
  return ms;
}
export interface NucsPublication {
  id: string;
  revision: string;
  created_at: string;
  status: string | null;
  process: "A31" | "A32";
  related_documents: { id: string; revision: string }[];
}
export interface NucsNetPosition {
  series_id: string;
  start: string;
  end: string;
  bidding_zone: string;
  direction: "import" | "export";
  business_type: string;
  unit: "MAW";
  resolution: string;
  value_mw: number;
  reasons: unknown[];
  assets: unknown[];
}
export interface NucsConstraint {
  id: string;
  name: string | null;
  business_type: string;
  status: string | null;
  optimization_status: string | null;
  contingencies: unknown[];
  monitored: {
    id: string;
    resource_id: string | null;
    name: string | null;
    in_domain: string | null;
    out_domain: string | null;
    ram_mw: number;
    ptdf: Record<string, number>;
    measurements: unknown[];
  }[];
}
export type NucsFlowDocument = {
  provider: "nucs";
  semantics: "indicative_forecasted_flow_based_domain";
  horizon: "week" | "month";
  publications: (NucsPublication & {
    kind: "available" | "unavailable";
    positions: NucsNetPosition[];
  })[];
};

/** A03 points extend to the next change or period end. A01 omissions remain gaps. */
function blocks(series: Element, periodName: string) {
  const curve = text(series.curveType);
  if (!["A01", "A03"].includes(curve)) {
    throw new Error("Unsupported NUCS curve");
  }
  const periods = list(series[periodName]).map(element);
  if (!periods.length) throw new Error("Missing NUCS periods");
  return periods.flatMap((period) => {
    const span = element(period.timeInterval);
    const start = timestamp(span.start),
      end = timestamp(span.end),
      resolution = text(period.resolution);
    const match = /^PT(\d+)(M|H)$/.exec(resolution);
    if (!match || Number(match[1]) <= 0 || end <= start) {
      throw new Error("Unsupported NUCS period");
    }
    const step = Number(match[1]) * (match[2] === "M" ? 60_000 : 3_600_000);
    const points = list(period.Point).map(element).map((point) => {
      const position = numeric(point.position);
      if (
        !Number.isInteger(position) || position < 1 ||
        start + (position - 1) * step >= end
      ) throw new Error("Invalid NUCS position");
      return { point, position };
    }).sort((a, b) => a.position - b.position);
    if (!points.length) throw new Error("Missing NUCS points");
    return points.map(({ point, position }, i) => {
      const next = points[i + 1];
      if (next?.position === position) {
        throw new Error("Duplicate NUCS position");
      }
      return {
        start: new Date(start + (position - 1) * step).toISOString(),
        end: new Date(
          curve === "A03"
            ? next ? start + (next.position - 1) * step : end
            : Math.min(start + position * step, end),
        ).toISOString(),
        resolution,
        point,
      };
    });
  });
}
export function parseNucsConstraint(value: unknown): NucsConstraint {
  const c = element(value);
  if (text(c["quantity_Measurement_Unit.name"]) !== "MAW") {
    throw new Error("Unexpected NUCS constraint unit");
  }
  const monitored = list(c.Monitored_Series).map(element).map((m) => {
    const r = element(m.RegisteredResource);
    const ptdf: Record<string, number> = {};
    for (const item of list(r.PTDF_Domain).map(element)) {
      const zone = text(item.mRID);
      if (Object.hasOwn(ptdf, zone)) {
        throw new Error("Duplicate NUCS PTDF zone");
      }
      ptdf[zone] = numeric(item["pTDF_Quantity.quantity"]);
    }
    return {
      id: text(m.mRID),
      resource_id: optional(r.mRID),
      name: optional(r.name),
      in_domain: optional(r["in_Domain.mRID"]),
      out_domain: optional(r["out_Domain.mRID"]),
      ram_mw: numeric(
        r["flowBasedStudy_Domain.flowBasedMargin_Quantity.quantity"],
      ),
      ptdf,
      measurements: list(r.Measurements),
    };
  });
  if (!monitored.length) throw new Error("Missing NUCS monitored constraints");
  return {
    id: text(c.mRID),
    name: optional(c.name),
    business_type: text(c.businessType),
    status: optional(c["constraintStatus_MarketObjectStatus.status"]),
    optimization_status: optional(c["Optimization_MarketObjectStatus.status"]),
    contingencies: list(c.Contingency_Series),
    monitored,
  };
}
export function parseNucsFlowXml(
  body: string,
  query: NucsFlowQuery,
): NucsFlowDocument["publications"][number] | null {
  if (/<!DOCTYPE/i.test(body) || XMLValidator.validate(body) !== true) {
    throw new Error("Malformed NUCS XML");
  }
  const root = element(
    new XMLParser({
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: true,
      ignoreAttributes: true,
    }).parse(body),
  );
  const roots = Object.keys(root).filter((k) => !k.startsWith("?"));
  if (roots.length !== 1) throw new Error("Invalid NUCS root");
  const doc = element(root[roots[0]]);
  if (roots[0] === "Acknowledgement_MarketDocument") {
    const reasons = list(doc.Reason).map(element);
    if (
      reasons.length &&
      reasons.every((r) =>
        r.code === "999" && /no matching data found/i.test(text(r.text))
      )
    ) return null;
    throw new Error("NUCS provider acknowledgement");
  }
  const spec = NUCS_FLOW_PRODUCTS[query.dataset];
  const header = publicationHeader(doc, query.dataset, roots[0]);
  const series = list(doc.TimeSeries).map(element);
  if (!series.length) throw new Error("Missing NUCS time series");
  if (spec.product === "domain") {
    throw new Error("Domains require the streaming archive reader");
  }
  return {
    ...header,
    kind: spec.product,
    positions: series.flatMap((s) => {
      const inDomain = text(s["in_Domain.mRID"]),
        outDomain = text(s["out_Domain.mRID"]);
      const nordic = "10Y1001A1001A91G";
      if ((inDomain === nordic) === (outDomain === nordic)) {
        throw new Error("Unexpected NUCS net-position domains");
      }
      const direction = outDomain === nordic
        ? "import" as const
        : "export" as const;
      const business = text(s.businessType);
      if (
        spec.product === "unavailable" &&
        business !== (direction === "import" ? "B69" : "B70")
      ) throw new Error("Unexpected NUCS net-position business type");
      if (
        text(
          s[
            spec.product === "available"
              ? "quantity_Measurement_Unit.name"
              : "measurement_Unit.name"
          ],
        ) !== "MAW"
      ) throw new Error("Unexpected NUCS net-position unit");
      return blocks(
        s,
        spec.product === "available" ? "Available_Period" : "Period",
      ).map((b) => ({
        series_id: text(s.mRID),
        start: b.start,
        end: b.end,
        bidding_zone: direction === "import" ? inDomain : outDomain,
        direction,
        business_type: business,
        unit: "MAW" as const,
        resolution: b.resolution,
        value_mw: numeric(b.point.quantity),
        reasons: list(s.Reason),
        assets: list(s.Asset_RegisteredResource),
      }));
    }),
  };
}

import JSZip from "npm:jszip@3.10.1";
import {
  marketXmlBodies,
  marketZipDirectory,
  marketZipStream,
} from "./market-xml.ts";
import {
  marketBodyBase64,
  readMarketProvider,
} from "./market-provider-response.ts";

export const NUCS_NATIVE_BUCKET = "test-energy-market-native";
export const NUCS_BUNDLE_LIMITS = {
  memberBytes: 64 * 1024 * 1024,
  totalBytes: 96 * 1024 * 1024,
  maxMembers: 8,
  extensions: [".xml", ".zip"],
};
export const NUCS_DOMAIN_LIMITS = {
  memberBytes: 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  maxMembers: 1,
  extensions: [".xml"],
};
const POSITION_LIMITS = {
  memberBytes: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  maxMembers: 199,
  extensions: [".xml"],
};
export interface NucsDomainArchive {
  provider: "nucs";
  semantics: "indicative_forecasted_flow_based_domain";
  horizon: "week" | "month";
  source_observation_id: string;
  publications: (NucsPublication & {
    kind: "domain_archive";
    archive: {
      bucket: typeof NUCS_NATIVE_BUCKET;
      path: string;
      sha256: string;
      bytes: number;
      member: string;
      expanded_bytes: number;
    };
  })[];
}
export type NucsFlowEvidence =
  & {
    request: NucsFlowQuery;
    http_status: number | null;
    body_sha256: string | null;
    error_code: string | null;
    raw_base64: string | null;
    native_archives?: { path: string; sha256: string; bytes: number }[];
  }
  & (
    | { status: "data"; document: NucsFlowDocument | NucsDomainArchive }
    | {
      status: "no_data" | "provider_error" | "transport_error" | "parse_error";
    }
  );
export type NucsNativeWriter = (
  path: string,
  bytes: Uint8Array,
) => Promise<void>;

function publicationHeader(
  doc: Element,
  dataset: NucsFlowDataset,
  root: string,
): NucsPublication {
  const spec = NUCS_FLOW_PRODUCTS[dataset];
  const expectedRoot = spec.product === "domain"
    ? "CriticalNetworkElement_MarketDocument"
    : spec.product === "available"
    ? "Unavailability_MarketDocument"
    : "Capacity_MarketDocument";
  const expectedType = spec.product === "domain"
    ? "B11"
    : spec.product === "available"
    ? "A78"
    : "B31";
  if (
    root !== expectedRoot || doc.type !== expectedType ||
    doc["process.processType"] !== spec.process
  ) throw new Error("NUCS product or horizon mismatch");
  timestamp(doc.createdDateTime);
  return {
    id: text(doc.mRID),
    revision: text(doc.revisionNumber),
    created_at: text(doc.createdDateTime),
    status: doc.docStatus === undefined
      ? null
      : text(element(doc.docStatus).value),
    process: spec.process,
    related_documents: list(doc.Related_MarketDocument).map(element).map(
      (r) => ({ id: text(r.mRID), revision: text(r.revisionNumber) }),
    ),
  };
}
export function parseNucsDomainHeader(
  body: string,
  dataset: NucsFlowDataset,
): NucsPublication {
  if (/<!DOCTYPE/i.test(body) || XMLValidator.validate(body) !== true) {
    throw new Error("Malformed NUCS header");
  }
  const parsed = element(
    new XMLParser({
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: true,
      ignoreAttributes: true,
    }).parse(body),
  );
  const roots = Object.keys(parsed).filter((k) => !k.startsWith("?"));
  if (roots.length !== 1) throw new Error("Invalid NUCS header root");
  return publicationHeader(element(parsed[roots[0]]), dataset, roots[0]);
}
/** The provider bundle contains a ZIP-wrapped IG183 plus the two XML net-position files. */
export async function nucsDomainMember(bytes: Uint8Array) {
  const entries = marketZipDirectory(bytes, NUCS_BUNDLE_LIMITS);
  const outer = await JSZip.loadAsync(bytes);
  const nested = entries.filter((e) => e.name.endsWith(".zip"));
  if (nested.length !== 1) throw new Error("Expected one NUCS domain ZIP");
  const innerBytes = await outer.file(nested[0].name)!.async("uint8array");
  const innerEntries = marketZipDirectory(innerBytes, NUCS_DOMAIN_LIMITS);
  if (innerEntries.length !== 1) {
    throw new Error("Expected one NUCS domain XML");
  }
  const inner = await JSZip.loadAsync(innerBytes);
  return {
    member: inner.file(innerEntries[0].name)!,
    name: innerEntries[0].name,
    expanded_bytes: innerEntries[0].bytes,
  };
}
async function archivedDomainHeader(
  member: JSZip.JSZipObject,
  dataset: NucsFlowDataset,
) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let prefix = "";
  for await (
    const chunk of marketZipStream(member, NUCS_DOMAIN_LIMITS.memberBytes)
  ) {
    prefix += decoder.decode(chunk, { stream: true });
    const series = /<(?:[\w]+:)?TimeSeries[\s>]/.exec(prefix);
    if (series) {
      const header = prefix.slice(0, series.index);
      const root = /<(?![!?])([^\s/>]+)/.exec(header)?.[1];
      if (!root) throw new Error("Missing NUCS domain root");
      return parseNucsDomainHeader(header + "</" + root + ">", dataset);
    }
    if (prefix.length > 64 * 1024) {
      throw new Error("NUCS domain header exceeds bound");
    }
  }
  throw new Error("Missing NUCS domain series");
}
export async function captureNucsFlowEvidence(
  query: NucsFlowQuery,
  token: string,
  writeNative: NucsNativeWriter,
  available: { id: string; evidence: NucsFlowEvidence } | null,
  fetchProvider: typeof fetch = fetch,
): Promise<NucsFlowEvidence> {
  const empty = {
    request: query,
    http_status: null,
    body_sha256: null,
    error_code: null,
    raw_base64: null,
  };
  if (!token) {
    return {
      ...empty,
      status: "transport_error",
      error_code: "nucs_token_not_configured",
    };
  }
  const spec = NUCS_FLOW_PRODUCTS[query.dataset];
  if (spec.product === "domain") {
    if (
      !available || available.evidence.status !== "data" ||
      available.evidence.document.horizon !== spec.horizon
    ) {
      return {
        ...empty,
        status: "no_data",
        error_code: "nucs_linked_publication_unavailable",
      };
    }
    if (
      available.evidence.request.dataset !==
        query.dataset.replace("_domain", "_available")
    ) throw new Error("NUCS linked product mismatch");
    const publications: NucsDomainArchive["publications"] = [];
    const native_archives: { path: string; sha256: string; bytes: number }[] =
      [];
    for (const source of available.evidence.document.publications) {
      const url = new URL("https://www.nucs.net/api");
      // Download the exact linked publication bundle. The time-based IG183 route times out at NUCS.
      url.search = nucsFlowParameters({
        provider: "nucs",
        ...query,
        publication_id: source.id,
        publication_revision: source.revision,
      }).toString();
      url.searchParams.set("securityToken", token);
      const held = await readMarketProvider(url, token, fetchProvider, {
        maxBytes: 64 * 1024 * 1024,
        timeoutMs: 120_000,
      });
      if (!held) {
        return {
          ...empty,
          native_archives,
          status: "transport_error",
          error_code: "nucs_transport_failed",
        };
      }
      if (held.http_status < 200 || held.http_status >= 300) {
        return {
          ...empty,
          native_archives,
          status: "provider_error",
          http_status: held.http_status,
          body_sha256: held.body_sha256,
          raw_base64: marketBodyBase64(held.bytes),
          error_code: "http_" + held.http_status,
        };
      }
      const path = "nucs/" + held.body_sha256 + ".zip";
      await writeNative(path, held.bytes);
      native_archives.push({
        path,
        sha256: held.body_sha256,
        bytes: held.bytes.length,
      });
      let domain: Awaited<ReturnType<typeof nucsDomainMember>>;
      let header: NucsPublication;
      try {
        domain = await nucsDomainMember(held.bytes);
        header = await archivedDomainHeader(domain.member, query.dataset);
        if (
          !header.related_documents.some((r) =>
            r.id === source.id && r.revision === source.revision
          )
        ) throw new Error("Unlinked NUCS domain");
      } catch {
        return {
          ...empty,
          native_archives,
          status: "parse_error",
          http_status: held.http_status,
          body_sha256: held.body_sha256,
          error_code: "unsupported_or_invalid_nucs_domain",
        };
      }
      publications.push({
        ...header,
        kind: "domain_archive",
        archive: {
          bucket: NUCS_NATIVE_BUCKET,
          path,
          sha256: held.body_sha256,
          bytes: held.bytes.length,
          member: domain.name,
          expanded_bytes: domain.expanded_bytes,
        },
      });
    }
    if (!publications.length) {
      return {
        ...empty,
        status: "no_data",
        error_code: "nucs_linked_publication_unavailable",
      };
    }
    return {
      ...empty,
      native_archives,
      status: "data",
      http_status: 200,
      document: {
        provider: "nucs",
        semantics: "indicative_forecasted_flow_based_domain",
        horizon: spec.horizon,
        source_observation_id: available.id,
        publications,
      },
    };
  }
  const url = new URL("https://www.nucs.net/api");
  url.search = nucsFlowParameters({ provider: "nucs", ...query }).toString();
  url.searchParams.set("securityToken", token);
  const held = await readMarketProvider(url, token, fetchProvider);
  if (!held) {
    return {
      ...empty,
      status: "transport_error",
      error_code: "nucs_transport_failed",
    };
  }
  const evidence = {
    ...empty,
    http_status: held.http_status,
    body_sha256: held.body_sha256,
    raw_base64: marketBodyBase64(held.bytes),
  };
  try {
    const publications: NucsFlowDocument["publications"] = [];
    let absent = 0;
    const bodies = await marketXmlBodies(held.bytes, POSITION_LIMITS);
    for (const body of bodies) {
      const publication = parseNucsFlowXml(body, query);
      if (publication) publications.push(publication);
      else absent++;
    }
    if (absent && !publications.length) {
      return { ...evidence, status: "no_data", error_code: "no_matching_data" };
    }
    if (absent || !publications.length) {
      throw new Error("Incomplete NUCS publication set");
    }
    if (held.http_status < 200 || held.http_status >= 300) {
      return {
        ...evidence,
        status: "provider_error",
        error_code: "http_" + held.http_status,
      };
    }
    return {
      ...evidence,
      status: "data",
      document: {
        provider: "nucs",
        semantics: "indicative_forecasted_flow_based_domain",
        horizon: spec.horizon,
        publications,
      },
    };
  } catch {
    return {
      ...evidence,
      status: "parse_error",
      error_code: "unsupported_or_invalid_nucs_document",
    };
  }
}
