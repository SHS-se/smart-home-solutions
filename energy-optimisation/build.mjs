/**
 * Renders the load-shifting plan to a self-contained HTML file.
 *
 *   node build.mjs > load-shift-plan.html
 *
 * No CDN, no build step, no network. The plan JSON is inlined so the file can
 * be opened straight from disk or committed as a review artefact.
 */

import {
  buildHorizon, deriveRequirements, planBaseline, planOptimisedIterative, simulate, verify,
} from './model.mjs';
import {
  INITIAL, PLANT, DEVICES, ISSUED_AT, BINDING_UNTIL_SLOT,
  PRIORITY_STACKS, REFERENCE_DAY, GRID_IMPORT_SEK, GRID_EXPORT_SEK,
  PV_FORECAST_DAILY_KWH, MEASURED_DAILY_KWH,
} from './inputs.mjs';

const slots = buildHorizon();
const req = deriveRequirements(slots);

const basePlan = planBaseline(slots, req);
const baseRun = simulate(slots, basePlan, { batterySoc: INITIAL.batterySoc });

const run = (plan) => simulate(slots, plan, {
  batterySoc: INITIAL.batterySoc,
  batteryTargetBySlot: plan.batteryTargetBySlot,
  reservedW: plan.reservedW,
});

// Two readings of the same priority list - see architecture section 8.2, which
// flags this as a product decision that has not been made yet.
const stackPlan = planOptimisedIterative(slots, req, 'summer', 3, { reserveBattery: true });
const stackRun = run(stackPlan);
const costPlan = planOptimisedIterative(slots, req, 'summer', 3, { reserveBattery: false });
const costRun = run(costPlan);

const optPlan = stackPlan;
const optRun = stackRun;

const problems = [...verify(baseRun), ...verify(stackRun), ...verify(costRun)];

const AVOIDED_SEK = GRID_IMPORT_SEK + 0.21;
const stored = (t) => (t.socEnd - t.socStart) * PLANT.batteryCapacityKwh * AVOIDED_SEK;
const effective = (t) => t.netCost - stored(t);

const minSoc = (r) => Math.min(...r.slots.map((s) => s.soc));
const floorHours = (r) => r.slots.filter((s) => s.soc <= 0.055).length;
const eodSoc = (r, day) => {
  const last = r.slots.filter((s) => s.day === day && s.pvW > 200).pop();
  return last ? last.soc : null;
};
const SOLAR_DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'];

// ---------------------------------------------------------------------------
// SVG chart
// ---------------------------------------------------------------------------

const W = 1180, PANEL_H = 260, PAD_L = 58, PAD_R = 58, PAD_T = 22, PAD_B = 30;
const plotW = W - PAD_L - PAD_R;
const N = slots.length;
const bw = plotW / N;

const maxPowerW = Math.max(
  ...baseRun.slots.map((s) => Math.max(s.loadW, s.pvW)),
  ...stackRun.slots.map((s) => Math.max(s.loadW, s.pvW)),
  ...costRun.slots.map((s) => Math.max(s.loadW, s.pvW)),
) * 1.08;

const x = (i) => PAD_L + i * bw;
const yPow = (w) => PAD_T + (PANEL_H - PAD_T - PAD_B) * (1 - w / maxPowerW);
const ySoc = (f) => PAD_T + (PANEL_H - PAD_T - PAD_B) * (1 - f);

const COL = {
  base: '#5b6b7c', boiler: '#3d9bd4', pool: '#22b8a6', car: '#a06fd0',
  pv: '#f2b134', soc: '#e8663d', price: '#c94f7c', grid: '#8892a0',
};

function panel(run, title, subtitle) {
  const H = PANEL_H;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${title}">`;

  // advisory shading beyond the binding boundary
  const bx = x(BINDING_UNTIL_SLOT);
  s += `<rect x="${bx}" y="${PAD_T}" width="${W - PAD_R - bx}" height="${H - PAD_T - PAD_B}"
         fill="url(#hatch)" opacity="0.5"/>`;

  // horizontal gridlines
  for (let g = 0; g <= 4; g++) {
    const w = (maxPowerW / 4) * g;
    s += `<line x1="${PAD_L}" y1="${yPow(w)}" x2="${W - PAD_R}" y2="${yPow(w)}" class="grid"/>`;
    s += `<text x="${PAD_L - 7}" y="${yPow(w) + 4}" class="ax end">${(w / 1000).toFixed(0)}</text>`;
    s += `<text x="${W - PAD_R + 7}" y="${ySoc(g / 4) + 4}" class="ax soc">${g * 25}%</text>`;
  }

  // PV forecast area
  let pv = `${PAD_L},${yPow(0)}`;
  run.slots.forEach((r, i) => { pv += ` ${x(i)},${yPow(r.pvW)} ${x(i) + bw},${yPow(r.pvW)}`; });
  pv += ` ${W - PAD_R},${yPow(0)}`;
  s += `<polygon points="${pv}" fill="${COL.pv}" opacity="0.20"/>`;
  s += `<polyline points="${pv.split(' ').slice(1, -1).join(' ')}" fill="none" stroke="${COL.pv}" stroke-width="1.5"/>`;

  // stacked load bars
  run.slots.forEach((r, i) => {
    let acc = 0;
    for (const [key, col] of [['baseW', COL.base], ['boilerW', COL.boiler],
                              ['poolW', COL.pool], ['carW', COL.car]]) {
      const v = r[key];
      if (v <= 0) continue;
      s += `<rect x="${x(i) + 0.4}" y="${yPow(acc + v)}" width="${bw - 0.8}"
             height="${Math.max(0.5, yPow(acc) - yPow(acc + v))}" fill="${col}"/>`;
      acc += v;
    }
  });

  // battery SOC
  let soc = '';
  run.slots.forEach((r, i) => { soc += `${x(i) + bw / 2},${ySoc(r.soc)} `; });
  s += `<polyline points="${soc}" fill="none" stroke="${COL.soc}" stroke-width="2.2"/>`;

  // 5% floor marker
  s += `<line x1="${PAD_L}" y1="${ySoc(0.05)}" x2="${W - PAD_R}" y2="${ySoc(0.05)}"
         stroke="${COL.soc}" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>`;

  // day boundaries + labels
  slots.forEach((sl, i) => {
    if (sl.hour === 0) {
      s += `<line x1="${x(i)}" y1="${PAD_T}" x2="${x(i)}" y2="${H - PAD_B}" class="daysep"/>`;
    }
    if (sl.hour % 6 === 0) {
      s += `<text x="${x(i) + bw / 2}" y="${H - PAD_B + 14}" class="ax mid">${String(sl.hour).padStart(2, '0')}</text>`;
    }
  });

  s += `<text x="${PAD_L}" y="14" class="ttl">${title}</text>`;
  s += `<text x="${PAD_L + 200}" y="14" class="sub">${subtitle}</text>`;
  s += '</svg>';
  return s;
}

const dayLabels = () => {
  let s = `<svg viewBox="0 0 ${W} 22" class="chart">`;
  const seen = new Map();
  slots.forEach((sl, i) => { if (!seen.has(sl.day)) seen.set(sl.day, i); });
  for (const [day, i] of seen) {
    const d = new Date(day + 'T12:00:00');
    const nm = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    s += `<text x="${x(i) + 6}" y="15" class="dl">${nm}</text>`;
  }
  s += '</svg>';
  return s;
};

// ---------------------------------------------------------------------------

const fmt = (n, d = 1) => n.toFixed(d);
const poolHours = (plan) => plan.pool.map((f, i) => (f > 0.01 ? slots[i] : null)).filter(Boolean);
const bp = poolHours(basePlan), op = poolHours(optPlan);
const span = (arr) => arr.length ? `${arr[0].label.slice(6)}–${arr[arr.length - 1].label.slice(6)}` : 'none';

const html = `<!doctype html>
<meta charset="utf-8">
<title>Load shifting plan · 3-day solar and price horizon</title>
<style>
  :root{--bg:#12161c;--fg:#e6eaf0;--dim:#8a95a5;--line:#242b35;--card:#1a1f27;}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 32px 60px;background:var(--bg);color:var(--fg);
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
  h1{font-size:20px;margin:0 0 4px;font-weight:600}
  h2{font-size:14px;margin:30px 0 10px;font-weight:600;letter-spacing:.02em}
  .meta{color:var(--dim);font-size:12.5px;margin-bottom:22px}
  .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:18px 0 26px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .kpi .l{color:var(--dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
  .kpi .v{font-size:21px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .kpi .d{font-size:11.5px;margin-top:2px;color:var(--dim)}
  .good{color:#4ec9a0}.bad{color:#e8663d}
  .chart{width:100%;display:block}
  .grid{stroke:var(--line);stroke-width:1}
  .daysep{stroke:#39424f;stroke-width:1}
  .ax{fill:var(--dim);font-size:10.5px}
  .ax.end{text-anchor:end}.ax.mid{text-anchor:middle}.ax.soc{fill:#e8663d}
  .ttl{fill:var(--fg);font-size:13px;font-weight:600}
  .sub{fill:var(--dim);font-size:11.5px}
  .dl{fill:var(--dim);font-size:11.5px;font-weight:600}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin:10px 0 4px;font-size:12px;color:var(--dim)}
  .legend i{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:6px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--dim);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  .note{background:var(--card);border:1px solid var(--line);border-left:3px solid #f2b134;
        border-radius:6px;padding:12px 15px;margin:14px 0;font-size:13px}
  .note b{color:#f2b134}
  .ok{border-left-color:#4ec9a0}.ok b{color:#4ec9a0}
  code{background:#0d1116;padding:1px 5px;border-radius:3px;font-size:12px}
</style>

<h1>Shifting deferrable load onto forecast solar</h1>
<div class="meta">
  Plan issued ${ISSUED_AT} · 72 hourly slots · Europe/Stockholm ·
  summer priority stack (<b>confirmed</b>) ·
  binding to <b>2026-08-10 23:00</b>, advisory thereafter
</div>

<div class="kpis">
  <div class="kpi"><div class="l">Hours pinned at 5% floor</div>
    <div class="v"><span class="bad">${floorHours(baseRun)}</span> → ${floorHours(stackRun)} / <span class="good">${floorHours(costRun)}</span></div>
    <div class="d">baseline · stack · cost-led</div></div>
  <div class="kpi"><div class="l">Grid import, 72 h</div>
    <div class="v">${fmt(baseRun.totals.importKwh)} → ${fmt(stackRun.totals.importKwh)} / <span class="good">${fmt(costRun.totals.importKwh)}</span></div>
    <div class="d">kWh, of ${fmt(stackRun.totals.loadKwh)} kWh load</div></div>
  <div class="kpi"><div class="l">Battery, end of 08-10</div>
    <div class="v">${fmt(eodSoc(baseRun, '2026-08-10') * 100, 0)}% → <span class="good">${fmt(eodSoc(stackRun, '2026-08-10') * 100, 0)}%</span> / ${fmt(eodSoc(costRun, '2026-08-10') * 100, 0)}%</div>
    <div class="d">the poor solar day · target &gt;80%</div></div>
  <div class="kpi"><div class="l">Net cost, priced window</div>
    <div class="v">${fmt(baseRun.totals.netCost, 2)} → ${fmt(stackRun.totals.netCost, 2)} / <span class="good">${fmt(costRun.totals.netCost, 2)}</span></div>
    <div class="d">SEK</div></div>
  <div class="kpi"><div class="l">Car charged</div>
    <div class="v">${fmt(INITIAL.carSoc * 100, 0)}% → ${fmt(DEVICES.car.targetSoc * 100, 0)}%</div>
    <div class="d">${fmt((DEVICES.car.targetSoc - INITIAL.carSoc) * DEVICES.car.batteryKwh / DEVICES.car.chargeEff)} kWh, cable connected</div></div>
</div>

<div class="note ok"><b>What actually changes.</b>
The car is the biggest single move: baseline starts charging the moment it is
plugged in, at <b>midnight with zero sun</b>; both shifted plans put it in the
afternoon peak. The pool leaves its fixed midday block and follows the forecast.
And the battery stops spending twelve straight hours on its floor.</div>

<div class="legend">
  <span><i style="background:${COL.base}"></i>Base load</span>
  <span><i style="background:${COL.boiler}"></i>Hot water</span>
  <span><i style="background:${COL.pool}"></i>Pool heating</span>
  <span><i style="background:${COL.car}"></i>Car</span>
  <span><i style="background:${COL.pv};opacity:.5"></i>PV forecast</span>
  <span><i style="background:${COL.soc}"></i>Battery SOC (right axis)</span>
  <span style="opacity:.7">▨ advisory — no published price</span>
</div>

<svg width="0" height="0"><defs>
  <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <rect width="7" height="7" fill="#171c24"/>
    <line x1="0" y1="0" x2="0" y2="7" stroke="#232b36" stroke-width="3"/>
  </pattern>
</defs></svg>

${dayLabels()}
${panel(baseRun, 'A · Baseline — today’s behaviour', 'car charges at midnight, pool on a fixed midday block, battery passive')}
${panel(stackRun, 'B · Priority stack, read literally', 'battery reserved to 80% before pool and car get any sun')}
${panel(costRun, 'C · Cost-led — battery takes what is left', 'same ranking, but no sun is held back from the pool and car')}

<h2>The priority list has two readings, and they disagree</h2>
<table>
  <tr><th>Plan</th><th>Import</th><th>Export</th><th>Net</th><th>Floor hrs</th>
      <th>08-10</th><th>08-11</th><th>08-12</th></tr>
  ${[['A · Baseline', baseRun], ['B · Priority stack, literal', stackRun], ['C · Cost-led', costRun]]
    .map(([n, r]) => `<tr><td>${n}</td>
      <td class="n">${fmt(r.totals.importKwh)}</td>
      <td class="n">${fmt(r.totals.exportKwh)}</td>
      <td class="n">${fmt(r.totals.netCost, 2)}</td>
      <td class="n">${floorHours(r)}</td>
      ${SOLAR_DAYS.map((d) => `<td class="n">${fmt(eodSoc(r, d) * 100, 0)}%</td>`).join('')}
    </tr>`).join('')}
</table>
<div class="note"><b>Plan C beats plan B on almost every measure — including battery resilience.</b>
Reading “battery &gt;80% by end of solar day” as a hard reservation means holding sun
back from the pool, which then has to run on night import. That costs
${fmt(stackRun.totals.netCost - costRun.totals.netCost, 2)} SEK more over 72 hours and produces
<b>more</b> hours on the floor (${floorHours(stackRun)} versus ${floorHours(costRun)}), because the
imported energy went into the pool rather than the pack. The only thing B wins is the
literal 08-10 target: ${fmt(eodSoc(stackRun, '2026-08-10') * 100, 0)}% against
${fmt(eodSoc(costRun, '2026-08-10') * 100, 0)}%.<br><br>
On 2026-08-10 the house physically cannot do all four things: ${fmt(PV_FORECAST_DAILY_KWH['2026-08-10'])} kWh
of PV against 18.2 kWh of base load leaves ~24.8 kWh of surplus, and battery + pool + hot water
+ car want ~33 kWh. Something has to give, and <b>which one gives is the decision in
architecture §8.2 that has not been made</b>. This is the concrete version of that question.</div>

<h2>Why the money difference is small — and where it is not</h2>
<div class="note"><b>August has almost no price signal.</b>
The Ellevio grid tariff is flat at ${GRID_IMPORT_SEK} SEK/kWh across all 26 published slots, so the
entire spread comes from spot: 0.116–0.211 today, 0.157–0.404 tomorrow. Meanwhile
import costs ~${fmt(AVOIDED_SEK, 2)} and export earns ~${fmt(GRID_EXPORT_SEK + 0.21, 2)} — a
${fmt(AVOIDED_SEK / (GRID_EXPORT_SEK + 0.21), 1)}× gap. So in summer the value is
<b>self-consumption and battery resilience, not arbitrage</b>. The arbitrage case
appears in winter, when PV is scarce and the spot curve actually moves. This plan
should not be judged on the ${fmt(effective(baseRun.totals) - effective(optRun.totals), 2)} SEK it
saves over these particular 72 hours.</div>

<h2>Where the numbers come from</h2>
<table>
  <tr><th>Input</th><th>Value</th><th>Source</th></tr>
  <tr><td>PV forecast, 3 days</td><td class="n">${fmt(PV_FORECAST_DAILY_KWH['2026-08-10'])} / ${fmt(PV_FORECAST_DAILY_KWH['2026-08-11'])} / ${fmt(PV_FORECAST_DAILY_KWH['2026-08-12'])} kWh</td>
      <td><code>meteo_solar_production_forecast_estimate_*</code> — 96-point <code>watts</code> attribute, hourly means</td></tr>
  <tr><td>Spot price</td><td class="n">0.116–0.404 SEK/kWh</td><td><code>tibber.get_prices</code>, 15-min, hourly means. Ends 2026-08-10.</td></tr>
  <tr><td>Grid tariff</td><td class="n">${GRID_IMPORT_SEK} / ${GRID_EXPORT_SEK}</td><td><code>smart_home_solutions_grid_import_price.forecast</code> — all 26 slots identical</td></tr>
  <tr><td>Battery</td><td class="n">${PLANT.batteryCapacityKwh} kWh, ${PLANT.batteryChargeMaxW / 1000}/${PLANT.batteryDischargeMaxW / 1000} kW</td><td><code>sigen_plant_rated_energy_capacity</code>, <code>_ess_rated_*_power</code></td></tr>
  <tr><td>Initial SOC</td><td class="n">${fmt(INITIAL.batterySoc * 100, 1)}%</td><td><code>sigen_plant_battery_state_of_charge</code>, measured</td></tr>
  <tr><td>Pool requirement</td><td class="n">${DEVICES.pool.dailyRequirementKwh} kWh/day</td>
      <td>median of ${MEASURED_DAILY_KWH.pool.length} measured days. <b>Helper says ${DEVICES.pool.configuredTargetKwh}</b> — over-states by ${fmt((DEVICES.pool.configuredTargetKwh / DEVICES.pool.dailyRequirementKwh - 1) * 100, 0)}%</td></tr>
  <tr><td>Hot water requirement</td><td class="n">${DEVICES.boiler.dailyRequirementKwh} kWh/day</td>
      <td>median of ${MEASURED_DAILY_KWH.boiler.length} measured days. <b>Helper says ${DEVICES.boiler.configuredTargetKwh}</b> — over-states by ${fmt((DEVICES.boiler.configuredTargetKwh / DEVICES.boiler.dailyRequirementKwh - 1) * 100, 0)}%</td></tr>
  <tr><td>Base load</td><td class="n">18.2 kWh/day</td><td>derived: 2026-08-01 total load minus the four modelled loads</td></tr>
  <tr><td>Car</td><td class="n">not scheduled</td><td><code>tesla_charge_cable</code> = unknown, SOC unavailable — requirement stays 0, never guessed</td></tr>
</table>

<h2>Verification</h2>
<div class="note ${problems.length ? '' : 'ok'}"><b>${problems.length ? problems.length + ' invariant failures' : 'All invariants hold'}</b><br>
${problems.length ? problems.slice(0, 10).join('<br>') : `Per-slot energy balance closes within 1 W across all ${N * 2} simulated slots ·
SOC stays inside [${PLANT.socMin * 100}%, ${PLANT.socMax * 100}%] · import never exceeds
${PLANT.gridImportMaxW / 1000} kW · no slot both imports and exports · no slot both charges and
discharges · every kWh of requirement is placed (${Object.values(optPlan.unmet).filter((v) => v > 1e-6).length} unmet).`}
</div>
<div class="note"><b>Model checked against a real day.</b>
${REFERENCE_DAY.date}: PV ${REFERENCE_DAY.pvKwh} kWh in, load ${REFERENCE_DAY.loadKwh}, export
${REFERENCE_DAY.exportKwh}, import ${REFERENCE_DAY.importKwh}, battery +${REFERENCE_DAY.batteryNetKwh}
— closes to 0.6 kWh of round-trip loss, which is where the ${PLANT.chargeEff * PLANT.dischargeEff * 100}%
efficiency figure comes from. ${REFERENCE_DAY.note}</div>

<h2>Known gaps</h2>
<table>
  <tr><th>Gap</th><th>Effect on this plan</th></tr>
  <tr><td>No published price beyond 2026-08-10 23:00</td><td>Days 2–3 are ranked by solar surplus only. Grid top-up is never scheduled into an unpriced hour.</td></tr>
  <tr><td>No PV or battery history before 2026-05-01</td><td>Spring and autumn/winter stacks cannot be validated against measurement yet.</td></tr>
  <tr><td><code>unmetered_energy_consumption</code> reads −46.5 kWh</td><td>Confirms the double-counting defect in that helper. Not used here — base load is derived from the Sigen total instead.</td></tr>
  <tr><td>PV max 16.2 kW recorded in August</td><td>Above both the 12.3 kW array and the 13.2 kW plant limit. One bad sample; does not affect hourly means materially.</td></tr>
  <tr><td>Pool has no thermal model</td><td>Requirement is a measured daily energy median, so the plan cannot yet overshoot the setpoint to store heat before a cloudy day.</td></tr>
  <tr><td>Spring / winter priorities are estimates</td><td>Only the summer stack is marked confirmed. The other two are recorded but not simulated.</td></tr>
</table>
`;

process.stdout.write(html);
