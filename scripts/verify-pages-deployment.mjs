import { readdir } from "node:fs/promises";
import path from "node:path";

const [distArgument, originArgument] = process.argv.slice(2);
if (!distArgument || !originArgument) {
  throw new Error(
    "Usage: node scripts/verify-pages-deployment.mjs <dist-directory> <origin>",
  );
}

const distDirectory = path.resolve(distArgument);
const origin = new URL(originArgument);
const retryDelaysMs = [0, 1_000, 2_000, 4_000, 8_000, 15_000];
const concurrency = 16;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(absolutePath);
    if (!entry.isFile() || entry.name === "_headers" || entry.name === "_redirects") {
      return [];
    }
    return [absolutePath];
  }));
  return nested.flat();
}

function remoteUrl(filePath) {
  const relativePath = path.relative(distDirectory, filePath);
  const encodedPath = relativePath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(encodedPath, `${origin.href.replace(/\/$/, "")}/`).href;
}

function expectedContentType(filePath) {
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".html")) return "text/html";
  return null;
}

async function checkFile(filePath) {
  const url = remoteUrl(filePath);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const expectedType = expectedContentType(filePath);
    if (!response.ok) {
      return `${url} returned HTTP ${response.status}`;
    }
    if (expectedType && !contentType.toLowerCase().includes(expectedType)) {
      return `${url} returned ${contentType || "no Content-Type"}`;
    }
    return null;
  } catch (error) {
    return `${url} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function checkFiles(filePaths) {
  const failures = [];
  for (let index = 0; index < filePaths.length; index += concurrency) {
    const batch = filePaths.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(checkFile));
    for (let offset = 0; offset < results.length; offset += 1) {
      if (results[offset]) failures.push({
        filePath: batch[offset],
        message: results[offset],
      });
    }
  }
  return failures;
}

const files = await collectFiles(distDirectory);
let pending = files;
for (const delayMs of retryDelaysMs) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const failures = await checkFiles(pending.map((failure) => (
    typeof failure === "string" ? failure : failure.filePath
  )));
  if (failures.length === 0) {
    pending = [];
    break;
  }
  pending = failures;
}

if (pending.length > 0) {
  throw new Error(
    `Cloudflare did not serve ${pending.length} deployed file(s):\n${
      pending.slice(0, 20).map((failure) => `- ${failure.message}`).join("\n")
    }`,
  );
}

const missingAssetUrl = new URL(
  `/assets/__deployment-check-missing-${Date.now()}.js`,
  origin,
);
const missingAssetResponse = await fetch(missingAssetUrl, {
  method: "HEAD",
  cache: "no-store",
  headers: { "cache-control": "no-cache" },
});
const missingAssetCacheControl = missingAssetResponse.headers.get("cache-control") ?? "";
const missingAssetIsNotCacheable = /(?:^|,)\s*(?:no-store|no-cache|max-age=0)\b/i
  .test(missingAssetCacheControl);
if (
  missingAssetResponse.status !== 404
  || !missingAssetIsNotCacheable
) {
  throw new Error(
    `Missing asset handling is unsafe: ${missingAssetUrl.href} returned HTTP ${
      missingAssetResponse.status
    } with Cache-Control "${missingAssetCacheControl}".`,
  );
}

const spaRouteUrl = new URL(
  "/portal/__deployment-verification__/energy-history",
  origin,
);
const spaRouteResponse = await fetch(spaRouteUrl, {
  method: "HEAD",
  cache: "no-store",
  headers: { "cache-control": "no-cache" },
});
const spaRouteContentType = spaRouteResponse.headers.get("content-type") ?? "";
if (
  !spaRouteResponse.ok
  || !spaRouteContentType.toLowerCase().includes("text/html")
) {
  throw new Error(
    `SPA deep-link handling is broken: ${spaRouteUrl.href} returned HTTP ${
      spaRouteResponse.status
    } with Content-Type "${spaRouteContentType}".`,
  );
}

console.log(
  `Verified ${files.length} deployed files, SPA routing, and safe missing-asset handling at ${origin.href}`,
);
