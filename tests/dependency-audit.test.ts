import { assertEquals, assertThrows } from "@std/assert";
import {
  addDenoLock,
  addPackageLock,
  type Advisories,
  denoNpmKey,
  esmShPackage,
  findings,
  Inventory,
  parseAllowances,
  verdict,
} from "../scripts/lib/dependency-audit.ts";

const zod: Advisories = {
  zod: [{ url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5", title: "memory", severity: "high", vulnerable_versions: "<4.6.6" }],
};

Deno.test("esm.sh URLs yield exact resolved packages and skip ranges", () => {
  assertEquals(esmShPackage("https://esm.sh/@supabase/supabase-js@2.57.2/denonext/supabase-js.mjs"), { name: "@supabase/supabase-js", version: "2.57.2" });
  assertEquals(esmShPackage("https://esm.sh/stripe@17.7.0?target=deno"), { name: "stripe", version: "17.7.0" });
  assertEquals(esmShPackage("https://esm.sh/v135/qs@6.17.1/deno/qs.mjs"), { name: "qs", version: "6.17.1" });
  assertEquals(esmShPackage("https://esm.sh/@supabase/supabase-js@2"), null);
  assertEquals(esmShPackage("https://esm.sh/node/buffer.mjs"), null);
  assertEquals(esmShPackage("https://deno.land/std@0.190.0/http/server.ts"), null);
});

Deno.test("Deno lock npm keys drop peer suffixes", () => {
  assertEquals(denoNpmKey("zod@3.25.76"), { name: "zod", version: "3.25.76" });
  assertEquals(denoNpmKey("@noble/hashes@2.4.0"), { name: "@noble/hashes", version: "2.4.0" });
  assertEquals(denoNpmKey("react-dom@18.3.1_react@18.3.1"), { name: "react-dom", version: "18.3.1" });
});

Deno.test("an edge-function pin the website lockfile does not have is still audited", () => {
  const inventory = new Inventory();
  addPackageLock(inventory, { packages: { "": { name: "site" }, "node_modules/zod": { version: "4.6.7" } } }, "package-lock.json");
  const unaudited = addDenoLock(inventory, {
    npm: { "zod@3.25.76": {} },
    remote: { "https://esm.sh/zod@3.22.0/denonext/zod.mjs": "x", "https://deno.land/std@0.190.0/http/server.ts": "y" },
  }, "edge function energy-optimisation-ingest");
  assertEquals(unaudited, ["deno.land/std@0.190.0"]);
  const found = findings(inventory, zod);
  assertEquals(found.map((f) => `${f.name}@${f.version} ${f.id} ${f.sources.join("+")}`), [
    "zod@3.22.0 GHSA-mrhx-c7xc-m3w5 edge function energy-optimisation-ingest",
    "zod@3.25.76 GHSA-mrhx-c7xc-m3w5 edge function energy-optimisation-ingest",
  ]);
});

Deno.test("nested package-lock copies are audited under their package name", () => {
  const inventory = new Inventory();
  addPackageLock(inventory, { packages: {
    "node_modules/minimatch": { version: "3.1.5" },
    "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch": { version: "10.2.6" },
    "node_modules/local": { version: "1.0.0", link: true },
  } }, "package-lock.json");
  assertEquals([...inventory.packages.get("minimatch")!].sort(), ["10.2.6", "3.1.5"]);
  assertEquals(inventory.packages.has("local"), false);
});

Deno.test("high blocks, moderate is a note, and only an unexpired allowance clears a block", () => {
  const inventory = new Inventory();
  inventory.add("zod", "3.25.76", "edge");
  inventory.add("fflate", "0.8.2", "edge");
  const found = findings(inventory, {
    ...zod,
    fflate: [{ url: "https://github.com/advisories/GHSA-px8p-9vwx-vf98", title: "loop", severity: "moderate", vulnerable_versions: ">= 0.8.0 < 0.8.3" }],
  });
  const plain = verdict(found, [], "2026-11-07");
  assertEquals(plain.blocking.map((f) => f.name), ["zod"]);
  assertEquals(plain.notes.map((f) => f.name), ["fflate"]);

  const allowance = { id: "GHSA-mrhx-c7xc-m3w5", reason: "No fix released yet", expires: "2026-11-30" };
  assertEquals(verdict(found, [allowance], "2026-11-07").blocking, []);
  const lapsed = verdict(found, [allowance], "2026-12-01");
  assertEquals(lapsed.blocking.map((f) => f.name), ["zod"]);
  assertEquals(lapsed.expired, [allowance]);
});

Deno.test("patched versions and unrelated packages do not match", () => {
  const inventory = new Inventory();
  inventory.add("zod", "4.6.7", "package-lock.json");
  inventory.add("left-pad", "1.3.0", "package-lock.json");
  assertEquals(findings(inventory, zod), []);
});

Deno.test("an unparseable range is reported rather than hidden", () => {
  const inventory = new Inventory();
  inventory.add("zod", "4.6.7", "package-lock.json");
  const found = findings(inventory, { zod: [{ ...zod.zod[0], vulnerable_versions: "not a range" }] });
  assertEquals(found.length, 1);
});

Deno.test("allowlist entries need a GHSA id, a reason and an expiry", () => {
  assertEquals(parseAllowances('{"advisories":[]}'), []);
  assertThrows(() => parseAllowances('{"advisories":[{"id":"CVE-1","reason":"long enough reason","expires":"2026-12-01"}]}'));
  assertThrows(() => parseAllowances('{"advisories":[{"id":"GHSA-mrhx-c7xc-m3w5","reason":"","expires":"2026-12-01"}]}'));
  assertThrows(() => parseAllowances('{"advisories":[{"id":"GHSA-mrhx-c7xc-m3w5","reason":"long enough reason","expires":"soon"}]}'));
});
