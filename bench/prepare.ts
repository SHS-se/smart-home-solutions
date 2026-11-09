import { canonicalJson, caseTargets, hasMeasuredOutcome, type BenchRecorded, type BenchScenarioData } from "../src/lib/planner-bench/case.ts";
import { caseFromReplay, REPLAY_FORMAT } from "../src/lib/planner-bench/convert-replay.ts";
import { HOUSEHOLD, caseHousehold } from "../src/lib/planner-bench/household.ts";
import { completeCase, recordedDemandDays, recordedWind, type HistorySource } from "./history.ts";
import { homeComfortTargets } from "./comfort.ts";
import { homeImportLimitW } from "./grid-limit.ts";
import type { BenchStore, StoredScenario } from "./store.ts";

export interface CasePreparation {
  source: HistorySource | null;
  targets: BenchScenarioData["comfort"] | null;
  importLimitW: number | null;
}

export async function historySource(url: string, key: string, homeId?: string): Promise<HistorySource> {
  if (!homeId) {
    const response = await fetch(`${url}/rest/v1/energy_optimisation_outdoor_slots?select=home_id&order=start_ts.desc&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`Could not identify the bench home: ${response.status} ${await response.text()}`);
    homeId = (await response.json())[0]?.home_id;
  }
  if (!homeId) throw new Error('No bench home found. Set BENCH_HOME_ID to the home whose history and comfort preferences the bench should use.');
  return { url, key, homeId };
}

export async function preparation(source: HistorySource | null): Promise<CasePreparation> {
  if (!source) return { source, targets: null, importLimitW: null };
  const [targets, importLimitW] = await Promise.all([homeComfortTargets(source), homeImportLimitW(source)]);
  return { source, targets, importLimitW };
}

export interface PreparedCaseUpdate {
  dataset?: BenchScenarioData;
  recorded?: { value: BenchRecorded | null; pendingReason: string | null };
}

export async function prepareCase(bench: Pick<BenchStore, "legacyReplayInput">, scenario: StoredScenario,
  { source, targets, importLimitW }: CasePreparation, rerecord: boolean): Promise<PreparedCaseUpdate> {
  const update: PreparedCaseUpdate = {};
  let dataset = scenario.dataset;
  let recorded = scenario.recorded;
  if (!dataset) {
    const input = await bench.legacyReplayInput(scenario.id);
    if (!input) return update;
    dataset = caseFromReplay({ format: REPLAY_FORMAT, entrypoint: { arguments: input } }, scenario.name).data;
    update.dataset = dataset;
  }
  if (targets && (canonicalJson(dataset.comfort) !== canonicalJson(targets) || dataset.grid_import_limit_w !== importLimitW)) {
    dataset = { ...dataset, comfort: targets, grid_import_limit_w: importLimitW };
    update.dataset = dataset;
  }
  caseTargets(dataset);
  caseHousehold(dataset);
  if (recorded && (!hasMeasuredOutcome(recorded)
    || (rerecord && dataset.origin?.kind !== "history"))) {
    recorded = null;
    update.recorded = { value: null, pendingReason: "awaiting complete measured outcome" };
  }
  if (recorded && source && !recorded.wind) {
    // Wind was not kept when this case was recorded; it is added once it has been observed.
    const wind = await recordedWind(source, HOUSEHOLD.site.market_area, dataset.start);
    if (wind) {
      recorded = { ...recorded, wind };
      update.recorded = { value: recorded, pendingReason: null };
    }
  }
  if (recorded && source && !recorded.history.demand_days) {
    const demand = await recordedDemandDays(source, dataset.timezone, dataset.start);
    if (demand) {
      recorded = { ...recorded, history: { ...recorded.history, demand_days: demand } };
      update.recorded = { value: recorded, pendingReason: null };
    }
  }
  if (recorded || !source) return update;
  const done = await completeCase(source, dataset);
  if (dataset.start_state_unread?.length && Object.keys(done.startState).length) {
    // Readings the replay lacked come from recorded history, once.
    const { ev_soc, ...read } = done.startState;
    const remaining = dataset.start_state_unread.filter(field => !(field in done.startState));
    const { start_state_unread: _unread, ...rest } = dataset;
    dataset = { ...rest, ...(remaining.length ? { start_state_unread: remaining } : {}), start_state: { ...dataset.start_state, ...read, ev: { ...dataset.start_state.ev, ...(ev_soc !== undefined ? { soc: ev_soc } : {}) } } };
    update.dataset = dataset;
  }
  if (dataset.start_state_unread?.length) {
    done.recorded = null;
    done.missing = `${done.missing ? done.missing + "; " : ""}missing measured start state: ${dataset.start_state_unread.join(", ")}`;
  }
  if (done.recorded) {
    const wind = await recordedWind(source, HOUSEHOLD.site.market_area, dataset.start);
    if (wind) done.recorded.wind = wind;
    const demand = await recordedDemandDays(source, dataset.timezone, dataset.start);
    if (demand) done.recorded.history.demand_days = demand;
  }
  update.recorded = { value: done.recorded, pendingReason: done.missing };
  return update;
}
