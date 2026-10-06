import { assert, assertEquals } from "jsr:@std/assert@1";
import { PairPricingBook } from "./pair-pricing-book.ts";
import { createDispatchWorkCounts, dispatchAuctionSteps, type DispatchSlot, type DispatchStore,
  type DispatchLimits, type DispatchCheckpoint, type DispatchResult } from "./dispatch-plan.ts";

Deno.test("a cached NaN level remains observable against an infinite incumbent", () => {
  const book = new PairPricingBook(1);
  const pair = book.prepare(0, 0, 10);
  book.record(pair, 0, 10, NaN, true);
  book.record(pair, 1, 5, 1, true);
  assert(book.canBeat(pair, Infinity));
  assert(book.canBeat(pair, NaN));
  assert(Number.isNaN(book.score(pair, 0)));
});

/** Full-output references captured from the solver before pair pricing reuse. */
const references = [
  "ffddc6cfd32aa75ad659004a5ed18c4d90cde4601f83c434b6625c17bd9c2fde",
  "503cab021620ac897c8f4cd20f0266a272d2a600cf14663485dd564557fecba4",
  "ccf6278e641e93575d35474ee4cff6365fa310f75dd19251f8abaebe6af657b7",
  "f9e2f74b006c2b4b9e57ba766e1d7e4dd83b7abd9f359a801ead6b7a4e6bf5cd",
  "85a6fa049e7487e809e9e080f4eafafcb7beef9c5942d72a8bf790503bf96363",
  "a126f61405151cbce6d65378106858503fe660f97791eb8ecae0956dad00c666",
  "2790ea3769c866d7b456d36d553ead02002fc392b791c4d893a8ff4deef571df",
  "8674baaefee709dd920007ec8bcdd90dedaa341c96ea4c61379486683159ddfe",
  "6070b48b10729ace2fe2a1fffaaa9be2a87585638f6d72db23cca7c9f25451ed",
  "138e12358d53936dd8ee8789d9c6c1baf73d470faf669e69b629d31410dbadf2",
  "d54533db3450ac6e2974ce81cf1a0de1c2b1e1cb51580eec754b54dc2a59cb3c",
  "a2b24f8cfdbba1a70a2cfc3429c85f02157183d6159045557fdb471242079e2f"
];

function transferCase(seed: number) {
  const count = 24;
  const slots: DispatchSlot[] = Array.from({length: count}, (_, i) => ({
    duration_hours: .1 + (i % 4) * .05,
    pv_w: i % 6 < 2 ? 3500 : 0,
    fixed_load_w: 800 + (i % 4) * 700,
    import_price_sek_per_kwh: i % 7 === 0 ? -.25 : .4 + ((i * seed) % 7) * .28,
    export_price_sek_per_kwh: .1 + ((i * seed) % 3) * .07,
    binding: i < 12,
    published_price: i < 16,
  }));
  // Two packs compete for the same grid/solar capacity. The first changes its
  // conversion rates across state thresholds; durations and prices vary too.
  const stores: DispatchStore[] = Array.from({length: 2}, (_, k) => ({
    key: "pack-" + k,
    curve: {unit: "kwh", points: [{at: 4, sek_per_unit: 1.7 - k * .2}, {at: 12, sek_per_unit: .5}]},
    initial_state: 3.4 + k * 1.3,
    min_state: 0,
    max_state: 12,
    max_power_w: 5000 + k * 500,
    retention_per_slot: 1,
    usage_weight: Array(count).fill(0),
    terminal_weight: 1,
    slot_hours: slots.map(slot => slot.duration_hours!),
    units_per_kwh: state => k === 0 ? (state > 4 ? .94 : .91) : .96,
    drift: state => state,
    discharge: {
      max_power_w: 6000,
      state_per_kwh_out: state => k === 0 ? (state > 5 ? 1 / .92 : 1 / .95) : 1 / .94,
      export_allowed: true,
      export_min_state: 1.2,
      cycling_cost_sek_per_unit: .02,
    },
  }));
  const limits: DispatchLimits = {grid_import_limit_w: 13200, grid_export_limit_w: 13200,
    grid_import_shaping_w: 1000, peak_shaping_sek_per_kwh_per_kw: .4};
  return {slots, stores, limits};
}

for (const [index, expected] of references.entries()) {
  Deno.test(`pair prices preserve full output for mixed-physics transfer case ${index + 1}`, async () => {
    const {slots, stores, limits} = transferCase(index + 1);
    const work = createDispatchWorkCounts();
    const search = dispatchAuctionSteps(slots, stores, limits, {work});
    let step = search.next();
    while (!step.done) step = search.next();
    const encoded = JSON.stringify(step.value);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
    const fingerprint = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    assertEquals(fingerprint, expected);
    assert(work.pair_pricing_hits > 0, "case must exercise reused pair prices");

    let checkpoint: DispatchCheckpoint | undefined;
    let result: DispatchResult | undefined;
    for (let request = 0; request < 10_000; request++) {
      let primitives = 0;
      const next = dispatchAuctionSteps(slots, stores, limits, {}, checkpoint, () => ++primitives > 200).next();
      if (next.done) { result = next.value; break; }
      checkpoint = JSON.parse(JSON.stringify(next.value));
    }
    assert(result, "serialized solver must complete");
    assertEquals(JSON.stringify(result), encoded);
  });
}
