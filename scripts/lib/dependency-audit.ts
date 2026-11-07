/** Pure helpers for scripts/audit-dependencies.ts: collect the exact npm
 * package versions the website and the deployed edge functions resolve, and
 * match them against npm's advisory database. No I/O here.
 */
import { compare, parse, parseRange, satisfies } from "jsr:@std/semver@1";

export type Packages = Map<string, Set<string>>;
export type Severity = "critical" | "high" | "moderate" | "low" | "info";
export interface Advisory {
  url: string;
  title: string;
  severity: Severity;
  vulnerable_versions: string;
}
export type Advisories = Record<string, Advisory[]>;
export interface Allowance { id: string; reason: string; expires: string }
export interface Finding {
  name: string;
  version: string;
  id: string;
  title: string;
  severity: Severity;
  url: string;
  sources: string[];
}

const RANK: Record<Severity, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
export const BLOCKING: Severity = "high";

/** Track where each name@version came from so a report says what to upgrade. */
export class Inventory {
  readonly packages: Packages = new Map();
  readonly sources = new Map<string, Set<string>>();
  add(name: string, version: string, source: string) {
    if (!name || !version) return;
    if (!this.packages.has(name)) this.packages.set(name, new Set());
    this.packages.get(name)!.add(version);
    const key = `${name}@${version}`;
    if (!this.sources.has(key)) this.sources.set(key, new Set());
    this.sources.get(key)!.add(source);
  }
}

/** `@scope/name@1.2.3/...` or `name@1.2.3?target=deno`, after an optional
 * esm.sh build prefix (`v135/`, `stable/`). Ranges and tags are not exact
 * resolutions and are ignored; esm.sh records the resolved module separately. */
export function esmShPackage(url: string): { name: string; version: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "esm.sh") return null;
  const path = parsed.pathname.replace(/^\/(?:v\d+|stable)\//, "/");
  const match = /^\/((?:@[^/@]+\/)?[^/@]+)@([^/?]+)/.exec(path);
  if (!match || !exactVersion(match[2])) return null;
  return { name: match[1], version: match[2] };
}

/** Deno lock npm keys look like `name@1.2.3` or `name@1.2.3_peer@4.5.6`. */
export function denoNpmKey(key: string): { name: string; version: string } | null {
  const match = /^((?:@[^/@]+\/)?[^/@]+)@([^_]+)/.exec(key);
  if (!match || !exactVersion(match[2])) return null;
  return { name: match[1], version: match[2] };
}

/** deno.land/x modules that are published to npm under another name. */
const DENO_LAND_NPM: Record<string, string> = { postgresjs: "postgres" };

export function denoLandPackage(url: string): { name: string; version: string } | null {
  const match = /^https:\/\/deno\.land\/x\/([^@/]+)@v?([^/]+)\//.exec(url);
  const name = match && DENO_LAND_NPM[match[1]];
  return name && exactVersion(match[2]) ? { name, version: match[2] } : null;
}

export function addDenoLock(inventory: Inventory, lock: unknown, source: string): string[] {
  const value = lock as { npm?: Record<string, unknown>; remote?: Record<string, unknown> };
  for (const key of Object.keys(value.npm ?? {})) {
    const pkg = denoNpmKey(key);
    if (pkg) inventory.add(pkg.name, pkg.version, source);
  }
  const unaudited = new Set<string>();
  for (const url of Object.keys(value.remote ?? {})) {
    const pkg = esmShPackage(url) ?? denoLandPackage(url);
    if (pkg) inventory.add(pkg.name, pkg.version, source);
    else if (!url.startsWith("https://esm.sh/")) unaudited.add(remoteModule(url));
  }
  return [...unaudited].sort();
}

/** package-lock.json v2/v3: every installed package, including nested copies. */
export function addPackageLock(inventory: Inventory, lock: unknown, source: string) {
  const packages = (lock as { packages?: Record<string, { version?: string; name?: string; link?: boolean }> })
    .packages ?? {};
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || entry.link || !entry.version) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    inventory.add(name, entry.version, source);
  }
}

export function advisoryRequest(packages: Packages): Record<string, string[]> {
  return Object.fromEntries([...packages].sort(([a], [b]) => a < b ? -1 : 1).map(([name, versions]) => [name, [...versions].sort()]));
}

export function findings(inventory: Inventory, advisories: Advisories): Finding[] {
  const result: Finding[] = [];
  for (const [name, list] of Object.entries(advisories)) {
    for (const version of inventory.packages.get(name) ?? []) {
      for (const advisory of list) {
        if (!affects(version, advisory.vulnerable_versions)) continue;
        result.push({
          name, version, id: advisoryId(advisory.url), title: advisory.title,
          severity: advisory.severity, url: advisory.url,
          sources: [...inventory.sources.get(`${name}@${version}`) ?? []].sort(),
        });
      }
    }
  }
  return result.sort((a, b) =>
    RANK[b.severity] - RANK[a.severity] || text(a.name, b.name) || compare(parse(a.version), parse(b.version)) ||
    text(a.id, b.id)
  );
}

export interface Verdict { blocking: Finding[]; allowed: Finding[]; notes: Finding[]; expired: Allowance[] }

/** Block on high or critical advisories unless allowed by an unexpired entry. */
export function verdict(found: Finding[], allowances: Allowance[], today: string): Verdict {
  const expired = allowances.filter((entry) => entry.expires < today);
  const active = new Set(allowances.filter((entry) => entry.expires >= today).map((entry) => entry.id));
  const severe = found.filter((finding) => RANK[finding.severity] >= RANK[BLOCKING]);
  return {
    blocking: severe.filter((finding) => !active.has(finding.id)),
    allowed: severe.filter((finding) => active.has(finding.id)),
    notes: found.filter((finding) => RANK[finding.severity] < RANK[BLOCKING]),
    expired,
  };
}

export function parseAllowances(text: string): Allowance[] {
  const value = JSON.parse(text) as { advisories?: unknown };
  if (!Array.isArray(value.advisories)) throw new Error("Allowlist needs an advisories array");
  return value.advisories.map((entry, index) => {
    const { id, reason, expires } = entry as Partial<Allowance>;
    if (typeof id !== "string" || !/^GHSA(-[0-9a-z]{4}){3}$/.test(id)) throw new Error(`Allowlist entry ${index}: id must be a GHSA id`);
    if (typeof reason !== "string" || reason.trim().length < 10) throw new Error(`Allowlist entry ${index}: give a reason`);
    if (typeof expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error(`Allowlist entry ${index}: expires must be YYYY-MM-DD`);
    return { id, reason, expires };
  });
}

function affects(version: string, range: string): boolean {
  try {
    return satisfies(parse(version), parseRange(range));
  } catch {
    // An unparseable range must not hide an advisory.
    return true;
  }
}

function text(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function advisoryId(url: string): string {
  return /GHSA(-[0-9a-z]{4}){3}/.exec(url)?.[0] ?? url;
}

function exactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version);
}

function remoteModule(url: string): string {
  const match = /^https:\/\/([^/]+)\/(?:x\/)?([^/]+)/.exec(url);
  return match ? `${match[1]}/${match[2]}` : url;
}
