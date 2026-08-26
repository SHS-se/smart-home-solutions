// Builds the review page: five charts, one dataset, one stylesheet.
//
//   node design/plan-chart-alternatives/build.mjs
//
// Writes out/index.html. Nothing in src/ is read or touched — this folder is a
// drawing board, not a change to the product.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDataset, groupSeries, deviceSeries, totals, label,
  NOW_INDEX, SCREENSHOT_TOTALS, GROUPS,
} from './data.mjs';
import {
  targetChart, panelsChart, mirrorChart, repairedChart, decisionChart, matrixChart,
} from './charts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { rows } = buildDataset();
const day = totals(rows, 0, 96);
const groups = groupSeries(rows);
const meters = deviceSeries(rows).filter(m => m.kwh > 0.02);

const kw = w => w / 1_000;
const q = n => Math.round(n * 100) / 100;

/** One record per quarter — the source for every tooltip on the page. */
const quarters = rows.map((row, i) => ({
  t: label(row.ms, true),
  solar: q(kw(row.solarW)),
  load: q(kw(row.loadW)),
  imp: q(kw(row.gridImportW)),
  exp: q(kw(row.gridExportW)),
  chg: q(kw(row.batteryChargeW)),
  dis: q(kw(row.batteryDischargeW)),
  // Solar that the house used directly, which is what the flow stack draws.
  own: q(kw(Math.max(0, row.solarW - row.gridExportW - row.batteryChargeW))),
  soc: Math.round(row.homeSoc * 100),
  ev: Math.round(row.evSoc * 100),
  pin: q(row.importPriceSekPerKwh),
  pout: q(row.exportPriceSekPerKwh),
  g: Object.fromEntries(groups.map(g => [g.key, q(kw(g.values[i]))])),
  d: Object.fromEntries(Object.entries(row.dispatch).map(([k, v]) => [k, q(kw(v))])),
}));
let running = 0;
quarters.forEach((rec, i) => { running += rows[i].costSek; rec.cum = q(running); });

const charts = {
  target: targetChart(rows, NOW_INDEX),
  panels: panelsChart(rows, NOW_INDEX),
  mirror: mirrorChart(rows, NOW_INDEX),
  repaired: repairedChart(rows, NOW_INDEX),
  decision: decisionChart(rows, NOW_INDEX),
  matrix: matrixChart(rows, NOW_INDEX),
};

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const FAULTS = [
  ['Three y-axes in one box',
   'kW on the left, per cent and SEK/kWh on the right. Nothing about a curve says which axis it belongs to, so every reading starts with a guess. A dual axis also invents a relationship that is not in the data — the alignment between two scales is arbitrary, and the eye reads it as correlation anyway.'],
  ['Nineteen meters, eight colours',
   'Device colours are cycled with <code>index % 8</code>, so three meters share every colour. The legend runs to thirty chips over three rows. No band in that stack can be looked up, which makes the stack decoration.'],
  ['Two reds that mean different things',
   'Grid import is <code>#dc2626</code>; home battery state of charge is <code>#f43f5e</code>. One is kilowatts, the other per cent. They are drawn in the same box, a few degrees of hue apart.'],
  ['Four lines for two quantities',
   'Import and export are one signed quantity. So are charge and discharge. Drawn as four separate series they cross each other, cross zero and cross the whole stack — four chances to misread two facts.'],
  ['The most important distinction is drawn faintest',
   'Measured versus forecast is the most loaded thing the chart has to say, and it is carried by a grey rectangle at 16 % opacity.'],
  ['Red against green',
   'Import red, export green — precisely the pair that around eight per cent of men cannot separate.'],
];

const VOCAB = [
  ['Solar', '--c-solar', 'PV production'],
  ['Grid', '--c-grid', 'Import and export'],
  ['Battery', '--c-battery', 'Home battery, in and out'],
  ['Hot water', '--c-hotwater', 'Tank heat pump'],
  ['EV', '--c-ev', 'Charging and car SOC'],
  ['Pool', '--c-pool', 'Heater and pump'],
  ['Kitchen &amp; cold', '--c-kitchen', 'Stove, dishwasher, fridge, freezer'],
  ['Media &amp; office', '--c-plugs', 'The sockets that never stop'],
  ['Base load', '--c-base', 'Everything else, including the FTX'],
];

const ALTERNATIVES = [
  {
    id: 'target',
    tag: 'T',
    target: true,
    name: 'Refined target',
    lede: "A's panels, D's cost curve, and a price line that shows what it costs.",
    body: `Five panels over one time axis, read top to bottom as a sentence: what a
    kilowatt-hour cost, where the power came from, what used it, what was left in store,
    and what the whole thing added up to. Everything below <em>now</em> is drawn once, in
    one place, so a moment in time is a column rather than a hunt.
    <br><br>The price line is the change you asked for. Instead of one ink stroke it is
    coloured along its length by how dear that quarter is — deep blue at the cheapest
    quarter of the window, neutral through the middle, deep red at the dearest — with the
    same ramp washed underneath and thin rules at the 25th and 75th percentiles. The two
    horizontal lines are the answer to "is this a cheap hour?"; the colour is the answer
    to "how cheap?".
    <br><br>Blue↔red rather than Tibber's green→yellow→red. A three-hue rainbow has no
    meaningful middle, and green versus red is exactly the pair a red-green reader cannot
    separate — which here would be the pair carrying the entire message.`,
    fixes: ['One unit per panel; no dual axis anywhere', 'Price magnitude readable without looking at the axis', 'The cost curve answers "was the plan worth it?" in the same column'],
    costs: ['The tallest card of the six, around 670 px', 'The price ramp is one more scale to learn — hence its key in the panel'],
    verdict: 'The target. Everything below is how it got here.',
  },
  {
    id: 'panels',
    tag: 'A',
    name: 'Stacked panels',
    lede: 'One unit per box, one shared time axis.',
    body: `The simplest possible answer to three axes is three boxes. Price gets its own strip, power flows get one, consumption gets one, storage gets one — all stacked vertically over exactly the same x-axis, with a single <em>now</em> line running through every panel. Reading a moment becomes reading a column: what it cost, where the power came from, what the house was drawing, how much was left in the battery.
    <br><br>The flow panel also disposes of the four lines. Above zero is what came <em>into</em> the house — sun, battery, grid — stacked. Below zero is what left it. The zero line means something again.`,
    fixes: ['No dual axis anywhere', 'Six load colours instead of nineteen', 'Import/export and charge/discharge become signs, not series'],
    costs: ['A taller card — around 550 px', 'Four boxes to glance between instead of one'],
    verdict: 'The safest of the five. No new concepts for the reader.',
  },
  {
    id: 'mirror',
    tag: 'B',
    name: 'Energy balance',
    lede: 'Where it came from, upward. Where it went, downward.',
    body: `A house cannot conjure a watt. Every quarter satisfies <code>solar + import + discharge = consumption + export + charge</code>, and that equality is the only check a reader needs in order to trust the rest of the chart. So let the chart show it: sources stacked upward from zero, uses mirrored downward, exactly as tall.
    <br><br>Direction is carried by the sign rather than by a second colour. Grid is blue whether it is buying or selling; the battery is green whether it is filling or emptying. Four colours cover the whole box, and anything that fails to add up shows as an asymmetry you can see without doing arithmetic.`,
    fixes: ['Four colours total in the main box', 'Makes the physics legible — the mirror has to match', 'No line crosses any fill'],
    costs: ['Per-device detail leaves the main box', 'An unfamiliar form; it needs its caption'],
    verdict: 'Best when the question is "do these numbers add up?".',
  },
  {
    id: 'repaired',
    tag: 'C',
    name: 'The same chart, repaired',
    lede: 'The smallest intervention that actually fixes it.',
    body: `The form is today's: stacked consumption with flows over the top. Only four things change. Devices are grouped into six kinds of load with fixed colours. Price moves up to its own strip and state of charge down to its own, leaving the main box a single axis. Import and export become <em>one</em> signed grid line, charge and discharge <em>one</em> battery line — two strokes instead of four. Both get a surface-coloured halo so they survive crossing the stack.
    <br><br>Solar is drawn as a dotted outline over the stack rather than a filled area, so "did the sun cover it?" is one comparison between two edges instead of a hunt through overlapping fills.`,
    fixes: ['Keeps the learned form and its interaction', 'Halves the number of lines in the box', 'Least work to land in the existing Recharts component'],
    costs: ['Still the densest main box of the five', 'Fixes crowding, not abundance'],
    verdict: 'The one to build first if something has to ship this week.',
  },
  {
    id: 'decision',
    tag: 'D',
    name: 'The decision view',
    lede: 'Not what the house did — why the plan chose it.',
    body: `The other four draw physics. This one draws the reasoning. What power costs on top, with the cheapest and dearest quarters marked. Below it a lane per controllable load, where each block is a run the plan decided on: solid if it has already happened, dashed if it is still ahead. Then the battery's trajectory, and finally the kronor, accumulated.
    <br><br>Read top to bottom it answers the only question a customer actually asks: <em>why did the car charge at two in the morning?</em> The blocks sit in the price trough. That is the whole answer, and it needs nobody to explain it.`,
    fixes: ['Makes the plan auditable, not merely visible', 'Measured versus planned becomes fill, not opacity', 'Cost gets a curve instead of a number in a box at the top'],
    costs: ['Shows no total power at all', 'Complements the other four rather than replacing them'],
    verdict: 'The best customer-facing chart of the five. The worst debugging tool.',
  },
  {
    id: 'matrix',
    tag: 'E',
    name: 'The meter matrix',
    lede: 'Twenty meters, not one colour collision.',
    body: `If nineteen devices will not fit into nineteen colours, let position carry identity and darkness carry magnitude. One row per meter, one column per quarter, a stronger cell meaning more power (darker on a light ground, brighter on a dark one). Rows sort by energy over the window, and the bar on the right gives absolute kilowatt-hours so colour is never the only route to a value.
    <br><br>The ramp is square-root rather than linear: a 90 W fridge and a 3.7 kW charger have to share one scale, and linearly everything but the charger is white. The shape of the day — what runs constantly, what runs in bursts, what the planner shifted into the night — reads in about a second.`,
    fixes: ['Scales to any number of meters', 'Zero colour collisions by construction', 'Shows timing, which a stack hides'],
    costs: ['Magnitude becomes approximate', 'Needs height: about 15 px per meter'],
    verdict: 'The right home for the device detail that currently crowds the main chart.',
  },
];

// ---------------------------------------------------------------------------
// Table view — the relief rule: no value reachable only through colour
// ---------------------------------------------------------------------------

const hourly = Array.from({ length: 36 }, (_, h) => {
  const slice = rows.slice(h * 4, h * 4 + 4);
  const mean = pick => slice.reduce((sum, r) => sum + pick(r), 0) / slice.length;
  return {
    hour: label(slice[0].ms, true),
    measured: h * 4 < NOW_INDEX,
    price: mean(r => r.importPriceSekPerKwh),
    solar: kw(mean(r => r.solarW)),
    load: kw(mean(r => r.loadW)),
    grid: kw(mean(r => r.gridImportW - r.gridExportW)),
    battery: kw(mean(r => r.batteryDischargeW - r.batteryChargeW)),
    soc: slice[slice.length - 1].homeSoc * 100,
  };
});

const hourlyTable = `
<table class="data">
  <caption>By the hour — mean power, battery level at the close of each hour. Greyed rows are plan, not measurement. Grid and battery are signed: positive is into the house.</caption>
  <thead><tr>
    <th scope="col">Hour</th><th scope="col">Price</th><th scope="col">Solar</th>
    <th scope="col">Load</th><th scope="col">Grid</th><th scope="col">Battery</th><th scope="col">SOC</th>
  </tr></thead>
  <tbody>
    ${hourly.map(h => `<tr${h.measured ? '' : ' class="planned"'}>
      <th scope="row">${h.hour}</th>
      <td>${h.price.toFixed(2)}</td><td>${h.solar.toFixed(2)}</td><td>${h.load.toFixed(2)}</td>
      <td>${h.grid.toFixed(2)}</td><td>${h.battery.toFixed(2)}</td><td>${h.soc.toFixed(0)}%</td>
    </tr>`).join('')}
  </tbody>
</table>`;

const meterTable = `
<table class="data">
  <caption>Energy per meter across the 36 hours, largest first.</caption>
  <thead><tr><th scope="col">Meter</th><th scope="col">Kind of load</th><th scope="col">kWh</th><th scope="col">Peak kW</th></tr></thead>
  <tbody>
    ${meters.map(m => `<tr>
      <th scope="row">${m.label}</th>
      <td><span class="swatch" style="background:var(--c-${m.group})"></span>${GROUPS.find(g => g.key === m.group)?.label ?? m.group}</td>
      <td>${m.kwh.toFixed(2)}</td><td>${(Math.max(...m.values) / 1000).toFixed(2)}</td>
    </tr>`).join('')}
  </tbody>
</table>`;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------


/**
 * Every chart carries a legend, because a colour that can only be resolved by
 * hovering is not a legend. Direct labels inside the plot handle the two or
 * three bands thick enough to hold one; this handles the rest.
 */
const FLOWS = [['Solar', '--c-solar'], ['Battery', '--c-battery'], ['Grid', '--c-grid']];
const LOADS = GROUPS.map(g => [g.label, `--c-${g.key}`]);

const LEGENDS = {
  target: [
    ['Flows', FLOWS],
    ['Loads', LOADS],
    ['Lines', [['Buy price, cheap → dear', null, 'ramp'], ['Sell price', '--ink-muted', 'line'],
      ['Solar', '--c-solar', 'dot'], ['Home SOC', '--c-battery', 'line'],
      ['Car SOC', '--c-ev', 'line'], ['Cost to date', '--ink', 'line']]],
  ],
  panels: [
    ['Flows', FLOWS],
    ['Loads', LOADS],
    ['Lines', [['Buy price', '--ink', 'line'], ['Sell price', '--ink-muted', 'line'],
      ['Solar', '--c-solar', 'dot'], ['Home SOC', '--c-battery', 'line'], ['Car SOC', '--c-ev', 'line']]],
  ],
  mirror: [
    ['Came from', FLOWS],
    ['Went to', [['House demand', '--c-load'], ['Battery', '--c-battery'], ['Grid', '--c-grid']]],
    ['Lines', [['Buy price', '--ink', 'line'], ['Home SOC', '--c-battery', 'line'], ['Car SOC', '--c-ev', 'line']]],
  ],
  repaired: [
    ['Loads', LOADS],
    ['Lines', [['Grid, signed', '--c-grid', 'line'], ['Battery, signed', '--c-battery', 'line'],
      ['Solar', '--c-solar', 'dot'], ['Buy price', '--ink', 'line'],
      ['Home SOC', '--c-battery', 'line'], ['Car SOC', '--c-ev', 'line']]],
  ],
  decision: [
    ['Price', [['Cheapest quarter', '--band-cheap'], ['Middle half', '--band-mid'], ['Dearest quarter', '--band-dear']]],
    ['Lanes', [['Hot water', '--c-hotwater'], ['EV charging', '--c-ev'], ['Pool', '--c-pool']]],
    ['Lines', [['Home SOC', '--c-battery', 'line'], ['Car SOC', '--c-ev', 'line'], ['Cost to date', '--ink', 'line']]],
  ],
  matrix: [
    ['Flows', FLOWS],
    ['kWh bars', LOADS],
  ],
};

const legendMark = (cssVar, kind) => kind === 'ramp'
  ? '<span class="mk mk-ramp"></span>'
  : kind === 'line'
  ? `<span class="mk mk-line" style="background:var(${cssVar})"></span>`
  : kind === 'dot'
    ? `<span class="mk mk-dot" style="background:repeating-linear-gradient(90deg,var(${cssVar}) 0 2px,transparent 2px 5px)"></span>`
    : `<span class="mk mk-box" style="background:var(${cssVar})"></span>`;

const legendFor = id => `<div class="legend">${LEGENDS[id].map(([heading, items]) => `
  <div class="legend-group">
    <span class="legend-head">${heading}</span>
    ${items.map(([name, cssVar, kind]) => `<span class="key">${legendMark(cssVar, kind)}${name}</span>`).join('')}
  </div>`).join('')}</div>`;

const chartCard = alt => `
<article class="alt" id="alt-${alt.id}">
  <header class="alt-head">
    <div class="alt-tag${alt.target ? ' is-target' : ''}">${alt.tag}</div>
    <div>
      <h2>${alt.name}</h2>
      <p class="lede">${alt.lede}</p>
    </div>
  </header>
  <div class="alt-body"><p>${alt.body}</p></div>
  <figure class="plot" data-chart="${alt.id}">
    <div class="plot-scroll">${charts[alt.id].svg}</div>
    <div class="tip" hidden></div>
    <figcaption>${legendFor(alt.id)}</figcaption>
  </figure>
  <div class="ledger">
    <div><h3>What it fixes</h3><ul>${alt.fixes.map(f => `<li>${f}</li>`).join('')}</ul></div>
    <div><h3>What it costs</h3><ul>${alt.costs.map(c => `<li>${c}</li>`).join('')}</ul></div>
    <div class="verdict"><h3>Verdict</h3><p>${alt.verdict}</p></div>
  </div>
</article>`;

const html = `<meta charset="utf-8">
<title>Liveplan Redrawn</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
:root {
  color-scheme: light;
  --ground: #f2f4f6;
  --surface: #ffffff;
  --surface-2: #f7f9fa;
  --ink: #101418;
  --ink-soft: #3d4650;
  --ink-muted: #6d7783;
  --hairline: #e1e6ea;
  --grid: #e7ebee;
  --axis: #c8d0d7;
  --accent: #2a78d6;

  --c-solar: #eb6834;
  --c-grid: #2a78d6;
  --c-battery: #1baf7a;
  --c-hotwater: #e34948;
  --c-ev: #4a3aa7;
  --c-pool: #008300;
  --c-kitchen: #e87ba4;
  --c-plugs: #eda100;
  --c-base: #8a8f98;
  --c-load: #8a8f98;

  --price-wash: rgba(16, 20, 24, 0.055);
  --cost-wash: rgba(16, 20, 24, 0.07);
  --plan-wash: rgba(42, 120, 214, 0.055);
  --lane: #eef1f4;
  --band-cheap: #cfe0f2;
  --band-mid: #e4e8ec;
  --band-dear: #f6d3ca;

  --cell-0: #f4f6f8; --cell-1: #dde3e9; --cell-2: #bcc7d2; --cell-3: #93a3b3;
  --cell-4: #6a7d90; --cell-5: #42566b; --cell-6: #1d2c3c;

  --price-1: #1b5aa8; --price-2: #4a8ed6; --price-3: #9dc0e2; --price-4: #b9bcc0;
  --price-5: #eda893; --price-6: #d4634f; --price-7: #a92e22;

  --font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-cond: "IBM Plex Sans Condensed", "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ground: #0a0d11;
    --surface: #14181e;
    --surface-2: #191e25;
    --ink: #eef1f4;
    --ink-soft: #b6bfc9;
    --ink-muted: #87919c;
    --hairline: #232931;
    --grid: #222831;
    --axis: #38414c;
    --accent: #3987e5;

    --c-solar: #d95926;
    --c-grid: #3987e5;
    --c-battery: #199e70;
    --c-hotwater: #e66767;
    --c-ev: #9085e9;
    --c-pool: #008300;
    --c-kitchen: #d55181;
    --c-plugs: #c98500;
    --c-base: #7d838c;
    --c-load: #7d838c;

    --price-wash: rgba(238, 241, 244, 0.08);
    --cost-wash: rgba(238, 241, 244, 0.1);
    --plan-wash: rgba(57, 135, 229, 0.1);
    --lane: #1c2129;
    --band-cheap: #1e3550;
    --band-mid: #2b323a;
    --band-dear: #4d2e24;

    --cell-0: #171c22; --cell-1: #28313b; --cell-2: #3c4854; --cell-3: #56646f;
    --cell-4: #78868f; --cell-5: #a2adb5; --cell-6: #d5dde3;

    --price-1: #8fc3f5; --price-2: #5f9fe8; --price-3: #3d78b8; --price-4: #7c828b;
    --price-5: #c06a54; --price-6: #e07a63; --price-7: #f5a58e;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --ground: #0a0d11;
  --surface: #14181e;
  --surface-2: #191e25;
  --ink: #eef1f4;
  --ink-soft: #b6bfc9;
  --ink-muted: #87919c;
  --hairline: #232931;
  --grid: #222831;
  --axis: #38414c;
  --accent: #3987e5;

  --c-solar: #d95926;
  --c-grid: #3987e5;
  --c-battery: #199e70;
  --c-hotwater: #e66767;
  --c-ev: #9085e9;
  --c-pool: #008300;
  --c-kitchen: #d55181;
  --c-plugs: #c98500;
  --c-base: #7d838c;
  --c-load: #7d838c;

  --price-wash: rgba(238, 241, 244, 0.08);
  --cost-wash: rgba(238, 241, 244, 0.1);
  --plan-wash: rgba(57, 135, 229, 0.1);
  --lane: #1c2129;
  --band-cheap: #1e3550;
  --band-mid: #2b323a;
  --band-dear: #4d2e24;

  --cell-0: #171c22; --cell-1: #28313b; --cell-2: #3c4854; --cell-3: #56646f;
  --cell-4: #78868f; --cell-5: #a2adb5; --cell-6: #d5dde3;

  --price-1: #8fc3f5; --price-2: #5f9fe8; --price-3: #3d78b8; --price-4: #7c828b;
  --price-5: #c06a54; --price-6: #e07a63; --price-7: #f5a58e;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.wrap {
  max-width: 1300px;
  margin: 0 auto;
  padding: clamp(28px, 4vw, 64px) clamp(16px, 3vw, 40px) 96px;
  display: flex;
  flex-direction: column;
  gap: clamp(32px, 4vw, 56px);
}
h1, h2, h3 { text-wrap: balance; margin: 0; }
h1 {
  font-family: var(--font-cond);
  font-weight: 700;
  font-size: clamp(34px, 5.5vw, 58px);
  line-height: 1.02;
  letter-spacing: -0.015em;
}
h2 { font-family: var(--font-cond); font-weight: 700; font-size: 25px; letter-spacing: -0.005em; }
h3 {
  font-family: var(--font-mono); font-weight: 600; font-size: 10.5px;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-muted);
}
p { margin: 0; }
code {
  font-family: var(--font-mono); font-size: 0.88em;
  background: var(--surface-2); padding: 0.1em 0.35em; border-radius: 3px;
  border: 1px solid var(--hairline);
}
em { font-style: normal; font-weight: 600; }

.eyebrow {
  font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--accent); font-weight: 600;
}
.masthead { display: flex; flex-direction: column; gap: 16px; max-width: 70ch; }
.masthead .standfirst { font-size: 18px; color: var(--ink-soft); line-height: 1.55; }
.meta {
  display: flex; flex-wrap: wrap; gap: 8px 22px; font-family: var(--font-mono);
  font-size: 11.5px; color: var(--ink-muted); padding-top: 8px;
  border-top: 1px solid var(--hairline); margin-top: 4px;
}
.meta b { color: var(--ink-soft); font-weight: 500; }

section.card, article.alt {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: clamp(20px, 2.6vw, 34px);
  display: flex; flex-direction: column; gap: 22px;
}

.faults { display: grid; gap: 2px; margin: 0; }
.fault {
  display: grid; grid-template-columns: minmax(0, 24ch) minmax(0, 1fr);
  gap: 6px 28px; padding: 14px 0; border-top: 1px solid var(--hairline);
}
.fault:first-child { border-top: none; padding-top: 0; }
.fault dt { font-weight: 600; color: var(--ink); }
.fault dd { margin: 0; color: var(--ink-soft); font-size: 14px; }
@media (max-width: 720px) { .fault { grid-template-columns: 1fr; } }

.vocab { display: flex; flex-wrap: wrap; gap: 6px 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--hairline); border-radius: 999px;
  padding: 5px 12px 5px 8px; font-size: 12.5px; background: var(--surface-2);
}
.chip .dot { width: 11px; height: 11px; border-radius: 3px; flex: none; }
.chip small { color: var(--ink-muted); font-size: 11.5px; }

.alt-head { display: flex; gap: 18px; align-items: flex-start; }
.alt-tag {
  font-family: var(--font-cond); font-weight: 700; font-size: 26px; line-height: 1;
  width: 46px; height: 46px; flex: none; border-radius: 8px;
  display: grid; place-items: center;
  background: var(--ink); color: var(--surface);
}
.alt-tag.is-target { background: var(--accent); color: #ffffff; }
article.alt:has(.is-target) { border-color: var(--accent); }
.lede { color: var(--ink-soft); font-size: 16px; margin-top: 3px; }
.alt-body { max-width: 76ch; color: var(--ink-soft); font-size: 14.5px; }

.plot { margin: 0; position: relative; }
.plot-scroll {
  overflow-x: auto; overscroll-behavior-x: contain;
  border: 1px solid var(--hairline); border-radius: 8px;
  background: var(--surface); padding: 6px 4px;
}
.plot-scroll > svg { display: block; width: 100%; min-width: 880px; height: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 22px; margin-top: 12px; }
.legend-group { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.legend-head {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--ink-muted);
}
.key { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-soft); }
.mk { flex: none; display: inline-block; }
.mk-box { width: 11px; height: 11px; border-radius: 2px; }
.mk-line { width: 14px; height: 2.5px; border-radius: 2px; }
.mk-dot { width: 14px; height: 2.5px; border-radius: 1px; }
.mk-ramp {
  width: 56px; height: 9px; border-radius: 2px;
  background: linear-gradient(90deg,
    var(--price-1) 0 14.28%, var(--price-2) 14.28% 28.57%, var(--price-3) 28.57% 42.85%,
    var(--price-4) 42.85% 57.14%, var(--price-5) 57.14% 71.42%, var(--price-6) 71.42% 85.71%,
    var(--price-7) 85.71% 100%);
}

.tip {
  position: absolute; z-index: 5; pointer-events: none;
  background: var(--surface); border: 1px solid var(--hairline);
  border-radius: 7px; padding: 9px 11px; min-width: 178px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.16);
  font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
}
.tip .tip-t { font-weight: 600; color: var(--ink); margin-bottom: 5px; letter-spacing: 0.02em; }
.tip .tip-row { display: flex; justify-content: space-between; gap: 16px; color: var(--ink-soft); }
.tip .tip-row b { font-weight: 500; color: var(--ink); font-variant-numeric: tabular-nums; }
.tip .tip-head { color: var(--ink-muted); margin-top: 5px; }
.tip .tip-rule { margin-top: 5px; border-top: 1px solid var(--hairline); padding-top: 5px; }
.tip .tip-tag {
  display: inline-block; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-muted); border: 1px solid var(--hairline); border-radius: 3px;
  padding: 0 4px; margin-left: 6px;
}

.ledger { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.ledger ul { margin: 8px 0 0; padding-left: 17px; color: var(--ink-soft); font-size: 13.5px; }
.ledger li { margin-bottom: 4px; }
.ledger .verdict p { margin-top: 8px; color: var(--ink); font-size: 13.5px; font-weight: 500; }
@media (max-width: 780px) { .ledger { grid-template-columns: 1fr; gap: 18px; } }

details.tables { border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface); }
details.tables > summary {
  cursor: pointer; padding: 16px clamp(20px, 2.6vw, 34px);
  font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ink-soft);
}
details.tables > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tables-inner {
  padding: 0 clamp(20px, 2.6vw, 34px) clamp(20px, 2.6vw, 34px);
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px;
  align-items: start;
}
@media (max-width: 900px) { .tables-inner { grid-template-columns: 1fr; } }
.data { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--font-mono); }
.data caption {
  text-align: left; color: var(--ink-muted); font-size: 11.5px; padding-bottom: 8px;
  font-family: var(--font-sans); line-height: 1.45;
}
.data th, .data td {
  text-align: right; padding: 3px 8px; border-bottom: 1px solid var(--hairline);
  font-variant-numeric: tabular-nums;
}
.data thead th { color: var(--ink-muted); font-weight: 500; border-bottom: 1px solid var(--axis); }
.data tbody th { text-align: left; font-weight: 500; color: var(--ink-soft); }
.data td:nth-child(2) { text-align: left; }
.data tr.planned, .data tr.planned th { color: var(--ink-muted); }
.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }

.close { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 32px; align-items: start; }
@media (max-width: 860px) { .close { grid-template-columns: 1fr; } }
.close p + p { margin-top: 12px; }
.runbox {
  background: var(--surface-2); border: 1px solid var(--hairline); border-radius: 8px;
  padding: 16px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-soft);
  line-height: 1.55; overflow-wrap: anywhere;
}
.runbox b { display: block; color: var(--ink); font-weight: 600; }
.runbox span { display: block; margin-bottom: 14px; }
.runbox span:last-child { margin-bottom: 0; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">Design review · 15-minute live plan</p>
    <h1>Five ways to draw the same day</h1>
    <p class="standfirst">
      The chart is hard to read, and it is not really the colours. It is trying to be
      four charts at once — kilowatts, per cent, kronor per kilowatt-hour and nineteen
      device meters — inside one box with three y-axes. Below: six concrete faults, then
      the <em>refined target</em> we landed on, followed by the five alternatives it was
      assembled from. All six are drawn from the same dataset in the same colour
      vocabulary, so the only thing that differs between them is the arrangement.
    </p>
    <div class="meta">
      <span><b>36 hours</b> · 144 quarters</span>
      <span><b>now</b> 25 Aug, 21:45</span>
      <span>solar <b>${day.solarKwh.toFixed(1)} kWh</b></span>
      <span>load <b>${day.loadKwh.toFixed(1)} kWh</b></span>
      <span>import <b>${day.importKwh.toFixed(1)} kWh</b></span>
      <span>export <b>${day.exportKwh.toFixed(1)} kWh</b></span>
    </div>
  </header>

  <section class="card">
    <div>
      <p class="eyebrow">Diagnosis</p>
      <h2>Six faults, five of them structural</h2>
    </div>
    <dl class="faults">
      ${FAULTS.map(([term, def]) => `<div class="fault"><dt>${term}</dt><dd>${def}</dd></div>`).join('')}
    </dl>
    <p class="alt-body">
      Only the last one is a colour choice. The rest are decisions about what shares a
      box with what — which is why the alternatives below differ in <em>layout</em>,
      not in palette. The palette is identical in all five.
    </p>
  </section>

  <section class="card">
    <div>
      <p class="eyebrow">Shared colour vocabulary</p>
      <h2>One colour per thing, in all five</h2>
    </div>
    <div class="vocab">
      ${VOCAB.map(([name, cssVar, note]) => `<span class="chip"><span class="dot" style="background:var(${cssVar})"></span>${name} <small>${note}</small></span>`).join('')}
    </div>
    <p class="alt-body">
      Nine meanings, eight hues and one deliberate neutral grey for the remainder —
      against today's nineteen series over eight cycled colours. Every pair was checked
      for colour-vision deficiency (deutan, protan, tritan) against both the light and
      the dark surface: the three flow colours clear the threshold against
      <em>each other</em> in every direction, and the load colours clear it against
      their neighbours in the stack. Solar did not keep yellow — yellow and orange sit
      too close to stand side by side — so the sun took orange and the battery green.
    </p>
  </section>

  ${ALTERNATIVES.map(chartCard).join('\n')}

  <section class="card close">
    <div>
      <p class="eyebrow">Recommendation</p>
      <h2>Build T, keep E for the detail</h2>
      <p style="margin-top:14px;color:var(--ink-soft)">
        <em>T</em> is the one to build: A's panel stack, D's cumulative cost, and a price
        line coloured by how dear the quarter is. It removes every structural fault at
        once and it is the only version where the money question and the power question
        share a time axis.
      </p>
      <p style="color:var(--ink-soft)">
        <em>E</em> stays worth building separately. Per-device detail does not belong in
        the main chart at all — nineteen meters cannot share eight colours — and as a
        matrix it becomes better than it ever was as a stack. <em>B</em> and <em>D</em>
        remain useful as specialists: B to check that the numbers add up, D to show a
        customer why the car charged at two. <em>C</em> is the fallback if T turns out
        too tall for the page it has to live on.
      </p>
    </div>
    <div class="runbox">
      <b>Redraw</b><span>node design/plan-chart-alternatives/build.mjs</span>
      <b>Swap in real data</b><span>Replace <code>buildDataset()</code> in data.mjs with a
      reader over an export of the same row shape. The charts do not change.</span>
      <b>About the data</b><span>Simulated, shaped against the day in the screenshot and
      solved so every quarter balances. Solar ${day.solarKwh.toFixed(1)},
      load ${day.loadKwh.toFixed(1)} and export ${day.exportKwh.toFixed(1)} kWh hit the
      portal's own figures; import lands at ${day.importKwh.toFixed(1)} against
      ${SCREENSHOT_TOTALS.importKwh}.</span>
    </div>
  </section>

  <details class="tables">
    <summary>Table view — every value without going through colour</summary>
    <div class="tables-inner">
      ${hourlyTable}
      ${meterTable}
    </div>
  </details>

</div>

<script>
(function () {
  var Q = ${JSON.stringify(quarters)};
  var G = ${JSON.stringify(GROUPS.map(g => [g.key, g.label]))};
  var NOW = ${NOW_INDEX};
  var RULE = '<div class="tip-rule"></div>';

  function row(name, value, unit) {
    return '<div class="tip-row"><span>' + name + '</span><b>' + value + (unit ? ' ' + unit : '') + '</b></div>';
  }
  function kwRows(rec, keys) {
    return keys.filter(function (k) { return Math.abs(rec[k[0]]) >= 0.02; })
      .map(function (k) { return row(k[1], rec[k[0]].toFixed(2), 'kW'); }).join('');
  }

  var RENDER = {
    target: function (rec) {
      return RENDER.full(rec) + row('Cost so far', rec.cum.toFixed(2), 'kr');
    },
    full: function (rec) {
      var groupRows = G.filter(function (g) { return rec.g[g[0]] >= 0.02; })
        .map(function (g) { return row(g[1], rec.g[g[0]].toFixed(2), 'kW'); }).join('');
      return kwRows(rec, [['solar', 'Solar'], ['imp', 'Grid in'], ['exp', 'Grid out'],
          ['dis', 'Battery out'], ['chg', 'Battery in']])
        + RULE + row('House demand', rec.load.toFixed(2), 'kW') + groupRows
        + RULE + row('Home SOC', rec.soc, '%') + row('Car SOC', rec.ev, '%')
        + row('Buy', rec.pin.toFixed(2), 'SEK/kWh') + row('Sell', rec.pout.toFixed(2), 'SEK/kWh');
    },
    balance: function (rec) {
      return '<div class="tip-row tip-head"><span>Came from</span><b></b></div>'
        + kwRows(rec, [['own', 'Solar'], ['dis', 'Battery'], ['imp', 'Grid']])
        + '<div class="tip-row tip-head"><span>Went to</span><b></b></div>'
        + kwRows(rec, [['load', 'House'], ['chg', 'Battery'], ['exp', 'Grid']])
        + RULE + row('Home SOC', rec.soc, '%') + row('Buy', rec.pin.toFixed(2), 'SEK/kWh');
    },
    decision: function (rec) {
      var names = { hot_water: 'Hot water', ev: 'EV', pool_heater: 'Pool heater', pool_pump: 'Pool pump' };
      var runs = Object.keys(rec.d).filter(function (k) { return rec.d[k] >= 0.02; })
        .map(function (k) { return row(names[k], rec.d[k].toFixed(2), 'kW'); }).join('');
      return row('Buy', rec.pin.toFixed(2), 'SEK/kWh')
        + (runs || '<div class="tip-row"><span>Nothing dispatched</span><b>—</b></div>')
        + RULE + row('Home SOC', rec.soc, '%') + row('Car SOC', rec.ev, '%')
        + row('Cost so far', rec.cum.toFixed(2), 'kr');
    },
    matrix: function (rec) {
      return kwRows(rec, [['own', 'Solar'], ['dis', 'Battery out'], ['imp', 'Grid in']])
        + row('House demand', rec.load.toFixed(2), 'kW')
        + row('Buy', rec.pin.toFixed(2), 'SEK/kWh');
    }
  };

  document.querySelectorAll('figure.plot').forEach(function (fig) {
    var svg = fig.querySelector('svg');
    var tip = fig.querySelector('.tip');
    var scroller = fig.querySelector('.plot-scroll');
    if (!svg || !tip) return;
    var plot = JSON.parse(svg.getAttribute('data-plot'));
    var ns = 'http://www.w3.org/2000/svg';

    var band = document.createElementNS(ns, 'rect');
    band.setAttribute('y', plot.y0);
    band.setAttribute('height', plot.y1 - plot.y0);
    band.setAttribute('fill', 'var(--ink)');
    band.setAttribute('fill-opacity', '0.07');
    band.setAttribute('pointer-events', 'none');
    band.style.display = 'none';
    svg.insertBefore(band, svg.firstChild);

    var hair = document.createElementNS(ns, 'line');
    hair.setAttribute('y1', plot.y0);
    hair.setAttribute('y2', plot.y1);
    hair.setAttribute('stroke', 'var(--ink)');
    hair.setAttribute('stroke-width', '1');
    hair.setAttribute('stroke-opacity', '0.5');
    hair.setAttribute('pointer-events', 'none');
    hair.style.display = 'none';
    svg.appendChild(hair);

    var step = (plot.x1 - plot.x0) / plot.n;

    function move(event) {
      var box = svg.getBoundingClientRect();
      var vx = (event.clientX - box.left) * (svg.viewBox.baseVal.width / box.width);
      var i = Math.floor((vx - plot.x0) / step);
      if (i < 0 || i >= plot.n) { hide(); return; }
      var rec = Q[i];
      hair.setAttribute('x1', plot.x0 + i * step + step / 2);
      hair.setAttribute('x2', plot.x0 + i * step + step / 2);
      band.setAttribute('x', plot.x0 + i * step);
      band.setAttribute('width', Math.max(step, 1.5));
      hair.style.display = '';
      band.style.display = '';
      tip.innerHTML = '<div class="tip-t">' + rec.t
        + '<span class="tip-tag">' + (i < NOW ? 'measured' : 'plan') + '</span></div>'
        + RENDER[plot.fields](rec);
      tip.hidden = false;
      var figBox = fig.getBoundingClientRect();
      var left = event.clientX - figBox.left + 16;
      if (left + tip.offsetWidth > figBox.width - 8) left = event.clientX - figBox.left - tip.offsetWidth - 16;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.min(
        Math.max(8, event.clientY - figBox.top - tip.offsetHeight / 2),
        figBox.height - tip.offsetHeight - 8
      ) + 'px';
    }
    function hide() {
      hair.style.display = 'none';
      band.style.display = 'none';
      tip.hidden = true;
    }
    scroller.addEventListener('pointermove', move);
    scroller.addEventListener('pointerleave', hide);
  });
})();
</script>
`;

const outDir = join(HERE, 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);

console.log(`wrote out/index.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
console.log(`  ${rows.length} quarters, now at ${NOW_INDEX} (${label(rows[NOW_INDEX].ms, true)})`);
for (const [key, chart] of Object.entries(charts)) {
  console.log(`  ${key.padEnd(9)} ${String(chart.height).padStart(4)} px  ${(chart.svg.length / 1024).toFixed(0)} KB`);
}
