// The port must agree with the integration, case for case.
//
// energy-grid-pricing.ts is a second implementation of a price the customer
// actually pays, which is a genuine risk (ENERGY_OPTIMISATION_ARCHITECTURE.md
// §1.3.7.6). grid-price-parity.fixture.json holds values captured from the
// integration's tariff.py, and the identical fixture is asserted against the
// Python in the other repository. Either implementation drifting fails its own
// suite.

import {
  currentGridPrices,
  easterSunday,
  GridTariffError,
  type GridPriceConfiguration,
  type GridTariffCatalogue,
} from "./energy-grid-pricing.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./grid-price-parity.fixture.json", import.meta.url),
  ),
) as {
  fixture_version: string;
  timezone: string;
  base_configuration: GridPriceConfiguration;
  profile: GridTariffCatalogue["profiles"][number];
  cases: Array<{
    label: string;
    at: string;
    overrides: Partial<GridPriceConfiguration>;
    expected: {
      import_price_sek_per_kwh: number;
      export_price_sek_per_kwh: number;
      load_period: "high" | "low" | null;
      tariff_revision: string;
    } | null;
  }>;
};

const catalogue = (
  overrides: Partial<GridPriceConfiguration>,
): GridTariffCatalogue => ({
  timezone: fixture.timezone,
  configuration: { ...fixture.base_configuration, ...overrides },
  missing_inputs: [],
  profiles: [fixture.profile],
});

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
};

Deno.test("the fixture is the version this port was built against", () => {
  assertEquals(
    fixture.fixture_version,
    "grid-price-parity-1",
    "regenerate the port's expectations when the fixture version changes",
  );
  if (fixture.cases.length < 17) {
    throw new Error(`expected the full case table, got ${fixture.cases.length}`);
  }
});

for (const testCase of fixture.cases) {
  Deno.test(`matches the integration: ${testCase.label}`, () => {
    const prices = currentGridPrices(
      catalogue(testCase.overrides),
      new Date(testCase.at),
    );
    if (testCase.expected === null) {
      assertEquals(prices, null, "expected no price outside the catalogue");
      return;
    }
    assertEquals(
      prices,
      testCase.expected,
      `${testCase.label} at ${testCase.at}`,
    );
  });
}

Deno.test("Easter is computed, not tabulated", () => {
  // The high-load band is suspended over Easter, whose date moves. Pinning a
  // few known Sundays catches an off-by-one in the port of the algorithm.
  assertEquals(easterSunday(2026), { month: 4, day: 5 }, "Easter 2026");
  assertEquals(easterSunday(2027), { month: 3, day: 28 }, "Easter 2027");
  assertEquals(easterSunday(2030), { month: 4, day: 21 }, "Easter 2030");
});

Deno.test("an unconfigured home refuses to guess a price", () => {
  let raised = false;
  try {
    currentGridPrices({
      timezone: fixture.timezone,
      configuration: null,
      missing_inputs: ["main_fuse_a"],
      profiles: [fixture.profile],
    }, new Date("2026-08-13T12:00:00Z"));
  } catch (error) {
    raised = error instanceof GridTariffError;
  }
  if (!raised) throw new Error("missing customer input must raise");
});

Deno.test("two versions covering one day is an error, not a choice", () => {
  // Overlapping rates mean the catalogue is wrong. Picking one would hide it.
  const overlapping = {
    ...fixture.profile,
    versions: [
      fixture.profile.versions[0],
      { ...fixture.profile.versions[0], revision: "duplicate" },
    ],
  };
  let raised = false;
  try {
    currentGridPrices({
      timezone: fixture.timezone,
      configuration: fixture.base_configuration,
      missing_inputs: [],
      profiles: [overlapping],
    }, new Date("2026-08-13T12:00:00Z"));
  } catch (error) {
    raised = error instanceof GridTariffError;
  }
  if (!raised) throw new Error("overlapping tariff versions must raise");
});
