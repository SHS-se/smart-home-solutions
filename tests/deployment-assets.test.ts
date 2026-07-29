import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const headers = await Deno.readTextFile("public/_headers");
const redirects = await Deno.readTextFile("public/_redirects");
const notFoundPage = await Deno.readTextFile("public/404.html");

Deno.test("missing deployment chunks cannot poison the immutable browser cache", () => {
  assertStringIncludes(headers, "/assets/*");
  assertStringIncludes(
    headers,
    "Cache-Control: public, max-age=0, must-revalidate",
  );
  assertStringIncludes(headers, "/404.html\n  Cache-Control: no-store");
  const cacheControlHeaders = headers
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.startsWith("cache-control:"));
  assert(
    !cacheControlHeaders.some((line) => line.includes("immutable")),
    "asset responses must not be marked immutable while the SPA fallback can answer asset paths",
  );

  const redirectRules = redirects
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert(
    !redirectRules.some((line) => line.startsWith("/* ")),
    "a global SPA rewrite would turn missing build assets into HTML responses",
  );
  assert(
    redirectRules.some((line) => line.startsWith("/portal/*")),
    "portal deep links must still load the SPA",
  );
  assert(
    redirectRules.some((line) => line.startsWith("/accounting/*")),
    "accounting deep links must still load the SPA",
  );
  assertStringIncludes(notFoundPage, "<meta name=\"robots\" content=\"noindex\"");
  assertEquals(notFoundPage.includes("Page not found"), true);
});
