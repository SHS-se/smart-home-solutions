import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { acquireSwedishHydrology, parseHydroText, SWEDISH_HYDRO_REQUEST } from "../supabase/functions/_shared/reservoir-hydrology.ts";

const MODIFIED = "Wed, 21 Oct 2026 11:00:52 GMT";
function report(week = 42, version = "A", year = 2026, storage = "1 806", filling = "63,5", inflow = "1 059", median = "91") {
  return `Kraftläget i Sverige Vecka ${week} 12 okt - 18 okt år ${year} , version: ${version}
  Beräknad tillrinnings-\nenergi för vecka ${year}-${String(week).padStart(2, "0")} blev ${inflow} GWh, vilket är ${median} % av medianvärdet under perioden 1960-2025.
  Det totala magasinets energiinnehåll är beräknat till 25 062 GWh denna vecka.
  Magasinsändring under veckan från 75,3 % till 74,7 % (vid veckans slut).
  Medelvärdet för magasins- fyllnaden under perioden 1960-2025 är 80,7 %.
  Elområde Procent GWh SE1 70,0 10 366 SE2 82,0 12 848 SE3 ${filling} ${storage} SE4 19,1 42 0 10 20 30`;
}

Deno.test("Swedish hydro parsing preserves SE3 storage and Sweden inflow geography, numbers and report version", () => {
  assertEquals(parseHydroText(report(), MODIFIED), {
    isoYear: 2026, isoWeek: 42, version: "A", weekEnd: "2026-10-18T22:00:00.000Z",
    providerModifiedAt: "2026-10-21T11:00:52.000Z", se3StoredGwh: 1806, se3FillingPercent: 63.5,
    swedenInflowGwh: 1059, swedenInflowMedianPercent: 91, swedenFillingPercent: 74.7, swedenNormalFillingPercent: 80.7,
  });
  const nonbreaking = report().replaceAll(" ", "\u00a0");
  assertEquals(parseHydroText(nonbreaking, null).se3StoredGwh, 1806);
  assertEquals(parseHydroText(report(33, "B", 2026, "1 926", "67,7", "1 198", "105"), MODIFIED).version, "B");
  assertEquals(parseHydroText(report(), "not-a-publication-date").providerModifiedAt, null);
});

Deno.test("Swedish hydro numeric layout parses audited historical weeks without chart-axis contamination", () => {
  const samples = [
    [1, "A", "2 217", "66,8", "829", "180", "2026-01-04T23:00:00.000Z"],
    [33, "B", "1 926", "67,7", "1 198", "105", "2026-08-16T22:00:00.000Z"],
    [39, "A", "1 730", "60,8", "1 192", "104", "2026-09-27T22:00:00.000Z"],
    [40, "A", "1 705", "59,9", "976", "86", "2026-10-04T22:00:00.000Z"],
    [41, "A", "1 782", "62,6", "1 296", "111", "2026-10-11T22:00:00.000Z"],
  ] as const;
  for (const [week, version, storage, filling, inflow, median, end] of samples) {
    const parsed = parseHydroText(report(week, version, 2026, storage, filling, inflow, median), null);
    assertEquals(parsed.se3StoredGwh, Number(storage.replaceAll(" ", "")));
    assertEquals(parsed.swedenInflowGwh, Number(inflow.replaceAll(" ", "")));
    assertEquals(parsed.weekEnd, end);
  }
});

Deno.test("Swedish hydro ISO end is exclusive Stockholm Monday across year and DST changes", () => {
  assertEquals(parseHydroText(report(13), null).weekEnd, "2026-03-29T22:00:00.000Z");
  assertEquals(parseHydroText(report(43), null).weekEnd, "2026-10-25T23:00:00.000Z");
  assertEquals(parseHydroText(report(53), null).weekEnd, "2027-01-03T23:00:00.000Z");
  assertThrows(() => parseHydroText(report(54), null));
  assertThrows(() => parseHydroText(report(53, "A", 2025), null));
});

Deno.test("Swedish hydro required anchors reject incomplete or contradictory reports instead of supplying defaults", () => {
  assertThrows(() => parseHydroText("", MODIFIED));
  assertThrows(() => parseHydroText(report().replace("SE3", "SE9"), MODIFIED));
  assertThrows(() => parseHydroText(report().replace("Vecka 42", "Vecka 41"), MODIFIED));
  assertThrows(() => parseHydroText(report().replace("Medelvärdet", "Median"), MODIFIED));
  assertThrows(() => parseHydroText(report().replace("1 806 SE4", "1 806 0 10 SE4"), MODIFIED));
});

const BASE = "https://www.energiforetagen.se";
const CURRENT = `${BASE}/4a9e10/globalassets/energiforetagen/statistik/kraftlaget/aktuellt-magasinslage-sverige-veckorapport.pdf`;
const path = (week: number, version = "") => `${BASE}/abcdef/globalassets/energiforetagen/statistik/kraftlaget/tidigare-kraftlagen/2026/kraftlaget-sverige-veckorapport-vecka-2026-${week}${version}.pdf`;
function index(weeks = [42, 41, 40, 39, 38, 37]) {
  return `F&ouml;rsta halv&aring;ret 2026 ${weeks.map(week => `<a href="${path(week)}">Vecka ${week}</a>`).join(" ")}`;
}
const pdf = (week: number, version = "A") => `%PDF-${week}-${version}`;
const decodePdf = (bytes: Uint8Array) => {
  const [, week, version] = new TextDecoder().decode(bytes).split("-");
  return Promise.resolve(report(Number(week), version));
};
function provider(options: { archive?: string; current?: string; failUrl?: string; failStatus?: number; modified?: string | null } = {}) {
  const urls: string[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input); urls.push(url);
    assertEquals(init?.redirect, "error");
    assertEquals(new Headers(init?.headers).get("user-agent"), "Mozilla/5.0");
    if (url === options.failUrl) return Promise.resolve(new Response("upstream failure retained", { status: options.failStatus ?? 503 }));
    if (url === SWEDISH_HYDRO_REQUEST.landing_url) return Promise.resolve(new Response(`<a href="${CURRENT}">Aktuellt magasinsläge</a>`));
    if (url === SWEDISH_HYDRO_REQUEST.archive_url) return Promise.resolve(new Response(options.archive ?? index()));
    const week = url === CURRENT ? 42 : Number(/2026-(\d+)/.exec(url)?.[1]);
    const version = /b\.pdf$/.test(url) ? "B" : "A";
    const headers: Record<string, string> = options.modified === null ? {} : { "last-modified": options.modified ?? MODIFIED };
    return Promise.resolve(new Response(url === CURRENT ? options.current ?? pdf(week, version) : pdf(week, version), { headers }));
  };
  return { fetcher, urls };
}

Deno.test("Swedish hydro acquisition saves current plus five distinct older official reports and complete raw provenance", async () => {
  const upstream = provider();
  const result = await acquireSwedishHydrology(upstream.fetcher, decodePdf);
  assertEquals(result.status, "data");
  if (result.status !== "data") throw new Error(result.error_code);
  assertEquals(result.document.weeks.map(week => week.isoWeek), [42, 41, 40, 39, 38, 37]);
  assertEquals(result.document.reports.length, 6);
  assertEquals(upstream.urls.length, 8);
  assertEquals(result.document.reports[0].lastModified, MODIFIED);
  assertEquals(atob(result.document.reports[0].raw_base64), pdf(42));
  assertMatch(result.document.reports[0].body_sha256, /^[a-f0-9]{64}$/);
  const sources = JSON.parse(result.raw_body).sources;
  assertEquals(sources.length, 8);
  assertEquals(sources[2].extracted_text, report());
  assertEquals(result.request.page, 1);
});

Deno.test("Swedish hydro discovery selects revised weekly links once and never follows off-domain/query links", async () => {
  const archive = index().replace(`<a href="${path(41)}">Vecka 41</a>`, `<a href="${path(41)}">Vecka 41</a><a href="${path(41, "b")}">Vecka 41 B</a>`) +
    `<a href="https://attacker.test/globalassets/energiforetagen/statistik/kraftlaget/2026-43.pdf">Vecka 43</a>` +
    `<a href="${path(43)}?redirect=outside">Vecka 43</a>`;
  const upstream = provider({ archive });
  const result = await acquireSwedishHydrology(upstream.fetcher, decodePdf);
  assertEquals(result.status, "data");
  if (result.status !== "data") throw new Error(result.error_code);
  assertEquals(result.document.weeks[1].version, "B");
  assertEquals(upstream.urls.includes(path(41)), false);
  assertEquals(upstream.urls.every(url => new URL(url).origin === BASE), true);
});

Deno.test("Swedish hydro stale current revision or missing archive weeks is an explicit evidence failure", async () => {
  for (const archive of [index().replace(path(42), path(42, "b")), index([42, 41, 40])]) {
    const result = await acquireSwedishHydrology(provider({ archive }).fetcher, decodePdf);
    assertEquals(result.status, "parse_error");
    assertEquals(JSON.parse(result.raw_body).sources.length, 3);
  }
});

Deno.test("Swedish hydro failed historical request retains preceding PDFs plus failing response", async () => {
  const result = await acquireSwedishHydrology(provider({ failUrl: path(40) }).fetcher, decodePdf);
  assertEquals(result.status, "provider_error");
  assertEquals(result.http_status, 503);
  const sources = JSON.parse(result.raw_body).sources;
  assertEquals(sources.length, 5);
  assertEquals(atob(sources.at(-1).raw_base64), "upstream failure retained");
  assertMatch(sources.at(-1).body_sha256, /^[a-f0-9]{64}$/);
});

Deno.test("Swedish hydro unsupported PDF and transport failures remain archived without leaking exception text", async () => {
  const unsupported = await acquireSwedishHydrology(provider({ current: "HTML gateway response" }).fetcher, decodePdf);
  assertEquals(unsupported.status, "parse_error");
  assertEquals(atob(JSON.parse(unsupported.raw_body).sources.at(-1).raw_base64), "HTML gateway response");
  const transport = await acquireSwedishHydrology(() => { throw new Error("private-error-detail"); }, decodePdf);
  assertEquals(transport.status, "transport_error");
  assertEquals(JSON.stringify(transport).includes("private-error-detail"), false);
  assertEquals(JSON.parse(transport.raw_body).sources[0].error_code, "hydro_transport_failed");
});

Deno.test("Swedish hydro oversized responses retain a bounded marked prefix and its digest", async () => {
  const result = await acquireSwedishHydrology(() => Promise.resolve(new Response("x".repeat(2_000_001))), decodePdf);
  assertEquals(result.status, "provider_error");
  if (result.status === "data") throw new Error("Expected size failure.");
  assertEquals(result.error_code, "hydro_response_too_large");
  const source = JSON.parse(result.raw_body).sources[0];
  assertEquals(source.truncated, true);
  assertEquals(atob(source.raw_base64).length, 2_000_000);
  assertMatch(source.body_sha256, /^[a-f0-9]{64}$/);
});

Deno.test("Swedish hydro unknown publication timestamp remains null and wrong linked identities fail", async () => {
  const nullTime = await acquireSwedishHydrology(provider({ modified: null }).fetcher, decodePdf);
  assertEquals(nullTime.status, "data");
  if (nullTime.status !== "data") throw new Error(nullTime.error_code);
  assertEquals(nullTime.document.weeks.every(week => week.providerModifiedAt === null), true);
  const wrong = await acquireSwedishHydrology(provider().fetcher, () => Promise.resolve(report(42)));
  assertEquals(wrong.status, "parse_error");
  if (wrong.status === "data") throw new Error("Expected identity failure.");
  assertEquals(wrong.error_code, "hydro_archive_identity_mismatch");
});
