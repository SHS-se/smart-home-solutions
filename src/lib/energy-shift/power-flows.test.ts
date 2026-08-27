import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  powerFlowMagnitudes, solarUsedDirectlyW, type PowerFlowQuarter,
} from './power-flows.ts';

const quarter = (overrides: Partial<PowerFlowQuarter> = {}): PowerFlowQuarter => ({
  solarW: 0,
  gridImportW: 0,
  gridExportW: 0,
  batteryChargeW: 0,
  batteryDischargeW: 0,
  ...overrides,
});

Deno.test('a stored sign never decides which way a flow points', () => {
  // The timeline stores export and charge negative; the plan contract stores
  // them positive. Both describe the same house doing the same thing, and the
  // panel has to draw them on the same side of the axis either way. Reading the
  // sign instead put both disposal bands above the line, where they showed up
  // as an unexplained brown over the solar band.
  const stored = quarter({ solarW: 5_000, gridExportW: -800, batteryChargeW: -1_200 });
  const contract = quarter({ solarW: 5_000, gridExportW: 800, batteryChargeW: 1_200 });
  assertEquals(powerFlowMagnitudes([stored]), powerFlowMagnitudes([contract]));
});

Deno.test('every magnitude comes back non-negative', () => {
  const flows = powerFlowMagnitudes([quarter({
    solarW: -100, gridImportW: -200, gridExportW: -300,
    batteryChargeW: -400, batteryDischargeW: -500,
  })]);
  for (const [name, values] of Object.entries(flows)) {
    assert(values.every(value => value >= 0), `${name} produced ${JSON.stringify(values)}`);
  }
});

Deno.test('solar counted directly excludes what left the house', () => {
  // Otherwise the same watt is credited twice: once arriving from the roof and
  // again leaving down the wire or into the cells.
  assertEquals(
    solarUsedDirectlyW(quarter({ solarW: 5_000, gridExportW: -800, batteryChargeW: -1_200 })),
    3_000,
  );
});

Deno.test('solar used directly never goes negative', () => {
  // Meters disagree by a few watts all the time, and a negative band would
  // draw downwards out of the supply stack.
  assertEquals(
    solarUsedDirectlyW(quarter({ solarW: 1_000, gridExportW: -1_100 })),
    0,
  );
});

Deno.test('a missing reading counts as nothing, not as NaN', () => {
  const flows = powerFlowMagnitudes([quarter({
    solarW: null, gridImportW: null, gridExportW: null,
    batteryChargeW: null, batteryDischargeW: null,
  })]);
  assertEquals(flows, {
    solarDirect: [0], batteryOut: [0], gridIn: [0], batteryIn: [0], gridOut: [0],
  });
});

Deno.test('the supply stack tops out at what the house drew', () => {
  // Solar used directly plus battery out plus grid in is the house's demand,
  // which is what the consumption panel underneath has to agree with.
  const row = quarter({
    solarW: 4_000, gridExportW: -500, batteryChargeW: -1_000,
    batteryDischargeW: 0, gridImportW: 300,
  });
  const flows = powerFlowMagnitudes([row]);
  const supply = flows.solarDirect[0] + flows.batteryOut[0] + flows.gridIn[0];
  assertEquals(supply, 2_800);
});

Deno.test('an empty window produces empty series, not undefined', () => {
  assertEquals(powerFlowMagnitudes([]), {
    solarDirect: [], batteryOut: [], gridIn: [], batteryIn: [], gridOut: [],
  });
});
