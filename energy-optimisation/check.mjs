import { buildHorizon, deriveRequirements, planBaseline, planOptimised, simulate, verify } from './model.mjs';
import { INITIAL, PV_FORECAST_DAILY_KWH, PV_FORECAST_W } from './inputs.mjs';

const slots = buildHorizon();
const req = deriveRequirements(slots);

console.log('=== PV shape vs published daily totals ===');
for (const [d, arr] of Object.entries(PV_FORECAST_W)) {
  const sum = arr.reduce((a,b)=>a+b,0)/1000;
  const pub = PV_FORECAST_DAILY_KWH[d];
  console.log(`${d}  shape=${sum.toFixed(2)} kWh  published=${pub.toFixed(2)}  delta=${(sum-pub).toFixed(2)}`);
}

console.log('\n=== Derived requirements ===');
for (const [d,r] of Object.entries(req)) {
  console.log(`${d} slots=${r.slots.length} pool=${r.poolKwh} boiler=${r.boilerKwh.toFixed(2)} car=${r.carKwh}`);
}

const bPlan = planBaseline(slots, req);
const base = simulate(slots, bPlan, { batterySoc: INITIAL.batterySoc });

const oPlan = planOptimised(slots, req, 'summer');
const opt = simulate(slots, oPlan, { batterySoc: INITIAL.batterySoc, batteryTargetBySlot: oPlan.batteryTargetBySlot });

const fmt = (t) => ({
  pv: t.pvKwh.toFixed(1), load: t.loadKwh.toFixed(1),
  imp: t.importKwh.toFixed(1), exp: t.exportKwh.toFixed(1),
  curt: t.curtailedKwh.toFixed(1),
  cost: t.importCost.toFixed(2), rev: t.exportRevenue.toFixed(2),
  net: t.netCost.toFixed(2),
  socEnd: (t.socEnd*100).toFixed(1)+'%',
  unpricedImp: t.unpricedImportKwh.toFixed(1), unpricedExp: t.unpricedExportKwh.toFixed(1),
});
console.log('\n=== BASELINE ==='); console.log(fmt(base.totals));
console.log('\n=== OPTIMISED ==='); console.log(fmt(opt.totals));

console.log('\n=== Unmet requirement (kWh) ===');
console.log(Object.entries(oPlan.unmet).filter(([,v])=>v>1e-6));

console.log('\n=== Verification ===');
for (const [name, r] of [['baseline', base], ['optimised', opt]]) {
  const p = verify(r);
  console.log(`${name}: ${p.length ? p.slice(0,8).join('\n  ') : 'PASS - all invariants hold'}`);
}

// binding-window-only comparison (where prices actually exist)
const bind = (r) => r.slots.filter(s=>s.binding).reduce((a,s)=>({
  imp:a.imp+s.importW/1000, exp:a.exp+s.exportW/1000,
  cost:a.cost+(s.importCost??0), rev:a.rev+(s.exportRevenue??0)}), {imp:0,exp:0,cost:0,rev:0});
const bb=bind(base), bo=bind(opt);
console.log('\n=== Binding window only (to 2026-08-10 23:00) ===');
console.log(`baseline : import ${bb.imp.toFixed(1)} kWh, export ${bb.exp.toFixed(1)} kWh, net ${(bb.cost-bb.rev).toFixed(2)} SEK`);
console.log(`optimised: import ${bo.imp.toFixed(1)} kWh, export ${bo.exp.toFixed(1)} kWh, net ${(bo.cost-bo.rev).toFixed(2)} SEK`);
console.log(`saving   : ${((bb.cost-bb.rev)-(bo.cost-bo.rev)).toFixed(2)} SEK`);

// SOC floor check
const minSocB = Math.min(...base.slots.map(s=>s.soc));
const minSocO = Math.min(...opt.slots.map(s=>s.soc));
console.log(`\nmin SOC  baseline=${(minSocB*100).toFixed(1)}%  optimised=${(minSocO*100).toFixed(1)}%`);

// --- terminal state valuation ---------------------------------------------
import { PLANT, GRID_IMPORT_SEK } from './inputs.mjs';
const AVOIDED = GRID_IMPORT_SEK + 0.21; // typical all-in import in this window
const termVal = (t) => (t.socEnd - t.socStart) * PLANT.batteryCapacityKwh * AVOIDED;
console.log('\n=== With terminal battery state valued at ' + AVOIDED.toFixed(2) + ' SEK/kWh ===');
for (const [n, r] of [['baseline', base], ['optimised', opt]]) {
  const eff = r.totals.netCost - termVal(r.totals);
  console.log(`${n}: net ${r.totals.netCost.toFixed(2)} - stored ${termVal(r.totals).toFixed(2)} = ${eff.toFixed(2)} SEK effective`);
}
const effB = base.totals.netCost - termVal(base.totals);
const effO = opt.totals.netCost - termVal(opt.totals);
console.log(`saving: ${(effB - effO).toFixed(2)} SEK over 72 h`);

// --- where does each plan run the pool? ------------------------------------
const runs = (plan, key) => plan[key].map((f,i)=>f>0.01?`${slots[i].label}(${(f*100).toFixed(0)}%)`:null).filter(Boolean);
console.log('\nBASELINE pool :', runs(bPlan,'pool').join(' '));
console.log('OPTIMISED pool:', runs(oPlan,'pool').join(' '));
console.log('\nBASELINE boiler :', runs(bPlan,'boiler').join(' '));
console.log('OPTIMISED boiler:', runs(oPlan,'boiler').join(' '));
