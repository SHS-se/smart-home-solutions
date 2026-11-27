import { assert, assertEquals, assertThrows, assertRejects } from "@std/assert";
import { ownedPlanningBase64, unpackOwnedPlanningValue, OwnedPlanningArtifactError } from "./owned-planning-codec.ts";
import { compressForecastValue, decompressForecastValue, encodeForecastCatalogPages, forecastCatalogRecordText } from "./room-forecast-catalog.ts";

Deno.test("synthetic posterior catalog addresses UTF-8 records without splitting or dropping oversized states", () => {
  const records = [{ label: "synthetic α", covariance: [[.01, -.002], [-.002, .5]] },
    { label: "synthetic β", covariance: Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) => i === j ? .5 : 0)) },
    { label: "synthetic γ", log_weight: -20000 }];
  const pages = encodeForecastCatalogPages(records, 100);
  assertEquals(pages.map(page => page.first_record), [0, 1, 2]);
  assert(pages[1].bytes.length > 100, "a large covariance is preserved on its own page");
  assertEquals(pages.map(page => JSON.parse(forecastCatalogRecordText(page, page.first_record))), records);
  assertEquals(encodeForecastCatalogPages([]), []);
  assertThrows(() => encodeForecastCatalogPages([{ covariance: [[NaN]] }]), Error, "Non-finite");
  assertThrows(() => encodeForecastCatalogPages([{ log_weight: Infinity }]), Error, "Non-finite");
  assertThrows(() => forecastCatalogRecordText(pages[0], 1), Error, "record range");
  assertThrows(() => forecastCatalogRecordText({ ...pages[1], offsets: [0, pages[1].bytes.length + 1] }, 1), Error, "record range");
});

Deno.test("multiple native records share a page and retain their original indexes", () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ index, mean: Math.sin(index) }));
  const pages = encodeForecastCatalogPages(records, 170);
  assert(pages.some(page => page.count > 1));
  for (const [index, expected] of records.entries()) {
    const page = pages.find(page => index >= page.first_record && index < page.first_record + page.count)!;
    assertEquals(JSON.parse(forecastCatalogRecordText(page, index)), expected);
  }
});

Deno.test("compressed immutable forecast context round trips exact synthetic JSON", async () => {
  const context = { identity: "synthetic", values: Array.from({ length: 5000 }, (_, i) => [i, Math.sin(i), null]), label: "σynthetic" };
  const bytes = await compressForecastValue(context);
  assert(bytes.length < new TextEncoder().encode(JSON.stringify(context)).length);
  assertEquals(await decompressForecastValue(bytes), context);
  const encoded = ownedPlanningBase64(bytes);
  assertEquals(await unpackOwnedPlanningValue(encoded), context);
  assertEquals(await unpackOwnedPlanningValue(" \n" + encoded.replace(/=+$/, "")), context);
  await assertRejects(() => unpackOwnedPlanningValue("invalid!"), OwnedPlanningArtifactError);
  await assertRejects(() => unpackOwnedPlanningValue(btoa("invalid gzip")), OwnedPlanningArtifactError);
});
