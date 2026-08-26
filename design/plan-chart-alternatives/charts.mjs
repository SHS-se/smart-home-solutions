// Five ways to draw the same thirty-six hours.
//
// Every chart here reads the identical dataset and the identical palette. What
// changes is only the arrangement — which quantities share an axis, what gets
// its own strip, and whether identity is carried by colour, by position or by
// density. That is the whole point: the differences you can see between these
// five are differences of layout, not of data or taste.
//
// Palette rules being obeyed throughout:
//   · one hue per entity, fixed across all five charts and never recycled;
//   · at most six categorical hues in any single plot;
//   · never two y-scales in one plot — a second unit gets its own strip;
//   · every fill separated from its neighbour by a 2 px surface gap;
//   · sequential ramps are one hue, light to dark, with a scale legend.

import {
  AXIS, bandArea, el, esc, group, hourTicks, powerTicks, round, scale,
  smoothLine, stackBands, stepArea, stepLine, svgRoot, text,
} from './svg.mjs';
import { GROUPS, DISPATCHABLE, DEVICES, deviceSeries, groupSeries, label } from './data.mjs';

const W = 1160;
const ML = 58;
const MR = 76;
const PLOT_W = W - ML - MR;

const kW = watts => watts / 1_000;
const fmtKw = value => `${value.toFixed(value >= 10 || value <= -10 ? 0 : 1)}`;
const fmtSek = value => value.toFixed(2);

const GROUP_VAR = {
  base: 'var(--c-base)', plugs: 'var(--c-plugs)', kitchen: 'var(--c-kitchen)',
  pool: 'var(--c-pool)', ev: 'var(--c-ev)', hotwater: 'var(--c-hotwater)',
};
const SOLAR = 'var(--c-solar)';
const GRID = 'var(--c-grid)';
const BATTERY = 'var(--c-battery)';
const SURFACE = 'var(--surface)';

/** The 2 px surface gap that keeps stacked fills from fusing into one blob. */
const bandSeparators = (bands, x, y) => bands.slice(0, -1).map(band =>
  el('path', {
    d: stepLine(band.map(pair => pair[1]), x, y),
    fill: 'none', stroke: SURFACE, 'stroke-width': 2, 'stroke-linejoin': 'round',
  })).join('');

/** Everything to the right of now is forecast; say so once, loudly, not faintly. */
const planWash = (x, nowIndex, n, top, height) => nowIndex >= n ? '' : group({}, [
  el('rect', {
    x: x(nowIndex), y: top, width: x(n) - x(nowIndex), height,
    fill: 'var(--plan-wash)',
  }),
  el('line', {
    x1: x(nowIndex), x2: x(nowIndex), y1: top, y2: top + height,
    stroke: 'var(--ink)', 'stroke-width': 1.5,
  }),
]);

const nowLabel = (x, nowIndex, y) => group({}, [
  el('rect', { x: x(nowIndex) + 4, y: y - 13, width: 92, height: 15, rx: 3, fill: 'var(--ink)' }),
  text('NOW · PLAN →', {
    x: x(nowIndex) + 9, y: y - 2, fill: 'var(--surface)', 'font-size': 9.5,
    'font-family': 'var(--font-mono)', 'letter-spacing': 0.6, 'font-weight': 600,
  }),
]);

const xAxis = (rows, x, y, everyHours = 3) => group({}, [
  el('line', { x1: x(0), x2: x(rows.length), y1: y, y2: y, stroke: 'var(--axis)', 'stroke-width': 1 }),
  ...hourTicks(rows, everyHours).map(({ i, row }) => text(label(row.ms), {
    ...AXIS.label, x: x(i), y: y + 14, 'text-anchor': 'middle',
  })),
  ...hourTicks(rows, 24).filter(({ i }) => i > 0).map(({ i, row }) => group({}, [
    el('line', { x1: x(i), x2: x(i), y1: y - 4, y2: y + 4, stroke: 'var(--axis)', 'stroke-width': 1 }),
    text(label(row.ms, true).slice(0, 5), {
      ...AXIS.label, x: x(i), y: y + 26, 'text-anchor': 'middle', 'font-weight': 600, fill: 'var(--ink-soft)',
    }),
  ])),
]);

/** Panel caption: what this strip measures, and in what. */
const panelTitle = (title, unit, y, left = ML) => group({}, [
  text(title, {
    x: left, y, fill: 'var(--ink)', 'font-size': 11, 'font-weight': 600,
    'font-family': 'var(--font-sans)', 'letter-spacing': 0.2,
  }),
  text(unit, {
    x: left + title.length * 6.4 + 10, y, fill: 'var(--ink-muted)', 'font-size': 10,
    'font-family': 'var(--font-mono)',
  }),
]);

/**
 * A label sits inside a band only where the band is thick enough to hold it,
 * which is the difference between a direct label and a clipped one.
 */
const insideLabel = (band, x, y, name, minPx = 16) => {
  let best = -1;
  let bestThickness = 0;
  band.forEach((pair, i) => {
    const thickness = Math.abs(y(pair[0]) - y(pair[1]));
    if (thickness > bestThickness) { bestThickness = thickness; best = i; }
  });
  if (best < 0 || bestThickness < minPx) return '';
  const cx = (x(best) + x(best + 1)) / 2;
  const cy = (y(band[best][0]) + y(band[best][1])) / 2;
  const width = name.length * 5.6 + 10;
  const clamped = Math.min(Math.max(cx, x(0) + width / 2), x(band.length) - width / 2);
  return group({}, [
    el('rect', {
      x: clamped - width / 2, y: cy - 7.5, width, height: 15, rx: 3,
      fill: 'var(--surface)', 'fill-opacity': 0.82,
    }),
    text(name, {
      x: clamped, y: cy + 3.5, 'text-anchor': 'middle', fill: 'var(--ink)',
      'font-size': 9.5, 'font-family': 'var(--font-sans)', 'font-weight': 600,
    }),
  ]);
};

/** Endpoint label for a line series — the one label a line always earns. */
const endLabel = (value, x, y, colour, textValue) => group({}, [
  el('circle', { cx: x, cy: y, r: 3, fill: colour, stroke: SURFACE, 'stroke-width': 2 }),
  text(textValue, {
    x: x + 7, y: y + 3.5, fill: 'var(--ink-soft)', 'font-size': 10,
    'font-family': 'var(--font-mono)',
  }),
]);

// ===========================================================================
// 0 — Refined target: A's panels, D's cost curve, and a priced price line
// ===========================================================================

/** Steps in the diverging cheap↔dear ramp. Odd, so there is a true middle. */
const PRICE_STEPS = 7;

/**
 * Price colour is a *scale*, not a series: a diverging ramp with a neutral
 * middle, binned linearly across the window's own range so the reader is
 * always told "cheap or dear compared with the rest of what you can see".
 *
 * Blue↔red rather than Tibber's green→yellow→red: a three-hue rainbow has no
 * meaningful midpoint, and green and red are the one pair a red-green reader
 * cannot separate — which is precisely the pair carrying the whole message.
 */
const priceBinner = values => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return {
    min,
    max,
    bin: value => Math.min(PRICE_STEPS, Math.max(1,
      Math.ceil(((value - min) / span) * PRICE_STEPS) || 1)),
  };
};

/** Hard-edged gradient: two stops per quarter, so the ramp steps like the data. */
const priceGradient = (id, values, binner, x, n) => el('defs', {}, el('linearGradient', {
  id,
  gradientUnits: 'userSpaceOnUse',
  x1: x(0), y1: 0, x2: x(n), y2: 0,
}, values.flatMap((value, i) => {
  const colour = `var(--price-${binner.bin(value)})`;
  return [
    el('stop', { offset: `${round((i / n) * 100)}%`, 'stop-color': colour }),
    el('stop', { offset: `${round(((i + 1) / n) * 100)}%`, 'stop-color': colour }),
  ];
}).join('')));

/** The ramp's own key, so a colour on the line can be turned back into a price. */
const priceScaleKey = (binner, right, y) => group({}, [
  text(`${binner.min.toFixed(2)}`, {
    ...AXIS.label, x: right - PRICE_STEPS * 14 - 44, y: y + 8, 'text-anchor': 'end',
  }),
  ...Array.from({ length: PRICE_STEPS }, (_, i) => el('rect', {
    x: right - PRICE_STEPS * 14 - 38 + i * 14, y, width: 13, height: 9,
    fill: `var(--price-${i + 1})`,
  })),
  text(`${binner.max.toFixed(2)} SEK`, {
    ...AXIS.label, x: right - PRICE_STEPS * 14 - 32 + PRICE_STEPS * 14, y: y + 8,
  }),
]);

export const targetChart = (rows, nowIndex) => {
  const n = rows.length;
  const x = scale([0, n], [ML, ML + PLOT_W]);
  const groups = groupSeries(rows);
  const right = ML + PLOT_W;

  const priceTop = 30;
  const priceH = 66;
  const flowTop = priceTop + priceH + 36;
  const flowH = 122;
  const loadTop = flowTop + flowH + 36;
  const loadH = 136;
  const socTop = loadTop + loadH + 36;
  const socH = 60;
  const costTop = socTop + socH + 36;
  const costH = 72;
  const axisY = costTop + costH;
  const height = axisY + 40;

  // --- Price, coloured by how dear it is ----------------------------------
  const buy = rows.map(r => r.importPriceSekPerKwh);
  const sell = rows.map(r => r.exportPriceSekPerKwh);
  const binner = priceBinner(buy);
  const priceY = scale([0, Math.max(...buy) * 1.14], [priceTop + priceH, priceTop]);
  const sorted = [...buy].sort((a, b) => a - b);
  const cheap = sorted[Math.floor(sorted.length * 0.25)];
  const dear = sorted[Math.floor(sorted.length * 0.75)];

  // --- Flows ---------------------------------------------------------------
  const supplyBands = stackBands([
    rows.map(r => Math.max(0, r.solarW - r.gridExportW - r.batteryChargeW)),
    rows.map(r => r.batteryDischargeW),
    rows.map(r => r.gridImportW),
  ]);
  const disposalBands = stackBands([
    rows.map(r => r.batteryChargeW),
    rows.map(r => r.gridExportW),
  ]);
  const flowMax = kW(Math.max(...supplyBands[2].map(p => p[1]))) * 1.12;
  const flowMin = -kW(Math.max(...disposalBands[1].map(p => p[1]), 500)) * 1.1;
  const flowY = scale([flowMin, flowMax], [flowTop + flowH, flowTop]);
  const flowTicks = powerTicks(flowMin, flowMax, 4);

  // --- Load ----------------------------------------------------------------
  const loadBands = stackBands(groups.map(g => g.values.map(kW)));
  const loadMax = Math.max(...loadBands[loadBands.length - 1].map(p => p[1])) * 1.1;
  const loadY = scale([0, loadMax], [loadTop + loadH, loadTop]);

  // --- Storage -------------------------------------------------------------
  const socY = scale([0, 100], [socTop + socH, socTop]);

  // --- Cost ----------------------------------------------------------------
  let running = 0;
  const cumulative = rows.map(r => { running += r.costSek; return running; });
  const costMin = Math.min(0, ...cumulative);
  const costMax = Math.max(...cumulative) * 1.18;
  const costY = scale([costMin, costMax], [costTop + costH, costTop]);

  const children = [
    priceGradient('target-price-ramp', buy, binner, x, n),
    planWash(x, nowIndex, n, priceTop - 12, axisY - priceTop + 12),

    // Price -----------------------------------------------------------------
    panelTitle('Price', 'SEK/kWh · buy, coloured cheap → dear', priceTop - 12),
    priceScaleKey(binner, right, priceTop - 20),
    ...powerTicks(0, Math.max(...buy) * 1.14, 3).map(t => group({}, [
      el('line', { ...AXIS.grid, x1: ML, x2: right, y1: priceY(t), y2: priceY(t) }),
      text(t.toFixed(1), { ...AXIS.label, x: ML - 8, y: priceY(t) + 3, 'text-anchor': 'end' }),
    ])),
    el('path', { d: stepArea(buy, x, priceY, 0), fill: 'url(#target-price-ramp)', 'fill-opacity': 0.2 }),
    ...[cheap, dear].map(level => el('line', {
      x1: ML, x2: right, y1: priceY(level), y2: priceY(level),
      stroke: 'var(--ink-muted)', 'stroke-width': 1, 'stroke-opacity': 0.55,
    })),
    el('path', { d: stepLine(sell, x, priceY), fill: 'none', stroke: 'var(--ink-muted)', 'stroke-width': 1.25 }),
    el('path', {
      d: stepLine(buy, x, priceY), fill: 'none', stroke: 'url(#target-price-ramp)',
      'stroke-width': 3, 'stroke-linejoin': 'round',
    }),
    text('buy', { x: right + 6, y: priceY(buy[n - 1]) + 3, fill: 'var(--ink)', 'font-size': 10, 'font-family': 'var(--font-mono)' }),
    text('sell', { x: right + 6, y: priceY(sell[n - 1]) + 3, fill: 'var(--ink-muted)', 'font-size': 10, 'font-family': 'var(--font-mono)' }),

    // Flows -----------------------------------------------------------------
    panelTitle('Power flows', 'kW  ·  above zero = into the house, below = out of it', flowTop - 12),
    ...flowTicks.map(t => group({}, [
      el('line', { ...AXIS.grid, x1: ML, x2: right, y1: flowY(t), y2: flowY(t) }),
      text(fmtKw(t), { ...AXIS.label, x: ML - 8, y: flowY(t) + 3, 'text-anchor': 'end' }),
    ])),
    ...[SOLAR, BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(supplyBands[i].map(p => [kW(p[0]), kW(p[1])]), x, flowY),
      fill: colour, 'fill-opacity': 0.9,
    })),
    ...[BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(disposalBands[i].map(p => [-kW(p[0]), -kW(p[1])]), x, flowY),
      fill: colour, 'fill-opacity': 0.42,
    })),
    bandSeparators(supplyBands.map(b => b.map(p => [kW(p[0]), kW(p[1])])), x, flowY),
    el('line', { x1: ML, x2: right, y1: flowY(0), y2: flowY(0), stroke: 'var(--ink)', 'stroke-width': 1.25 }),
    insideLabel(supplyBands[0].map(p => [kW(p[0]), kW(p[1])]), x, flowY, 'Solar'),
    insideLabel(supplyBands[1].map(p => [kW(p[0]), kW(p[1])]), x, flowY, 'Battery out'),
    insideLabel(supplyBands[2].map(p => [kW(p[0]), kW(p[1])]), x, flowY, 'Grid in'),
    insideLabel(disposalBands[0].map(p => [-kW(p[0]), -kW(p[1])]), x, flowY, 'Battery in'),

    // Consumption -----------------------------------------------------------
    panelTitle('Consumption', 'kW  ·  six kinds of load, stacked', loadTop - 12),
    ...powerTicks(0, loadMax, 3).map(t => group({}, [
      el('line', { ...AXIS.grid, x1: ML, x2: right, y1: loadY(t), y2: loadY(t) }),
      text(fmtKw(t), { ...AXIS.label, x: ML - 8, y: loadY(t) + 3, 'text-anchor': 'end' }),
    ])),
    ...loadBands.map((band, i) => el('path', {
      d: bandArea(band, x, loadY), fill: GROUP_VAR[groups[i].key], 'fill-opacity': 0.92,
    })),
    bandSeparators(loadBands, x, loadY),
    ...loadBands.map((band, i) => insideLabel(band, x, loadY, groups[i].short)),
    el('path', {
      d: stepLine(rows.map(r => kW(r.solarW)), x, loadY), fill: 'none', stroke: SOLAR,
      'stroke-width': 2, 'stroke-dasharray': '1 3', 'stroke-linecap': 'round',
    }),
    text('solar', {
      x: right + 6, y: loadY(kW(rows[n - 1].solarW)) + 3, fill: SOLAR,
      'font-size': 10, 'font-family': 'var(--font-mono)',
    }),

    // Storage ---------------------------------------------------------------
    panelTitle('Storage', '%', socTop - 12),
    ...[0, 50, 100].map(t => group({}, [
      el('line', { ...AXIS.grid, x1: ML, x2: right, y1: socY(t), y2: socY(t) }),
      text(String(t), { ...AXIS.label, x: ML - 8, y: socY(t) + 3, 'text-anchor': 'end' }),
    ])),
    el('path', { d: stepArea(rows.map(r => r.homeSoc * 100), x, socY, 0), fill: BATTERY, 'fill-opacity': 0.22 }),
    el('path', { d: stepLine(rows.map(r => r.homeSoc * 100), x, socY), fill: 'none', stroke: BATTERY, 'stroke-width': 2 }),
    el('path', { d: smoothLine(rows.map(r => r.evSoc * 100), x, socY), fill: 'none', stroke: GROUP_VAR.ev, 'stroke-width': 2 }),
    endLabel(0, right, socY(rows[n - 1].homeSoc * 100), BATTERY, `home ${Math.round(rows[n - 1].homeSoc * 100)}%`),
    endLabel(0, right, socY(rows[n - 1].evSoc * 100), GROUP_VAR.ev, `car ${Math.round(rows[n - 1].evSoc * 100)}%`),

    // Cost ------------------------------------------------------------------
    panelTitle('What it costs', 'SEK, cumulative · import minus export payment', costTop - 12),
    ...powerTicks(costMin, costMax, 4).map(t => group({}, [
      el('line', { ...AXIS.grid, x1: ML, x2: right, y1: costY(t), y2: costY(t) }),
      text(t.toFixed(0), { ...AXIS.label, x: ML - 8, y: costY(t) + 3, 'text-anchor': 'end' }),
    ])),
    el('path', { d: stepArea(cumulative, x, costY, 0), fill: 'var(--cost-wash)' }),
    el('path', { d: stepLine(cumulative, x, costY), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2 }),
    el('circle', { cx: x(nowIndex), cy: costY(cumulative[nowIndex]), r: 3.5, fill: 'var(--ink)', stroke: SURFACE, 'stroke-width': 2 }),
    text(`${fmtSek(cumulative[nowIndex])} kr so far`, {
      x: x(nowIndex) - 8, y: costY(cumulative[nowIndex]) - 8, 'text-anchor': 'end',
      fill: 'var(--ink)', 'font-size': 10.5, 'font-family': 'var(--font-mono)', 'font-weight': 600,
    }),
    endLabel(0, right, costY(cumulative[n - 1]), 'var(--ink)', `${fmtSek(cumulative[n - 1])} kr`),

    xAxis(rows, x, axisY),
    nowLabel(x, nowIndex, priceTop - 12),
  ];

  return {
    svg: svgRoot({
      width: W, height, id: 'chart-target', children,
      plot: { x0: ML, x1: right, y0: priceTop - 12, y1: axisY, n, fields: 'target' },
    }),
    height,
  };
};

// ===========================================================================
// 1 — Stacked panels
// ===========================================================================

export const panelsChart = (rows, nowIndex) => {
  const n = rows.length;
  const x = scale([0, n], [ML, ML + PLOT_W]);
  const groups = groupSeries(rows);

  const priceTop = 26;
  const priceH = 62;
  const flowTop = priceTop + priceH + 34;
  const flowH = 124;
  const loadTop = flowTop + flowH + 34;
  const loadH = 138;
  const socTop = loadTop + loadH + 34;
  const socH = 64;
  const axisY = socTop + socH;
  const height = axisY + 40;

  // --- Price -------------------------------------------------------------
  const prices = rows.flatMap(r => [r.importPriceSekPerKwh, r.exportPriceSekPerKwh]);
  const priceY = scale([0, Math.max(...prices) * 1.12], [priceTop + priceH, priceTop]);
  const priceTicks = powerTicks(0, Math.max(...prices) * 1.12, 2);

  // --- Flows: supply above the line, disposal below it --------------------
  // Solar the house used directly: what the panels made, less whatever was
  // exported or stored. Counting all of it would double-count the same watt.
  const supply = [
    rows.map(r => Math.max(0, r.solarW - r.gridExportW - r.batteryChargeW)),
    rows.map(r => r.batteryDischargeW),
    rows.map(r => r.gridImportW),
  ];
  const disposal = [
    rows.map(r => r.batteryChargeW),
    rows.map(r => r.gridExportW),
  ];
  const supplyBands = stackBands(supply);
  const disposalBands = stackBands(disposal);
  const flowMax = Math.max(...supplyBands[supplyBands.length - 1].map(p => p[1]));
  const flowMin = -Math.max(...disposalBands[disposalBands.length - 1].map(p => p[1]), 500);
  const flowY = scale([kW(flowMin) * 1.1, kW(flowMax) * 1.12], [flowTop + flowH, flowTop]);

  // --- Load stack ---------------------------------------------------------
  const loadBands = stackBands(groups.map(g => g.values.map(kW)));
  const loadMax = Math.max(...loadBands[loadBands.length - 1].map(p => p[1]));
  const loadY = scale([0, loadMax * 1.1], [loadTop + loadH, loadTop]);

  // --- Storage ------------------------------------------------------------
  const socY = scale([0, 100], [socTop + socH, socTop]);

  const children = [
    planWash(x, nowIndex, n, priceTop - 12, axisY - priceTop + 12),

    // Price
    panelTitle('Price', 'SEK/kWh', priceTop - 12),
    el('path', {
      d: stepArea(rows.map(r => r.importPriceSekPerKwh), x, priceY, 0),
      fill: 'var(--price-wash)',
    }),
    ...priceTicks.map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: priceY(t), y2: priceY(t) })),
    ...priceTicks.map(t => text(t.toFixed(1), { ...AXIS.label, x: ML - 8, y: priceY(t) + 3, 'text-anchor': 'end' })),
    el('path', {
      d: stepLine(rows.map(r => r.exportPriceSekPerKwh), x, priceY),
      fill: 'none', stroke: 'var(--ink-muted)', 'stroke-width': 1.25,
    }),
    el('path', {
      d: stepLine(rows.map(r => r.importPriceSekPerKwh), x, priceY),
      fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2,
    }),
    text('buy', {
      x: ML + PLOT_W + 6, y: priceY(rows[n - 1].importPriceSekPerKwh) + 3,
      fill: 'var(--ink)', 'font-size': 10, 'font-family': 'var(--font-mono)',
    }),
    text('sell', {
      x: ML + PLOT_W + 6, y: priceY(rows[n - 1].exportPriceSekPerKwh) + 3,
      fill: 'var(--ink-muted)', 'font-size': 10, 'font-family': 'var(--font-mono)',
    }),

    // Flows
    panelTitle('Power flows', 'kW  ·  above zero = into the house, below = out of it', flowTop - 12),
    ...powerTicks(kW(flowMin) * 1.1, kW(flowMax) * 1.12, 4)
      .map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: flowY(t), y2: flowY(t) })),
    ...powerTicks(kW(flowMin) * 1.1, kW(flowMax) * 1.12, 4)
      .map(t => text(fmtKw(t), { ...AXIS.label, x: ML - 8, y: flowY(t) + 3, 'text-anchor': 'end' })),
    ...[SOLAR, BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(supplyBands[i].map(p => [kW(p[0]), kW(p[1])]), x, flowY),
      fill: colour, 'fill-opacity': 0.9,
    })),
    ...[BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(disposalBands[i].map(p => [-kW(p[0]), -kW(p[1])]), x, flowY),
      fill: colour, 'fill-opacity': 0.42,
    })),
    bandSeparators(supplyBands.map(b => b.map(p => [kW(p[0]), kW(p[1])])), x, flowY),
    el('line', { x1: ML, x2: ML + PLOT_W, y1: flowY(0), y2: flowY(0), stroke: 'var(--ink)', 'stroke-width': 1.25 }),
    insideLabel(supplyBands[0].map(p => [kW(p[0]), kW(p[1])]), x, flowY, 'Solar'),
    insideLabel(supplyBands[1].map(p => [kW(p[0]), kW(p[1])]), x, flowY, 'Battery out'),
    insideLabel(supplyBands[2].map(p => [kW(p[0]), kW(p[1])]), x, flowY, 'Grid in'),
    insideLabel(disposalBands[0].map(p => [-kW(p[0]), -kW(p[1])]), x, flowY, 'Battery in'),

    // Load
    panelTitle('Consumption', 'kW  ·  six kinds of load, stacked', loadTop - 12),
    ...powerTicks(0, loadMax * 1.1, 3)
      .map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: loadY(t), y2: loadY(t) })),
    ...powerTicks(0, loadMax * 1.1, 3)
      .map(t => text(fmtKw(t), { ...AXIS.label, x: ML - 8, y: loadY(t) + 3, 'text-anchor': 'end' })),
    ...loadBands.map((band, i) => el('path', {
      d: bandArea(band, x, loadY), fill: GROUP_VAR[groups[i].key], 'fill-opacity': 0.92,
    })),
    bandSeparators(loadBands, x, loadY),
    ...loadBands.map((band, i) => insideLabel(band, x, loadY, groups[i].short)),
    el('path', {
      d: stepLine(rows.map(r => kW(r.solarW)), x, loadY),
      fill: 'none', stroke: SOLAR, 'stroke-width': 2, 'stroke-dasharray': '1 3', 'stroke-linecap': 'round',
    }),
    text('solar', {
      x: ML + PLOT_W + 6, y: loadY(kW(rows[n - 1].solarW)) + 3, fill: SOLAR,
      'font-size': 10, 'font-family': 'var(--font-mono)',
    }),

    // Storage
    panelTitle('Storage', '%', socTop - 12),
    ...[0, 50, 100].map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: socY(t), y2: socY(t) })),
    ...[0, 50, 100].map(t => text(String(t), { ...AXIS.label, x: ML - 8, y: socY(t) + 3, 'text-anchor': 'end' })),
    el('path', {
      d: stepArea(rows.map(r => r.homeSoc * 100), x, socY, 0), fill: BATTERY, 'fill-opacity': 0.22,
    }),
    el('path', {
      d: stepLine(rows.map(r => r.homeSoc * 100), x, socY), fill: 'none', stroke: BATTERY, 'stroke-width': 2,
    }),
    el('path', {
      d: smoothLine(rows.map(r => r.evSoc * 100), x, socY), fill: 'none',
      stroke: GROUP_VAR.ev, 'stroke-width': 2,
    }),
    endLabel(rows[n - 1].homeSoc * 100, ML + PLOT_W, socY(rows[n - 1].homeSoc * 100), BATTERY,
      `home ${Math.round(rows[n - 1].homeSoc * 100)}%`),
    endLabel(rows[n - 1].evSoc * 100, ML + PLOT_W, socY(rows[n - 1].evSoc * 100), GROUP_VAR.ev,
      `car ${Math.round(rows[n - 1].evSoc * 100)}%`),

    xAxis(rows, x, axisY),
    nowLabel(x, nowIndex, priceTop - 12),
  ];

  return {
    svg: svgRoot({
      width: W, height, id: 'chart-panels', children,
      plot: { x0: ML, x1: ML + PLOT_W, y0: priceTop - 12, y1: axisY, n, fields: 'full' },
    }),
    height,
  };
};

// ===========================================================================
// 2 — Energy balance mirror
// ===========================================================================

export const mirrorChart = (rows, nowIndex) => {
  const n = rows.length;
  const x = scale([0, n], [ML, ML + PLOT_W]);

  const priceTop = 26;
  const priceH = 44;
  const mainTop = priceTop + priceH + 34;
  const mainH = 296;
  const socTop = mainTop + mainH + 32;
  const socH = 52;
  const axisY = socTop + socH;
  const height = axisY + 40;

  const supply = [
    rows.map(r => Math.max(0, r.solarW - r.gridExportW - r.batteryChargeW)),
    rows.map(r => r.batteryDischargeW),
    rows.map(r => r.gridImportW),
  ];
  const sinks = [
    rows.map(r => r.loadW),
    rows.map(r => r.batteryChargeW),
    rows.map(r => r.gridExportW),
  ];
  const supplyBands = stackBands(supply.map(s => s.map(kW)));
  const sinkBands = stackBands(sinks.map(s => s.map(kW)));
  const span = Math.max(
    ...supplyBands[2].map(p => p[1]),
    ...sinkBands[2].map(p => p[1]),
  ) * 1.1;
  const y = scale([-span, span], [mainTop + mainH, mainTop]);

  const prices = rows.map(r => r.importPriceSekPerKwh);
  const priceY = scale([0, Math.max(...prices) * 1.1], [priceTop + priceH, priceTop]);
  const socY = scale([0, 100], [socTop + socH, socTop]);

  const ticks = powerTicks(-span, span, 5).filter(t => Math.abs(t) <= span);

  const children = [
    planWash(x, nowIndex, n, priceTop - 12, axisY - priceTop + 12),

    panelTitle('Price', 'SEK/kWh · buy', priceTop - 12),
    el('path', { d: stepArea(prices, x, priceY, 0), fill: 'var(--price-wash)' }),
    el('path', { d: stepLine(prices, x, priceY), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.75 }),
    ...[1, 3].map(t => text(t.toFixed(0), { ...AXIS.label, x: ML - 8, y: priceY(t) + 3, 'text-anchor': 'end' })),

    panelTitle('Energy balance', 'kW  ·  every quarter sums to zero', mainTop - 12),
    ...ticks.map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: y(t), y2: y(t) })),
    ...ticks.map(t => text(fmtKw(Math.abs(t)), { ...AXIS.label, x: ML - 8, y: y(t) + 3, 'text-anchor': 'end' })),

    ...[SOLAR, BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(supplyBands[i], x, y), fill: colour, 'fill-opacity': 0.92,
    })),
    ...['var(--c-load)', BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(sinkBands[i].map(p => [-p[0], -p[1]]), x, y), fill: colour,
      'fill-opacity': i === 0 ? 0.85 : 0.45,
    })),
    bandSeparators(supplyBands, x, y),
    bandSeparators(sinkBands.map(b => b.map(p => [-p[0], -p[1]])), x, y),

    insideLabel(supplyBands[0], x, y, 'Solar'),
    insideLabel(supplyBands[1], x, y, 'Battery'),
    insideLabel(supplyBands[2], x, y, 'Grid'),
    insideLabel(sinkBands[0].map(p => [-p[0], -p[1]]), x, y, 'House demand'),
    insideLabel(sinkBands[1].map(p => [-p[0], -p[1]]), x, y, 'Battery'),

    el('line', { x1: ML, x2: ML + PLOT_W, y1: y(0), y2: y(0), stroke: 'var(--ink)', 'stroke-width': 1.5 }),
    text('CAME FROM ↑', {
      x: ML + PLOT_W + 6, y: y(0) - 8, fill: 'var(--ink-soft)', 'font-size': 9.5,
      'font-family': 'var(--font-mono)', 'letter-spacing': 0.5,
    }),
    text('WENT TO ↓', {
      x: ML + PLOT_W + 6, y: y(0) + 15, fill: 'var(--ink-soft)', 'font-size': 9.5,
      'font-family': 'var(--font-mono)', 'letter-spacing': 0.5,
    }),

    panelTitle('Storage', '%', socTop - 12),
    ...[0, 100].map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: socY(t), y2: socY(t) })),
    ...[0, 100].map(t => text(String(t), { ...AXIS.label, x: ML - 8, y: socY(t) + 3, 'text-anchor': 'end' })),
    el('path', { d: stepArea(rows.map(r => r.homeSoc * 100), x, socY, 0), fill: BATTERY, 'fill-opacity': 0.22 }),
    el('path', { d: stepLine(rows.map(r => r.homeSoc * 100), x, socY), fill: 'none', stroke: BATTERY, 'stroke-width': 2 }),
    el('path', { d: smoothLine(rows.map(r => r.evSoc * 100), x, socY), fill: 'none', stroke: GROUP_VAR.ev, 'stroke-width': 2 }),
    endLabel(0, ML + PLOT_W, socY(rows[n - 1].homeSoc * 100), BATTERY, `home ${Math.round(rows[n - 1].homeSoc * 100)}%`),
    endLabel(0, ML + PLOT_W, socY(rows[n - 1].evSoc * 100), GROUP_VAR.ev, `car ${Math.round(rows[n - 1].evSoc * 100)}%`),

    xAxis(rows, x, axisY),
    nowLabel(x, nowIndex, priceTop - 12),
  ];

  return {
    svg: svgRoot({
      width: W, height, id: 'chart-mirror', children,
      plot: { x0: ML, x1: ML + PLOT_W, y0: priceTop - 12, y1: axisY, n, fields: 'balance' },
    }),
    height,
  };
};

// ===========================================================================
// 3 — The same chart, repaired
// ===========================================================================

export const repairedChart = (rows, nowIndex) => {
  const n = rows.length;
  const x = scale([0, n], [ML, ML + PLOT_W]);
  const groups = groupSeries(rows);

  const priceTop = 26;
  const priceH = 46;
  const mainTop = priceTop + priceH + 34;
  const mainH = 216;
  const socTop = mainTop + mainH + 32;
  const socH = 52;
  const axisY = socTop + socH;
  const height = axisY + 40;

  const loadBands = stackBands(groups.map(g => g.values.map(kW)));
  const gridSigned = rows.map(r => kW(r.gridImportW - r.gridExportW));
  const batterySigned = rows.map(r => kW(r.batteryDischargeW - r.batteryChargeW));
  const top = Math.max(...loadBands[loadBands.length - 1].map(p => p[1]), ...gridSigned, ...batterySigned);
  const bottom = Math.min(0, ...gridSigned, ...batterySigned);
  const y = scale([bottom * 1.15, top * 1.12], [mainTop + mainH, mainTop]);

  const prices = rows.map(r => r.importPriceSekPerKwh);
  const priceY = scale([0, Math.max(...prices) * 1.1], [priceTop + priceH, priceTop]);
  const socY = scale([0, 100], [socTop + socH, socTop]);
  const ticks = powerTicks(bottom * 1.15, top * 1.12, 4);

  /** A stroke that has to cross a filled stack needs a surface halo to survive it. */
  const haloLine = (values, colour, width = 2.25) => group({}, [
    el('path', { d: stepLine(values, x, y), fill: 'none', stroke: SURFACE, 'stroke-width': width + 3, 'stroke-linejoin': 'round' }),
    el('path', { d: stepLine(values, x, y), fill: 'none', stroke: colour, 'stroke-width': width, 'stroke-linejoin': 'round' }),
  ]);

  const children = [
    planWash(x, nowIndex, n, priceTop - 12, axisY - priceTop + 12),

    panelTitle('Price', 'SEK/kWh · buy', priceTop - 12),
    el('path', { d: stepArea(prices, x, priceY, 0), fill: 'var(--price-wash)' }),
    el('path', { d: stepLine(prices, x, priceY), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.75 }),
    ...[1, 3].map(t => text(t.toFixed(0), { ...AXIS.label, x: ML - 8, y: priceY(t) + 3, 'text-anchor': 'end' })),

    panelTitle('Power', 'kW  ·  consumption stacked, flows as lines', mainTop - 12),
    ...ticks.map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: y(t), y2: y(t) })),
    ...ticks.map(t => text(fmtKw(t), { ...AXIS.label, x: ML - 8, y: y(t) + 3, 'text-anchor': 'end' })),
    ...loadBands.map((band, i) => el('path', {
      d: bandArea(band, x, y), fill: GROUP_VAR[groups[i].key], 'fill-opacity': 0.55,
    })),
    bandSeparators(loadBands, x, y),
    ...loadBands.map((band, i) => insideLabel(band, x, y, groups[i].short)),
    el('line', { x1: ML, x2: ML + PLOT_W, y1: y(0), y2: y(0), stroke: 'var(--ink)', 'stroke-width': 1.25 }),
    el('path', {
      d: stepLine(rows.map(r => kW(r.solarW)), x, y), fill: 'none', stroke: SOLAR,
      'stroke-width': 2.25, 'stroke-dasharray': '1 3.5', 'stroke-linecap': 'round',
    }),
    haloLine(gridSigned, GRID),
    haloLine(batterySigned, BATTERY),
    text('grid  +buy / −sell', {
      x: ML + PLOT_W + 6, y: y(gridSigned[n - 1]) + 3, fill: GRID, 'font-size': 9.5, 'font-family': 'var(--font-mono)',
    }),
    text('battery  +out / −in', {
      x: ML + PLOT_W + 6, y: y(batterySigned[n - 1]) + 3, fill: BATTERY, 'font-size': 9.5, 'font-family': 'var(--font-mono)',
    }),

    panelTitle('Storage', '%', socTop - 12),
    ...[0, 100].map(t => el('line', { ...AXIS.grid, x1: ML, x2: ML + PLOT_W, y1: socY(t), y2: socY(t) })),
    ...[0, 100].map(t => text(String(t), { ...AXIS.label, x: ML - 8, y: socY(t) + 3, 'text-anchor': 'end' })),
    el('path', { d: stepArea(rows.map(r => r.homeSoc * 100), x, socY, 0), fill: BATTERY, 'fill-opacity': 0.22 }),
    el('path', { d: stepLine(rows.map(r => r.homeSoc * 100), x, socY), fill: 'none', stroke: BATTERY, 'stroke-width': 2 }),
    el('path', { d: smoothLine(rows.map(r => r.evSoc * 100), x, socY), fill: 'none', stroke: GROUP_VAR.ev, 'stroke-width': 2 }),
    endLabel(0, ML + PLOT_W, socY(rows[n - 1].homeSoc * 100), BATTERY, `home ${Math.round(rows[n - 1].homeSoc * 100)}%`),
    endLabel(0, ML + PLOT_W, socY(rows[n - 1].evSoc * 100), GROUP_VAR.ev, `car ${Math.round(rows[n - 1].evSoc * 100)}%`),

    xAxis(rows, x, axisY),
    nowLabel(x, nowIndex, priceTop - 12),
  ];

  return {
    svg: svgRoot({
      width: W, height, id: 'chart-repaired', children,
      plot: { x0: ML, x1: ML + PLOT_W, y0: priceTop - 12, y1: axisY, n, fields: 'full' },
    }),
    height,
  };
};

// ===========================================================================
// 4 — Decision view
// ===========================================================================

export const decisionChart = (rows, nowIndex) => {
  const n = rows.length;
  // Lanes are labelled by name on the left, which the shared margin cannot hold.
  const laneML = 100;
  const laneW = W - laneML - MR;
  const x = scale([0, n], [laneML, laneML + laneW]);

  const priceTop = 26;
  const priceH = 78;
  const laneTop = priceTop + priceH + 40;
  const laneH = 26;
  const laneGap = 7;
  const lanes = DISPATCHABLE.map(key => DEVICES.find(d => d.key === key));
  const laneBlockH = lanes.length * (laneH + laneGap) - laneGap;
  const socTop = laneTop + laneBlockH + 40;
  const socH = 78;
  const costTop = socTop + socH + 38;
  const costH = 68;
  const axisY = costTop + costH;
  const height = axisY + 40;

  const prices = rows.map(r => r.importPriceSekPerKwh);
  const sorted = [...prices].sort((a, b) => a - b);
  const cheap = sorted[Math.floor(sorted.length * 0.25)];
  const dear = sorted[Math.floor(sorted.length * 0.75)];
  const priceY = scale([0, Math.max(...prices) * 1.1], [priceTop + priceH, priceTop]);
  const socY = scale([0, 100], [socTop + socH, socTop]);

  let running = 0;
  const cumulative = rows.map(r => { running += r.costSek; return running; });
  const costY = scale([Math.min(0, ...cumulative) * 1.1, Math.max(...cumulative) * 1.15], [costTop + costH, costTop]);

  /** Cheap, ordinary, dear — three bins, a diverging wash, never a series hue. */
  const priceBin = value => value <= cheap ? 'var(--band-cheap)' : value >= dear ? 'var(--band-dear)' : 'var(--band-mid)';

  const laneRow = (device, index) => {
    const yTop = laneTop + index * (laneH + laneGap);
    const values = rows.map(r => r.dispatch[device.key] ?? 0);
    const peak = Math.max(...values, 1);
    const blocks = [];
    let start = -1;
    values.forEach((value, i) => {
      if (value > 0 && start < 0) start = i;
      if ((value === 0 || i === values.length - 1) && start >= 0) {
        const end = value > 0 ? i + 1 : i;
        const height2 = laneH * (0.42 + 0.58 * (Math.max(...values.slice(start, end)) / peak));
        blocks.push(el('rect', {
          x: x(start), y: yTop + laneH - height2, width: Math.max(2, x(end) - x(start)), height: height2, rx: 2,
          fill: GROUP_VAR[device.group],
          'fill-opacity': start >= nowIndex ? 0.42 : 0.95,
          stroke: start >= nowIndex ? GROUP_VAR[device.group] : 'none',
          'stroke-width': start >= nowIndex ? 1.25 : 0,
          'stroke-dasharray': start >= nowIndex ? '3 2' : undefined,
        }));
        start = -1;
      }
    });
    return group({}, [
      el('rect', { x: laneML, y: yTop, width: laneW, height: laneH, fill: 'var(--lane)' }),
      ...blocks,
      text(device.short, {
        x: laneML - 8, y: yTop + laneH / 2 + 3.5, 'text-anchor': 'end', fill: 'var(--ink-soft)',
        'font-size': 10, 'font-family': 'var(--font-sans)',
      }),
    ]);
  };

  const children = [
    planWash(x, nowIndex, n, priceTop - 12, axisY - priceTop + 12),

    panelTitle('What power costs', 'SEK/kWh · buy price, shaded cheap → dear', priceTop - 12, laneML),
    ...rows.map((r, i) => el('rect', {
      x: x(i), y: priceY(r.importPriceSekPerKwh),
      width: Math.max(0.8, x(i + 1) - x(i) - 0.6),
      height: priceY(0) - priceY(r.importPriceSekPerKwh),
      fill: priceBin(r.importPriceSekPerKwh),
    })),
    el('line', {
      x1: laneML, x2: laneML + laneW, y1: priceY(cheap), y2: priceY(cheap),
      stroke: 'var(--ink-muted)', 'stroke-width': 1,
    }),
    text(`cheapest quarter ≤ ${cheap.toFixed(2)}`, {
      x: laneML + laneW + 6, y: priceY(cheap) + 3, fill: 'var(--ink-muted)', 'font-size': 9.5, 'font-family': 'var(--font-mono)',
    }),
    el('line', {
      x1: laneML, x2: laneML + laneW, y1: priceY(dear), y2: priceY(dear),
      stroke: 'var(--ink-muted)', 'stroke-width': 1,
    }),
    text(`dearest quarter ≥ ${dear.toFixed(2)}`, {
      x: laneML + laneW + 6, y: priceY(dear) + 3, fill: 'var(--ink-muted)', 'font-size': 9.5, 'font-family': 'var(--font-mono)',
    }),
    ...powerTicks(0, Math.max(...prices) * 1.1, 2)
      .map(t => text(t.toFixed(1), { ...AXIS.label, x: laneML - 8, y: priceY(t) + 3, 'text-anchor': 'end' })),

    panelTitle('What the plan runs', 'solid = already ran  ·  dashed = still ahead', laneTop - 12, laneML),
    ...lanes.map(laneRow),

    panelTitle('What the battery does', '% state of charge', socTop - 12, laneML),
    ...[0, 50, 100].map(t => el('line', { ...AXIS.grid, x1: laneML, x2: laneML + laneW, y1: socY(t), y2: socY(t) })),
    ...[0, 50, 100].map(t => text(String(t), { ...AXIS.label, x: laneML - 8, y: socY(t) + 3, 'text-anchor': 'end' })),
    el('path', { d: stepArea(rows.map(r => r.homeSoc * 100), x, socY, 0), fill: BATTERY, 'fill-opacity': 0.22 }),
    el('path', { d: stepLine(rows.map(r => r.homeSoc * 100), x, socY), fill: 'none', stroke: BATTERY, 'stroke-width': 2.25 }),
    el('path', { d: smoothLine(rows.map(r => r.evSoc * 100), x, socY), fill: 'none', stroke: GROUP_VAR.ev, 'stroke-width': 2 }),
    endLabel(0, laneML + laneW, socY(rows[n - 1].homeSoc * 100), BATTERY, `home ${Math.round(rows[n - 1].homeSoc * 100)}%`),
    endLabel(0, laneML + laneW, socY(rows[n - 1].evSoc * 100), GROUP_VAR.ev, `car ${Math.round(rows[n - 1].evSoc * 100)}%`),

    panelTitle('What it costs', 'SEK, cumulative', costTop - 12, laneML),
    ...powerTicks(Math.min(0, ...cumulative), Math.max(...cumulative) * 1.15, 3).map(t => group({}, [
      el('line', { ...AXIS.grid, x1: laneML, x2: laneML + laneW, y1: costY(t), y2: costY(t) }),
      text(t.toFixed(0), { ...AXIS.label, x: laneML - 8, y: costY(t) + 3, 'text-anchor': 'end' }),
    ])),
    el('path', { d: stepArea(cumulative, x, costY, 0), fill: 'var(--cost-wash)' }),
    el('path', { d: stepLine(cumulative, x, costY), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2 }),
    el('circle', { cx: x(nowIndex), cy: costY(cumulative[nowIndex]), r: 3.5, fill: 'var(--ink)', stroke: SURFACE, 'stroke-width': 2 }),
    text(`${fmtSek(cumulative[nowIndex])} kr so far`, {
      x: x(nowIndex) - 8, y: costY(cumulative[nowIndex]) - 8, 'text-anchor': 'end',
      fill: 'var(--ink)', 'font-size': 10.5, 'font-family': 'var(--font-mono)', 'font-weight': 600,
    }),
    endLabel(0, laneML + laneW, costY(cumulative[n - 1]), 'var(--ink)', `${fmtSek(cumulative[n - 1])} kr`),

    xAxis(rows, x, axisY),
    nowLabel(x, nowIndex, priceTop - 12),
  ];

  return {
    svg: svgRoot({
      width: W, height, id: 'chart-decision', children,
      plot: { x0: ML, x1: laneML + laneW, y0: priceTop - 12, y1: axisY, n, fields: 'decision' },
    }),
    height,
  };
};

// ===========================================================================
// 5 — Meter matrix
// ===========================================================================

const RAMP_STEPS = 6;

export const matrixChart = (rows, nowIndex) => {
  const n = rows.length;
  // Meter names are the widest thing on this chart, so the matrix gets its own
  // left margin rather than squeezing nineteen labels into the shared one.
  const matrixML = 132;
  const matrixMR = 132;
  const matrixW = W - matrixML - matrixMR;
  const x = scale([0, n], [matrixML, matrixML + matrixW]);
  const meters = deviceSeries(rows).filter(m => m.kwh > 0.02);

  const flowTop = 26;
  const flowH = 88;
  const gridTop = flowTop + flowH + 40;
  const rowH = 14;
  const rowGap = 2;
  const gridH = meters.length * (rowH + rowGap) - rowGap;
  const priceTop = gridTop + gridH + 36;
  const priceH = 46;
  const axisY = priceTop + priceH;
  const height = axisY + 40;

  const supplyBands = stackBands([
    rows.map(r => Math.max(0, r.solarW - r.gridExportW - r.batteryChargeW)),
    rows.map(r => r.batteryDischargeW),
    rows.map(r => r.gridImportW),
  ].map(s => s.map(kW)));
  const flowMax = Math.max(...supplyBands[2].map(p => p[1])) * 1.12;
  const flowY = scale([0, flowMax], [flowTop + flowH, flowTop]);

  const peak = Math.max(...meters.flatMap(m => m.values)) / 1_000;
  // Square-root, not linear: a 90 W fridge and a 3.7 kW charger have to share
  // one ramp, and on a linear scale everything but the charger is white.
  const intensity = watts => Math.min(1, Math.sqrt(kW(watts) / peak));
  const rampFill = watts => watts < 5 ? 'var(--cell-0)'
    : `var(--cell-${Math.max(1, Math.min(RAMP_STEPS, Math.ceil(intensity(watts) * RAMP_STEPS)))})`;

  const maxKwh = Math.max(...meters.map(m => m.kwh));
  const barX = scale([0, maxKwh], [0, 52]);

  const prices = rows.map(r => r.importPriceSekPerKwh);
  const priceY = scale([0, Math.max(...prices) * 1.1], [priceTop + priceH, priceTop]);

  const cells = meters.map((meter, rowIndex) => {
    const yTop = gridTop + rowIndex * (rowH + rowGap);
    // Runs of equal intensity collapse into one rect: 20 × 144 cells is 2 880
    // elements, and most of them are the same shade of nothing.
    const runs = [];
    let start = 0;
    let current = rampFill(meter.values[0]);
    for (let i = 1; i <= n; i += 1) {
      const next = i < n ? rampFill(meter.values[i]) : null;
      if (next !== current) {
        runs.push(el('rect', {
          x: x(start), y: yTop, width: x(i) - x(start), height: rowH, fill: current,
        }));
        start = i; current = next;
      }
    }
    return group({}, [
      ...runs,
      text(meter.short ?? meter.label, {
        x: matrixML - 10, y: yTop + rowH - 3.5, 'text-anchor': 'end', fill: 'var(--ink-soft)',
        'font-size': 9.5, 'font-family': 'var(--font-sans)',
      }),
      el('rect', {
        x: matrixML + matrixW + 10, y: yTop + 3, width: Math.max(1, barX(meter.kwh)), height: rowH - 6, rx: 1,
        fill: GROUP_VAR[meter.group] ?? 'var(--c-base)', 'fill-opacity': 0.75,
      }),
      text(meter.kwh.toFixed(1), {
        x: matrixML + matrixW + 68, y: yTop + rowH - 3.5, fill: 'var(--ink-muted)',
        'font-size': 9, 'font-family': 'var(--font-mono)',
      }),
    ]);
  });

  const legendX = matrixML + matrixW - 142;
  const legend = group({}, [
    text('kW', { x: legendX - 8, y: gridTop - 12, ...AXIS.label, 'text-anchor': 'end' }),
    ...Array.from({ length: RAMP_STEPS + 1 }, (_, i) => el('rect', {
      x: legendX + i * 15, y: gridTop - 21, width: 14, height: 10, fill: `var(--cell-${i})`,
    })),
    text('0', { x: legendX, y: gridTop - 24, ...AXIS.label }),
    text(peak.toFixed(1), { x: legendX + 102, y: gridTop - 24, ...AXIS.label }),
    text('kWh', { x: matrixML + matrixW + 10, y: gridTop - 12, ...AXIS.label }),
  ]);

  const children = [
    planWash(x, nowIndex, n, flowTop - 12, axisY - flowTop + 12),

    panelTitle('Where the power came from', 'kW', flowTop - 12, matrixML),
    ...powerTicks(0, flowMax, 3).map(t => el('line', { ...AXIS.grid, x1: matrixML, x2: matrixML + matrixW, y1: flowY(t), y2: flowY(t) })),
    ...powerTicks(0, flowMax, 3).map(t => text(fmtKw(t), { ...AXIS.label, x: matrixML - 10, y: flowY(t) + 3, 'text-anchor': 'end' })),
    ...[SOLAR, BATTERY, GRID].map((colour, i) => el('path', {
      d: bandArea(supplyBands[i], x, flowY), fill: colour, 'fill-opacity': 0.9,
    })),
    bandSeparators(supplyBands, x, flowY),
    insideLabel(supplyBands[0], x, flowY, 'Solar'),
    insideLabel(supplyBands[1], x, flowY, 'Battery'),
    insideLabel(supplyBands[2], x, flowY, 'Grid'),

    panelTitle('Every meter, quarter by quarter', 'stronger cell = more power · rows sorted by energy', gridTop - 12, matrixML),
    legend,
    ...cells,

    panelTitle('Price', 'SEK/kWh · buy', priceTop - 12, matrixML),
    el('path', { d: stepArea(prices, x, priceY, 0), fill: 'var(--price-wash)' }),
    el('path', { d: stepLine(prices, x, priceY), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.75 }),
    ...[1, 3].map(t => text(t.toFixed(0), { ...AXIS.label, x: matrixML - 10, y: priceY(t) + 3, 'text-anchor': 'end' })),

    xAxis(rows, x, axisY),
    nowLabel(x, nowIndex, flowTop - 12),
  ];

  return {
    svg: svgRoot({
      width: W, height, id: 'chart-matrix', children,
      plot: { x0: matrixML, x1: matrixML + matrixW, y0: flowTop - 12, y1: axisY, n, fields: 'matrix' },
    }),
    height,
  };
};

export const CHARTS = [targetChart, panelsChart, mirrorChart, repairedChart, decisionChart, matrixChart];
export { GROUP_VAR, W, ML, PLOT_W };
