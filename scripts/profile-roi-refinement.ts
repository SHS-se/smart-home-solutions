import { fileURLToPath } from 'node:url';
import { roiBenchmarkInput, type RoiScenario } from './roi-benchmark-scenarios.ts';
import { replayScheduler } from '../src/lib/home-baseline/scheduler-replay.ts';
import { createWasmPlanner } from '../supabase/functions/_shared/planner-wasm/core.ts';

// Timers exist only in a temporary native source copy. Production Wasm is untouched.
// --revision REF archives a committed baseline; explicitly name its score function.
const option = (name: string, initial: string) => {
  const i = Deno.args.indexOf(name);
  if (i < 0) return initial;
  const value = Deno.args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
};
const scenario = option('--scenario', 'flat') as RoiScenario;
if (!['flat', 'solar-prices', 'solar-prices-trips'].includes(scenario)) throw new Error('Choose a documented ROI scenario');
const revision = option('--revision', ''), scoreFunction = option('--score-function', 'score_projection');
if (!/^\w+$/.test(scoreFunction)) throw new Error('Choose a Rust score function name');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await Deno.makeTempDir({ prefix: 'roi-refinement-' });
const native = `${temporary}/planner-core`;
const target = `${root}/planner-core/target/roi-profile`;

async function copyTree(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.name === 'target') continue;
    if (entry.isDirectory) await copyTree(`${from}/${entry.name}`, `${to}/${entry.name}`);
    else if (entry.isFile) await Deno.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}
async function spans(file: string, fn: string, label: string) {
  const path = `${native}/solver/src/${file}.rs`;
  let source = await Deno.readTextFile(path);
  const matches = [...source.matchAll(new RegExp(`\\bfn\\s+${fn}\\s*(?:<[^>]*>)?\\s*\\(`, 'g'))];
  if (!matches.length) throw new Error(`Profile anchor missing: ${file}::${fn}`);
  for (const match of matches.reverse()) {
    const at = source.indexOf('{', match.index) + 1;
    source = `${source.slice(0, at)}\nlet _profile_scope=crate::profile::span("${label}");\n${source.slice(at)}`;
  }
  await Deno.writeTextFile(path, source);
}
async function replaceOnce(path: string, from: string, to: string) {
  const source = await Deno.readTextFile(path);
  if (source.split(from).length !== 2) throw new Error(`Profile anchor changed: ${from}`);
  await Deno.writeTextFile(path, source.replace(from, to));
}
try {
  if (revision) {
    const archive = await new Deno.Command('git', { cwd: root, args: ['archive', revision, 'planner-core'], stdout: 'piped', stderr: 'inherit' }).output();
    if (!archive.success) throw new Error('Could not archive the requested baseline');
    const tar = `${temporary}/source.tar`; await Deno.writeFile(tar, archive.stdout);
    const extracted = await new Deno.Command('tar', { args: ['-xf', tar, '-C', temporary] }).spawn().status;
    if (!extracted.success) throw new Error('Could not extract the baseline');
  } else await copyTree(`${root}/planner-core`, native);
  await Deno.writeTextFile(`${native}/solver/src/profile.rs`, `
use std::{cell::RefCell, collections::BTreeMap, time::Instant};
thread_local! {static DATA: RefCell<BTreeMap<&'static str,(u64,u128)>>=RefCell::new(BTreeMap::new());}
pub struct Span(&'static str,Instant);
pub fn span(key: &'static str)->Span {Span(key,Instant::now())}
impl Drop for Span {fn drop(&mut self) {let ns=self.1.elapsed().as_nanos();DATA.with(|d| {let mut d=d.borrow_mut();let e=d.entry(self.0).or_default();e.0+=1;e.1+=ns;});}}
pub fn count(key: &'static str,n:u64) {DATA.with(|d| d.borrow_mut().entry(key).or_default().0+=n);}
pub struct Counter {key:&'static str,pub count:u64}
pub fn counter(key:&'static str)->Counter {Counter{key,count:0}}
impl Drop for Counter {fn drop(&mut self) {count(self.key,self.count);}}
pub fn report()->serde_json::Value {DATA.with(|d| serde_json::to_value(&*d.borrow()).unwrap())}
`);
  await replaceOnce(`${native}/solver/src/lib.rs`, 'mod battery_schedule;', 'pub mod profile;\nmod battery_schedule;');
  for (const [file, fn, label] of [
    ['builder', scoreFunction, 'score'], ['builder', 'adopt', 'adopt'], ['builder', 'carry', 'carry_edits'],
    ['builder', 'improve', 'refinement'], ['builder', 'construct', 'construction'], ['battery_schedule', 'allocate', 'battery_allocate'],
    ['battery_schedule', 'respond', 'battery_response'], ['move_resize', 'proposals', 'generate_edits'], ['move_resize', 'apply', 'apply_edits'],
    ['witnesses', 'audit', 'audit'], ['policy', 'totals', 'accounting'], ['policy', 'index', 'index'],
    ['opportunity', 'prepare', 'opportunity'], ['physics', 'project_metered_prefix', 'projection'],
  ]) await spans(file, fn, label);
  const physics = `${native}/solver/src/physics.rs`;
  await replaceOnce(physics, '.map(|(heater, store)| {', '.map(|(heater, store)| {\nlet _pool_scope=crate::profile::span("pool_projection");');
  await replaceOnce(physics, 'let mut state = prefix.last().map_or_else(', 'crate::profile::count("prefix_quarters",prefix.len() as u64);\nlet mut _quarters_counter=crate::profile::counter("projected_quarters");\nlet mut state = prefix.last().map_or_else(');
  await replaceOnce(physics, 'for (i, c) in commands.iter().enumerate().skip(prefix.len()) {', 'for (i, c) in commands.iter().enumerate().skip(prefix.len()) {\n_quarters_counter.count+=1;');
  if (!revision) {
    const memo = `${native}/solver/src/physics/pool_memo.rs`;
    await replaceOnce(memo, 'let key = Key::new(', 'crate::profile::count("thermal_queries",1);\nlet key = Key::new(');
    await replaceOnce(memo, 'if entry.key == key {', 'if entry.key == key {\ncrate::profile::count("thermal_hits",1);');
  }
  await Deno.writeTextFile(`${native}/solver/src/main.rs`, `use std::io::{self,Read};
fn main() {let mut input=Vec::new();io::stdin().read_to_end(&mut input).unwrap();let began=std::time::Instant::now();let result=shs_planner_core::solve_json(&input);let total_ms=began.elapsed().as_secs_f64()*1000.0;let outcome:serde_json::Value=serde_json::from_slice(&result).unwrap();println!("{}",serde_json::json!({"total_ms":total_ms,"scopes":shs_planner_core::profile::report(),"outcome":outcome,"outcome_json":String::from_utf8(result).unwrap()}));}`);
  const build = await new Deno.Command('cargo', { cwd: root, env: { CARGO_TARGET_DIR: target },
    args: ['build', '--manifest-path', `${native}/Cargo.toml`, '--locked', '--release', '--bin', 'shs-planner-core'], stdout: 'inherit', stderr: 'inherit' }).spawn().status;
  if (!build.success) throw new Error('Native profiling build failed');
  const engine = createWasmPlanner(Deno.readFileSync(new URL('../supabase/functions/_shared/planner-wasm/solver.wasm', import.meta.url)));
  const captured = new Error('Problem captured'); let problem: Parameters<typeof engine.solve>[0] | null = null;
  try { replayScheduler(roiBenchmarkInput(scenario), { project: engine.project, solve(p) { problem = p; throw captured; } }); }
  catch (error) { if (error !== captured) throw error; }
  if (!problem) throw new Error('No scheduler problem captured');
  const child = new Deno.Command(`${target}/release/shs-planner-core`, { stdin: 'piped', stdout: 'piped', stderr: 'inherit' }).spawn();
  const writer = child.stdin.getWriter(); await writer.write(new TextEncoder().encode(JSON.stringify(problem))); await writer.close();
  const result = await child.output();
  if (!result.success) throw new Error('Native profiling solve failed');
  const report = JSON.parse(new TextDecoder().decode(result.stdout));
  if (report.outcome.kind !== 'selected') throw new Error(`Native profile failed: ${report.outcome.issue}`);
  const outcomeDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(report.outcome_json));
  const outcomeChecksum = Array.from(new Uint8Array(outcomeDigest), n => n.toString(16).padStart(2, '0')).join('');
  const selection = report.outcome.selection;
  delete report.outcome;
  delete report.outcome_json;
  console.log(JSON.stringify({ scenario, revision: revision || 'workspace', ...report, outcomeChecksum,
    work: selection?.work, termination: selection?.termination }));
} finally { await Deno.remove(temporary, { recursive: true }); }
