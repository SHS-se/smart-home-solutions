import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  MAX_EXECUTABLE_LEVELS,
  powerEnvelope,
  powerEnvelopeError,
  relayEnvelope,
} from "./power-envelope.ts";

/**
 * The level enumerator from `dispatch-plan.ts:1982`, reproduced exactly.
 *
 * §8.13 is a property of the envelope *as the search consumes it*, so asserting
 * it against a paraphrase would prove nothing. This is the loop verbatim; if it
 * changes there and not here, the third test below stops guarding anything.
 */
function executablePowerLevels(
  store: { min_power_w?: number; power_step_w?: number },
  rawLevels: number[],
  maximumW: number,
): number[] {
  const out: number[] = [];
  const addLevel = (level: number) => {
    if (!out.includes(level)) out.push(level);
  };
  const minimumW = Math.max(0, store.min_power_w ?? 0);
  const stepW = Math.max(0, store.power_step_w ?? 0);
  if (stepW > 0 && maximumW + 1e-9 >= minimumW) {
    for (let level = minimumW; level <= maximumW + 1e-9; level += stepW) {
      const rounded = Math.round(level * 1e6) / 1e6;
      if (rounded > 1e-9 && rounded <= maximumW + 1e-9) addLevel(rounded);
    }
  }
  for (const raw of rawLevels) {
    let level = Math.min(maximumW, raw);
    if (level <= 1e-9 || level + 1e-9 < minimumW) continue;
    if (stepW > 0) {
      level = minimumW + Math.floor((level - minimumW) / stepW + 1e-9) * stepW;
    }
    level = Math.round(level * 1e6) / 1e6;
    if (level > 1e-9 && level <= maximumW + 1e-9) addLevel(level);
  }
  return out;
}

const levelsFor = (
  envelope: { max_power_w: number; min_power_w: number; power_step_w: number },
  rawLevels: number[],
) => executablePowerLevels(envelope, rawLevels, envelope.max_power_w);

// The fractions that provoked §8.13: a pool relay planned at 38 W, 59 W and
// 340 W while tracking a solar peak.
const PV_FRACTIONS = [38, 59, 340, 1200, 2600, 3499.5];

Deno.test("a fixed_power control with no floor is a relay", () => {
  assertEquals(powerEnvelope({ type: "fixed_power", power_w: 3500 }), {
    max_power_w: 3500,
    min_power_w: 3500,
    power_step_w: 0,
  });
});

Deno.test("an explicitly undefined floor is still a relay", () => {
  assertEquals(
    powerEnvelope({
      type: "fixed_power",
      power_w: 3500,
      min_power_w: undefined,
      power_step_w: undefined,
    }),
    relayEnvelope(3500),
  );
});

Deno.test("§8.13: a relay can only ever be bid at its rated power", () => {
  const envelope = powerEnvelope({ type: "fixed_power", power_w: 3500 });
  // Not one fraction the solar peak proposes reaches the rated power, so the
  // relay is simply not offered. This is the bug: before the floor existed,
  // every one of these became a bid.
  assertEquals(levelsFor(envelope, PV_FRACTIONS), []);
  // Once the value justifies the whole load it is offered, at exactly one
  // level, however it was proposed.
  assertEquals(levelsFor(envelope, [9000, 3500, 4000, 1]), [3500]);
  // The property itself: no bid is ever a fraction of the rated power.
  for (const raws of [PV_FRACTIONS, [9000], [3500], [3499.999], [0]]) {
    assert(
      levelsFor(envelope, raws).every((level) => level === 3500),
      `a relay was bid at a fraction: ${levelsFor(envelope, raws)}`,
    );
  }
});

Deno.test("the EV envelope reproduces the three wattsPerAmp products", () => {
  // The exact arithmetic at energy-optimisation.ts:2656-2658 before this parser.
  const control = {
    type: "discrete_current" as const,
    min_current_a: 6,
    max_current_a: 16,
    current_step_a: 1,
    phase_count: 3,
    voltage_v: 230,
  };
  const wattsPerAmp = control.phase_count * control.voltage_v;
  assertEquals(powerEnvelope(control), {
    max_power_w: wattsPerAmp * control.max_current_a,
    min_power_w: wattsPerAmp * control.min_current_a,
    power_step_w: wattsPerAmp * control.current_step_a,
  });
  assertEquals(powerEnvelope(control), {
    max_power_w: 11040,
    min_power_w: 4140,
    power_step_w: 690,
  });
});

Deno.test("a single-phase charger is not modelled at three times its power", () => {
  const envelope = powerEnvelope({
    type: "discrete_current",
    min_current_a: 6,
    max_current_a: 16,
    current_step_a: 1,
    phase_count: 1,
    voltage_v: 230,
  });
  assertEquals(envelope.max_power_w, 3680);
});

Deno.test("a modulating pool offers levels between its floor and ceiling", () => {
  // Phil's Nibe: reviewed 2.0 kW to 8.0 kW electrical, plus a 764 W
  // circulation pump that runs with it on a relay.
  const envelope = powerEnvelope({
    type: "fixed_power",
    power_w: 8764,
    min_power_w: 2764,
    power_step_w: 500,
  });
  assertEquals(envelope.max_power_w, 8764);
  assertEquals(envelope.min_power_w, 2764);

  const levels = levelsFor(envelope, PV_FRACTIONS);
  assert(levels.length > 1, "a modulating device must offer more than one level");
  assert(
    levels.every((level) => level >= 2764 - 1e-6),
    `no level may fall below the floor: ${levels}`,
  );
  assert(levels.includes(8764), "full power must stay reachable");
  // Nothing below the floor survives, so the PV fractions that broke the relay
  // are still refused here.
  assert(!levels.some((level) => level < 2764));
});

Deno.test("both ends stay on the grid when the band is coarsened", () => {
  // 1 kW thermal at COP 4.3 is a ~230 W electrical increment: 27 intervals
  // across Phil's band, more than the search should carry.
  const envelope = powerEnvelope({
    type: "fixed_power",
    power_w: 8764,
    min_power_w: 2764,
    power_step_w: 230,
  });
  const levels = levelsFor(envelope, []);
  assert(
    levels.length <= MAX_EXECUTABLE_LEVELS,
    `coarsening must bound the level count, got ${levels.length}`,
  );
  // The stranding bug this rule exists to prevent: a step that does not divide
  // the band leaves the ceiling unreachable and the pool can never run flat out.
  assert(
    levels.includes(8764),
    `max must remain on the grid after coarsening: ${levels}`,
  );
  // The floor itself is the first executable level, not the first step above it.
  assertEquals(levels[0], 2764);
  assertEquals(envelope.power_step_w, 400);
});

Deno.test("a band narrower than one step is just its two ends", () => {
  const envelope = powerEnvelope({
    type: "fixed_power",
    power_w: 8000,
    min_power_w: 6000,
    power_step_w: 4000,
  });
  // One interval: the band collapses to its two ends and nothing between.
  assertEquals(envelope.power_step_w, 2000);
  assertEquals(levelsFor(envelope, []), [6000, 8000]);
});

Deno.test("a floor equal to the ceiling is a relay with a floor", () => {
  const envelope = powerEnvelope({
    type: "fixed_power",
    power_w: 5000,
    min_power_w: 5000,
    power_step_w: 500,
  });
  assertEquals(envelope.power_step_w, 0);
  // Indistinguishable from a relay, which is the point: a step declared across
  // a zero-width band cannot conjure a level.
  assertEquals(levelsFor(envelope, PV_FRACTIONS), []);
  assertEquals(levelsFor(envelope, [7000]), [5000]);
});

Deno.test("a floor above the ceiling still yields a plannable envelope", () => {
  // Clamped rather than thrown: one badly reviewed number must not stop the
  // home being planned. The error is reported separately.
  const envelope = powerEnvelope({
    type: "fixed_power",
    power_w: 3000,
    min_power_w: 9000,
  });
  assertEquals(envelope, relayEnvelope(3000));
  assertEquals(
    powerEnvelopeError({
      type: "fixed_power",
      power_w: 3000,
      min_power_w: 9000,
    }),
    "min_power_w must not exceed power_w",
  );
});

Deno.test("powerEnvelopeError accepts every shape today's integrations send", () => {
  assertEquals(
    powerEnvelopeError({ type: "fixed_power", power_w: 3500 }),
    null,
  );
  assertEquals(
    powerEnvelopeError({
      type: "discrete_current",
      min_current_a: 6,
      max_current_a: 16,
      current_step_a: 1,
      phase_count: 3,
      voltage_v: 230,
    }),
    null,
  );
});

Deno.test("powerEnvelopeError names the contradictions", () => {
  assertEquals(
    powerEnvelopeError({
      type: "fixed_power",
      power_w: 8000,
      power_step_w: 500,
    }),
    "power_step_w requires min_power_w",
  );
  assertEquals(
    powerEnvelopeError({ type: "fixed_power", power_w: 8000, min_power_w: 0 }),
    "min_power_w must be a positive number of watts",
  );
  assertEquals(
    powerEnvelopeError({
      type: "fixed_power",
      power_w: 8000,
      min_power_w: 2000,
      power_step_w: -1,
    }),
    "power_step_w must be a positive number of watts",
  );
});
