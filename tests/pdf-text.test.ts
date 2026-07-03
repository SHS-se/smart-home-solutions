import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { wrapTextByWidth } from "../supabase/functions/_shared/pdf-text.ts";

Deno.test("wrapTextByWidth wraps text without adding ellipses", () => {
  const text = "Smart Home Solutions Prenumeration (at 249.00 kr / day) - Giltighetsperiod: 2026-07-03 - 2026-07-04";
  const lines = wrapTextByWidth(text, 34, (value) => value.length);

  assert(lines.length > 1);
  assert(lines.every((line) => !line.includes("...")));
  assert(lines.every((line) => line.length <= 34));
  assertEquals(lines.join(" "), text);
});

Deno.test("wrapTextByWidth splits a long unbroken word", () => {
  const lines = wrapTextByWidth("abcdefghij", 4, (value) => value.length);

  assertEquals(lines, ["abcd", "efgh", "ij"]);
});
