// Planner bench: every planner version replayed on the same test cases,
// scored, and compared against the planner currently deployed
// (docs/planner-bench/README.md). Staff only. The bench tables exist only in
// the TEST Supabase project, so elsewhere the page points to the test site.

import React, { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Loader2, Play, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { FALLBACK_HOME_TIME_ZONE, formatHomeDayMonthTime, formatHomeStamp } from '@/lib/energy-shift/home-time';
import { caseFromReplay, type ConvertedReplay } from '@/lib/planner-bench/convert-replay';
import type { CaseStartState } from '@/lib/planner-bench/case';
import { BASE_LANE, LANES, diagnose, type Diagnosis, type LaneId, type LaneResult } from '@/lib/planner-bench/lanes';
import { suiteStats, type SuiteStats } from '@/lib/planner-bench/stats';
import { benchDays, periodRange, type BenchPeriod } from '@/lib/planner-bench/days';
import {
  isStale, resolveRules, runScore, scoreQuarters, storedPassed, criteriaErrors,
} from '@/lib/planner-bench/score';
import type {
  BenchResultDetail, BenchResultSummary, BenchRun, BenchScenario, CriteriaOverrides,
} from '@/lib/planner-bench/types';
import BenchPlanChart from '@/components/portal/planner-bench/BenchPlanChart';
import BenchComparePanel from '@/components/portal/planner-bench/BenchComparePanel';
import BenchCurvesPanel from '@/components/portal/planner-bench/BenchCurvesPanel';
import BenchStartState from '@/components/portal/planner-bench/BenchStartState';
import BenchRuleList from '@/components/portal/planner-bench/BenchRuleList';
import PriceEstimateAccuracy from '@/components/portal/planner-bench/PriceEstimateAccuracy';

// The generated Database types describe the migrated schema; the bench tables
// live only in the test project, outside it.
const db = supabase as unknown as SupabaseClient;
const TEST_SITE = 'https://test.smarthomesolutions.se/portal/planner-bench';
const TZ = FALLBACK_HOME_TIME_ZONE;

async function rows<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as T;
}

const key = (sha: string, scenario: string) => `${sha}/${scenario}`;

interface CaseSummary { points: number; passed: boolean }

/** PostgREST's answer when a table is not in the schema: this is not the test project. */
const isMissingTable = (error: unknown) => /PGRST205|bench_\w+.*(does not exist|schema cache)/i.test(String((error as Error)?.message ?? error));

const PlannerBench: React.FC = () => <Bench />;

const Bench: React.FC = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const runs = useQuery({
    queryKey: ['bench', 'runs'],
    queryFn: () => rows<BenchRun[]>(db.from('bench_runs').select('*').order('committed_at')),
    refetchInterval: 30_000,
  });
  const scenarios = useQuery({
    queryKey: ['bench', 'scenarios'],
    queryFn: () => rows<BenchScenario[]>(db.from('bench_scenarios')
      .select('id, name, captured_at, source_filename, notes, archived, created_at, pending_reason, dataset, recorded_at:recorded->>recorded_at')
      .eq('archived', false).order('captured_at')),
  });
  const summaries = useQuery({
    queryKey: ['bench', 'summaries'],
    queryFn: () => rows<BenchResultSummary[]>(db.from('bench_result_summaries').select('*')),
    refetchInterval: 30_000,
  });

  // One set of rules scores every case and every planner; otherwise their points could not be compared.
  const rules = useQuery({
    queryKey: ['bench', 'rules'],
    queryFn: async (): Promise<CriteriaOverrides> => {
      const { data, error } = await db.from('bench_rules').select('criteria').maybeSingle();
      // Before the bench workflow has created the table, the defaults apply.
      if (error) { if (isMissingTable(error)) return {}; throw new Error(error.message); }
      return data?.criteria ?? {};
    },
  });
  const savedRules = useMemo(() => rules.data ?? {}, [rules.data]);
  /** Rule changes being tried on the page, not yet saved. */
  const [rulesDraft, setRulesDraft] = useState<CriteriaOverrides | null>(null);

  const allRuns = useMemo(() => runs.data ?? [], [runs.data]);
  const cases = useMemo(() => scenarios.data ?? [], [scenarios.data]);
  const currentRun = allRuns.find(run => run.is_current) ?? null;
  const [testSha, setTestSha] = useState<string | null>(null);
  const testRun = allRuns.find(run => run.sha === testSha) ?? allRuns[allRuns.length - 1] ?? null;
  const [caseId, setCaseId] = useState<string | null>(null);
  const selectedCase = cases.find(c => c.id === caseId) ?? cases[0] ?? null;
  const [shown, setShown] = useState<'current' | 'test'>('test');

  // Lists and totals show the base lane: the planner as it runs live. The other lanes explain it.
  const baseSummaries = useMemo(() => (summaries.data ?? []).filter(s => (s.lane ?? BASE_LANE) === BASE_LANE), [summaries.data]);
  const summaryByKey = useMemo(() => new Map(baseSummaries.map(s => [key(s.sha, s.scenario_id), s])), [baseSummaries]);
  /** What each lane of a run came to for the selected case. */
  const lanesFor = useMemo(() => (sha: string | undefined, scenarioId: string | undefined) => {
    const out: Partial<Record<LaneId, LaneResult>> = {};
    for (const s of summaries.data ?? []) {
      if (s.sha !== sha || s.scenario_id !== scenarioId || s.status !== 'ok' || !s.outcome || !s.score
        || isStale(s.score, savedRules)) continue;
      out[s.lane ?? BASE_LANE] = { cost_sek: s.outcome.cost_sek, credit_sek: s.outcome.terminal.credit_sek, points: s.score.points };
    }
    return out;
  }, [summaries.data, savedRules]);
  const [lane, setLane] = useState<LaneId>(BASE_LANE);

  /** Every case's stored score for one run; null where the run has no scored result. */
  const scoresFor = useMemo(() => (sha: string) => new Map(cases.map(c => {
    const summary = summaryByKey.get(key(sha, c.id));
    const score = summary?.status === 'ok' && !isStale(summary.score, savedRules) ? summary.score : null;
    return [c.id, score ? { points: score.points, passed: storedPassed(score, null) } : null] as const;
  })), [cases, summaryByKey, savedRules]);

  const runScores = useMemo(() => new Map(allRuns.map(run => {
    const points = [...scoresFor(run.sha).values()].filter((s): s is CaseSummary => s !== null).map(s => s.points);
    return [run.sha, runScore(points)] as const;
  })), [allRuns, scoresFor]);

  /** Results scored by an older scorer, or before the rules last changed. */
  const staleCount = useMemo(() => {
    const known = new Set(cases.map(c => c.id));
    return baseSummaries.filter(s => s.status === 'ok' && known.has(s.scenario_id) && isStale(s.score, savedRules)).length;
  }, [cases, baseSummaries, savedRules]);

  const currentScores = currentRun ? scoresFor(currentRun.sha) : null;
  const testScores = testRun ? scoresFor(testRun.sha) : null;

  /** Totals over the cases both runs have results for, so the columns compare like with like. */
  const totals = useMemo(() => {
    if (!currentRun || !testRun) return null;
    const both = cases.filter(c => summaryByKey.get(key(currentRun.sha, c.id))?.stats && summaryByKey.get(key(testRun.sha, c.id))?.stats);
    const stats = (sha: string) => suiteStats(both.map(c => summaryByKey.get(key(sha, c.id))!.stats!));
    return { cases: both.length, current: stats(currentRun.sha), test: stats(testRun.sha) };
  }, [cases, currentRun, testRun, summaryByKey]);

  const series = useQuery({
    queryKey: ['bench', 'series', selectedCase?.id, currentRun?.sha, testRun?.sha, lane],
    enabled: Boolean(selectedCase && (currentRun || testRun)),
    queryFn: async () => {
      const shas = [currentRun?.sha, testRun?.sha].filter((s): s is string => Boolean(s));
      const data = await rows<({ sha: string } & BenchResultDetail)[]>(db.from('bench_results')
        .select('sha, series, record, outcome').eq('scenario_id', selectedCase!.id).eq('lane', lane).in('sha', shas));
      const by = new Map(data.map(r => [r.sha, r]));
      return { current: currentRun ? by.get(currentRun.sha) ?? null : null, test: testRun ? by.get(testRun.sha) ?? null : null };
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['bench'] });

  const dispatch = useMutation({
    mutationFn: async (body: { shas: string; scenario?: string; force?: boolean }) => {
      const { data, error } = await supabase.functions.invoke('planner-bench-dispatch', { body });
      if (error) {
        const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
        throw new Error(detail?.message ?? detail?.error ?? error.message);
      }
      return data as { runs_url: string };
    },
    onSuccess: data => toast({
      title: t('Körning startad', 'Bench run started'),
      description: t('Resultaten dyker upp här när GitHub Actions är klar.', `Results appear here when GitHub Actions finishes: ${data.runs_url}`),
    }),
    onError: (error: Error) => toast({
      title: t('Kunde inte starta körningen', 'Could not start the bench run'),
      description: `${error.message}. ${t('Starta "Planner bench" manuellt i GitHub Actions.', 'Start the "Planner bench" workflow in GitHub Actions instead.')}`,
      variant: 'destructive',
    }),
  });

  const [pending, setPending] = useState<(ConvertedReplay & { filename: string; name: string }) | null>(null);
  const addCase = useMutation({
    mutationFn: async () => {
      const inserted = await rows<{ id: string }>(db.from('bench_scenarios').insert({
        name: pending!.name.trim() || pending!.suggestedName,
        captured_at: pending!.data.start,
        source_filename: pending!.filename,
        dataset: pending!.data,
      }).select('id').single());
      return inserted.id;
    },
    onSuccess: id => {
      setPending(null);
      setCaseId(id);
      refresh();
      dispatch.mutate({ shas: 'all', scenario: id });
    },
    onError: (error: Error) => toast({ title: t('Kunde inte spara testfallet', 'Could not save the test case'), description: error.message, variant: 'destructive' }),
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const converted = caseFromReplay(JSON.parse(await file.text()), file.name);
      setPending({ ...converted, filename: file.name, name: converted.suggestedName });
    } catch (error) {
      toast({ title: t('Filen kunde inte läsas', 'That file could not be read'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const saveStartState = useMutation({
    mutationFn: async (start_state: CaseStartState) => {
      const { start_state_unread: _unread, ...dataset } = selectedCase!.dataset!;
      await rows(db.from('bench_scenarios').update({ dataset: { ...dataset, start_state } }).eq('id', selectedCase!.id));
    },
    onSuccess: () => {
      refresh();
      dispatch.mutate({ shas: 'all', scenario: selectedCase!.id });
    },
    onError: (error: Error) => toast({ title: t('Kunde inte spara starttillståndet', 'Could not save the start state'), description: error.message, variant: 'destructive' }),
  });

  const saveRules = useMutation({
    mutationFn: async (criteria: CriteriaOverrides) => {
      await rows(db.from('bench_rules').upsert({ id: true, criteria, updated_at: new Date().toISOString() }));
      return criteria;
    },
    onSuccess: criteria => {
      queryClient.setQueryData(['bench', 'rules'], criteria);
      setRulesDraft(null);
      refresh();
      toast({ title: t('Reglerna sparade', 'Rules saved'), description: t('Gäller alla testfall och alla planerare.', 'They apply to every test case and every planner.') });
      // Every stored score is now stale; recompute them without re-running planners.
      dispatch.mutate({ shas: 'none' });
    },
    onError: (error: Error) => toast({ title: t('Kunde inte spara reglerna', 'Could not save the rules'), description: error.message, variant: 'destructive' }),
  });

  const makeCurrent = useMutation({
    mutationFn: async (sha: string) => { await rows(db.rpc('bench_set_current', { p_sha: sha })); },
    onSuccess: refresh,
    onError: (error: Error) => toast({ title: t('Kunde inte ändra', 'Could not change the current planner'), description: error.message, variant: 'destructive' }),
  });

  const loading = runs.isLoading || scenarios.isLoading || summaries.isLoading;
  const loadError = runs.error ?? scenarios.error ?? summaries.error;
  const runLabel = (run: BenchRun) => {
    const score = runScores.get(run.sha);
    const status = run.status === 'running' ? ` · ${t('kör', 'running')}` : run.status === 'failed' ? ` · ${t('misslyckades', 'failed')}` : '';
    return `${run.short_sha} · ${formatHomeStamp(run.committed_at, TZ)} · ${score ?? '—'} ${t('p', 'pts')}${run.is_current ? ` · ${t('nuvarande', 'current')}` : ''}${status}`;
  };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1400px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t('Planerarbänk', 'Planner bench')}</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            {t('Varje planerarversion körs på samma testfall och jämförs med den planerare som körs nu.',
              'Every planner version replays the same test cases and is compared with the planner running now.')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={fileInput} id="bench-replay-file" type="file" accept="application/json,.json" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          <Button variant="outline" onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4 mr-2" />{t('Lägg till testfall', 'Add test case')}</Button>
          <Button variant="outline" disabled={dispatch.isPending} onClick={() => dispatch.mutate({ shas: 'all' })}>
            {dispatch.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            {t('Kör saknade', 'Run missing results')}
          </Button>
        </div>
      </div>

      <PriceEstimateAccuracy />

      {loadError && (isMissingTable(loadError)
        ? <Alert><AlertDescription>
            {t('Bänken finns bara på testsajten, eftersom testfallen ligger i testdatabasen.',
              'The bench runs on the test site only, because its test cases live in the test database.')}{' '}
            <a className="underline" href={TEST_SITE}>{TEST_SITE}</a>
          </AlertDescription></Alert>
        : <Alert variant="destructive"><AlertDescription>{(loadError as Error).message}</AlertDescription></Alert>)}
      {loading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar…', 'Loading…')}</div>}

      {!loading && !loadError && staleCount > 0 && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t(`${staleCount} resultat har poäng från en äldre poängsättning. Dessa poäng döljs tills de räknats om.`,
              `${staleCount} result${staleCount === 1 ? ' has' : 's have'} scores from an older scorer. These scores are excluded until they are recomputed.`)}</span>
            <Button size="sm" variant="outline" disabled={dispatch.isPending} onClick={() => dispatch.mutate({ shas: 'none' })}>
              {t('Räkna om poäng', 'Recompute scores')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !loadError && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('Testfall', 'Test case')}>
            {cases.map(c => {
              const currentScore = currentScores?.get(c.id);
              const testScore = testScores?.get(c.id);
              const dot = testScore == null ? 'bg-muted-foreground/40' : testScore.passed ? 'bg-emerald-500' : 'bg-red-500';
              const active = c.id === selectedCase?.id;
              return (
                <button key={c.id} id={`bench-case-${c.id}`} onClick={() => setCaseId(c.id)} aria-pressed={active}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${active ? 'bg-foreground text-background border-foreground' : 'bg-muted/40 hover:bg-muted'}`}>
                  <span className={`h-2 w-2 rounded-full ${dot}`} />
                  <span className="font-mono text-xs">{c.name}</span>
                  <span>{formatHomeDayMonthTime(c.captured_at, TZ)}</span>
                  {!c.recorded_at && <span className="text-xs opacity-70" title={c.pending_reason ?? undefined}>{t('väntar', 'waiting')}</span>}
                  {currentScore && <span className="font-mono text-xs opacity-70">{t('N', 'C')} {signed(currentScore.points)}</span>}
                  {testScore && <span className="font-mono text-xs opacity-70">T {signed(testScore.points)}</span>}
                </button>
              );
            })}
          </div>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5 min-w-0">
                  <div className="text-xs text-muted-foreground">{t('Nuvarande planerare (körs på testmiljön)', 'Current planner (running on the test environment)')}</div>
                  <div className="font-mono text-sm rounded-md border px-3 py-2 truncate">{currentRun ? runLabel(currentRun) : t('Ingen markerad ännu', 'None marked yet')}</div>
                </div>
                <div className="space-y-1.5 min-w-0">
                  <label htmlFor="bench-test-run" className="text-xs text-muted-foreground">{t('Testplanerare', 'Test planner')}</label>
                  <div className="flex gap-2">
                    <Select value={testRun?.sha ?? ''} onValueChange={setTestSha}>
                      <SelectTrigger id="bench-test-run" className="font-mono text-sm"><SelectValue placeholder={t('Inga körningar ännu', 'No runs yet')} /></SelectTrigger>
                      <SelectContent className="max-h-80">
                        {allRuns.map(run => <SelectItem key={run.sha} value={run.sha} className="font-mono text-sm">{runLabel(run)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {testRun && !testRun.is_current && (
                      <Button variant="ghost" size="sm" disabled={makeCurrent.isPending} onClick={() => makeCurrent.mutate(testRun.sha)}>
                        {t('Gör nuvarande', 'Make current')}
                      </Button>
                    )}
                  </div>
                  {testRun && <div className="text-xs text-muted-foreground truncate">{testRun.subject}</div>}
                </div>
              </div>
              {totals && <SuiteTable totals={totals} scores={{ current: currentRun ? runScores.get(currentRun.sha) ?? null : null, test: testRun ? runScores.get(testRun.sha) ?? null : null }} />}
              {!cases.length && <p className="text-sm text-muted-foreground">{t('Inga testfall ännu. Lägg till en replay-fil.', 'No test cases yet. Add a replay file to start.')}</p>}
            </CardContent>
          </Card>

          {selectedCase && (
            <CaseView
              key={selectedCase.id}
              scenario={selectedCase}
              currentRun={currentRun}
              testRun={testRun}
              summaryByKey={summaryByKey}
              details={series.data ?? null}
              lane={lane}
              onLane={setLane}
              lanes={{ current: lanesFor(currentRun?.sha, selectedCase.id), test: lanesFor(testRun?.sha, selectedCase.id) }}
              seriesLoading={series.isLoading}
              savingStartState={saveStartState.isPending}
              onSaveStartState={state => saveStartState.mutate(state)}
              shown={shown}
              onShown={setShown}
              draft={rulesDraft ?? savedRules}
              unsaved={rulesDraft !== null}
              onDraft={setRulesDraft}
              onSaveRules={() => saveRules.mutate(rulesDraft ?? savedRules)}
              onRerun={() => dispatch.mutate({ shas: 'all', scenario: selectedCase.id, force: true })}
            />
          )}
        </>
      )}

      <Dialog open={pending !== null} onOpenChange={open => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Nytt testfall', 'New test case')}</DialogTitle>
            <DialogDescription>
              {pending && t(
                `72 timmar från ${formatHomeStamp(pending.data.start, TZ)}. Filen görs om till ett testfall: priser, sol- och förbrukningsprognos och starttillstånd. Det körs när fönstrets verkliga priser och temperaturer har spelats in.`,
                `72 hours from ${formatHomeStamp(pending.data.start, TZ)}. The file becomes a test case: prices, solar and load forecasts and start states. It runs once the window's real prices and temperatures are recorded.`)}
            </DialogDescription>
          </DialogHeader>
          <label htmlFor="bench-case-name" className="text-sm">{t('Namn', 'Name')}</label>
          <Input id="bench-case-name" value={pending?.name ?? ''} onChange={e => setPending(p => p && { ...p, name: e.target.value })} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>{t('Avbryt', 'Cancel')}</Button>
            <Button disabled={addCase.isPending} onClick={() => addCase.mutate()}>
              {addCase.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{t('Spara och kör alla planerare', 'Save and run every planner')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};


/** Which way a metric should move; null when neither way is better by itself. */
type Better = 'higher' | 'lower' | null;
type Tone = 'better' | 'worse' | 'same' | 'neutral';

/** Changes smaller than this share of the current value are noise. */
const SAME_SHARE = 0.005;

const toneOf = (a: number | null, b: number | null, better: Better): Tone => {
  if (a === null || b === null) return 'neutral';
  const d = b - a;
  if (Math.abs(d) <= Math.abs(a) * SAME_SHARE || Math.abs(d) < 1e-9) return 'same';
  if (!better) return 'neutral';
  return (d > 0) === (better === 'higher') ? 'better' : 'worse';
};

const TONE_CLASS: Record<Tone, string> = {
  better: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  worse: 'bg-red-500/15 text-red-700 dark:text-red-400',
  same: 'text-muted-foreground',
  neutral: 'bg-muted text-muted-foreground',
};

const delta = (a: number | null, b: number | null, digits: number) => {
  if (a === null || b === null) return '';
  const d = b - a;
  return signed(d, Math.abs(d) < 1 && digits < 2 ? 2 : digits);
};

interface SuiteLine { key: keyof SuiteStats; label: string; unit: string; digits: number; a: number | null; b: number | null; better: Better }

const SuiteTable: React.FC<{ totals: { cases: number; current: SuiteStats; test: SuiteStats }; scores: { current: number | null; test: number | null } }> = ({ totals, scores }) => {
  const { t } = useLanguage();
  const { current: c, test: x } = totals;
  const line = (label: string, unit: string, digits: number, key: keyof SuiteStats, better: Better): SuiteLine =>
    ({ key, label, unit, digits, a: c[key] as number | null, b: x[key] as number | null, better });
  const groups: [string, SuiteLine[]][] = [
    [t('Kostnad', 'Cost'), [
      line(t('Nätkostnad, 72 h', 'Grid cost, 72 h'), 'kr', 1, 'grid_cost_sek', 'lower'),
      line(t('Snittkostnad per kWh', 'Average cost per kWh'), 'kr', 2, 'cost_per_kwh', 'lower'),
      line(t('Snittpris export per kWh', 'Average export price per kWh'), 'kr', 2, 'export_price', 'higher'),
    ]],
    [t('Sol', 'Solar'), [
      line(t('Solel använd', 'Solar used'), 'kWh', 1, 'solar_used_kwh', 'higher'),
      line(t('Solel exporterad', 'Solar exported'), 'kWh', 1, 'solar_exported_kwh', null),
    ]],
    [t('Energi', 'Energy'), [
      line(t('Total förbrukning, 72 h', 'Total used, 72 h'), 'kWh', 1, 'kwh_used', null),
      line(t('Hembatteri laddat', 'Home battery charged'), 'kWh', 1, 'battery_charge_kwh', null),
      line(t('Elbil laddad', 'EV charged'), 'kWh', 1, 'ev_kwh', null),
    ]],
    [t('Pool', 'Pool'), [
      line(t('Poolvärme', 'Pool heating'), 'h', 1, 'pool_heating_hours', null),
      line(t('Pool lägsta', 'Pool lowest'), '°C', 2, 'pool_min_c', null),
      line(t('Pool högsta', 'Pool highest'), '°C', 2, 'pool_max_c', null),
    ]],
  ];
  const all = groups.flatMap(([, lines]) => lines);
  const count = (tone: Tone) => all.filter(l => toneOf(l.a, l.b, l.better) === tone).length;
  const scoreTone = toneOf(scores.current, scores.test, 'higher');
  const scoreDelta = scores.current !== null && scores.test !== null ? scores.test - scores.current : null;
  const fmt = (v: number | null, digits: number) => v === null ? '—' : v.toFixed(digits);

  return (
    <div className="space-y-3">
      <div id="bench-total-score" className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg px-4 py-3 ${TONE_CLASS[scoreTone === 'same' ? 'neutral' : scoreTone]}`}>
        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-wide opacity-80">{t('Poäng', 'Score')}</span>
          <span id="bench-score-current" className="font-mono tabular-nums text-foreground">{scores.current ?? '—'}</span>
          <span className="opacity-60">→</span>
          <span id="bench-score-test" className="font-mono tabular-nums text-2xl font-semibold">{scores.test ?? '—'}</span>
          {scoreDelta !== null && <span className="font-mono tabular-nums font-semibold">({signed(scoreDelta)})</span>}
        </div>
        <div className="font-medium">
          {scores.current === null || scores.test === null ? t('Väntar på poäng', 'Awaiting scores') : scoreTone === 'better' ? t('Testplaneraren är bättre', 'Test planner is better')
            : scoreTone === 'worse' ? t('Testplaneraren är sämre', 'Test planner is worse')
            : t('Ingen skillnad i poäng', 'No score difference')}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>{t(`${totals.cases} testfall`, `${totals.cases} test cases`)}</span>
          <span className="text-emerald-700 dark:text-emerald-400">● {count('better')} {t('bättre', 'better')}</span>
          <span className="text-red-700 dark:text-red-400">● {count('worse')} {t('sämre', 'worse')}</span>
        </div>
      </div>

      <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        {groups.map(([title, lines]) => (
          <div key={title}>
            <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_6rem_4.5rem] items-center gap-x-3 border-b pb-1 text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-wide">{title}</span>
              <span className="text-right">{t('Nuv.', 'Current')}</span>
              <span className="text-right">Test</span>
              <span />
            </div>
            {lines.map(l => {
              const tone = toneOf(l.a, l.b, l.better);
              return (
                <div key={l.key} id={`bench-total-${l.key}`} className="grid grid-cols-[minmax(0,1fr)_3.5rem_6rem_4.5rem] items-center gap-x-3 border-b border-border/50 py-1 text-sm last:border-0">
                  <span className="truncate">{l.label}</span>
                  <span className="text-right font-mono tabular-nums text-muted-foreground">{fmt(l.a, l.digits)}</span>
                  <span className={`text-right font-mono tabular-nums ${tone === 'better' || tone === 'worse' ? 'font-semibold' : ''}`}>
                    {fmt(l.b, l.digits)} <span className="text-xs font-normal text-muted-foreground">{l.unit}</span>
                  </span>
                  <span title={l.better ? undefined : t('Varken högre eller lägre är bättre i sig', 'Neither higher nor lower is better by itself')}
                    className={`justify-self-end rounded px-1.5 py-0.5 text-right font-mono text-xs tabular-nums ${TONE_CLASS[tone]}`}>
                    {tone === 'same' ? '≈' : delta(l.a, l.b, l.digits)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

const LANE_LABEL: Record<string, [string, string]> = {
  told: ['Priser kända vid start', 'Prices known at start'], oracle: ['Alla faktiska priser (facit)', 'All actual prices (oracle)'],
  low: ['låg', 'low'], nominal: ['nominell', 'nominal'], high: ['hög', 'high'],
};

/**
 * Every lane the case was planned under, per planner: net cost and comfort,
 * and what the difference between lanes says about why the plan cost what it did.
 */
const LanePanel: React.FC<{
  lane: LaneId; onLane: (lane: LaneId) => void;
  lanes: { current: Partial<Record<LaneId, LaneResult>>; test: Partial<Record<LaneId, LaneResult>> };
}> = ({ lane, onLane, lanes }) => {
  const { t } = useLanguage();
  const name = (id: LaneId) => { const [p, v] = id.split('/'); return `${t(...LANE_LABEL[p])}, ${t(...LANE_LABEL[v])}`; };
  const cell = (r: LaneResult | undefined) => r ? `${(r.cost_sek - r.credit_sek).toFixed(0)} kr · ${signed(r.points)} pts` : '—';
  const verdict = (d: Diagnosis | null) => d === null ? t('väntar på alla spår', 'waiting for every lane') : [
    t(`prisgissningen kostade ${d.price_estimate_sek.toFixed(0)} kr`, `the price estimate cost ${d.price_estimate_sek.toFixed(0)} kr`),
    t(`värderingen ${d.valuation_sek.toFixed(0)} kr`, `the valuation ${d.valuation_sek.toFixed(0)} kr`),
    t(`bästa värdering: ${t(...LANE_LABEL[d.best.told])} vid start, ${t(...LANE_LABEL[d.best.oracle])} med facit`,
      `best valuation: ${t(...LANE_LABEL[d.best.told])} with starting prices, ${t(...LANE_LABEL[d.best.oracle])} with oracle prices`),
  ].join(' · ');
  return (
    <div id="bench-lanes">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 text-sm">
        <span className="font-medium">{t('Spår', 'Lanes')}</span>
        <span className="text-xs text-muted-foreground">
          {t('Vid start: bara då publicerade priser, resten uppskattas. Facit: planeraren får alla senare faktiska priser. Båda mäts mot faktiska priser. Låg/nominell/hög ändrar lagrens värdekurvor (0,71×/1×/1,41×). Nettokostnad · poäng.',
            'At start: only prices published then; the planner estimates the rest. Oracle: it is given all later actual prices. Both are evaluated at actual prices. Low/nominal/high scales store value curves (0.71×/1×/1.41×). Net cost · points.')}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 font-normal">{t('Spår', 'Lane')}</th>
              <th className="py-1 text-right font-normal">{t('Nuvarande', 'Current')}</th>
              <th className="py-1 text-right font-normal">Test</th>
            </tr>
          </thead>
          <tbody>
            {LANES.map(id => (
              <tr key={id} className={`border-b border-border/50 ${id === lane ? 'bg-muted/60' : ''}`}>
                <td className="py-1">
                  <button id={`bench-lane-${id.replace('/', '-')}`} className="text-left underline-offset-2 hover:underline" aria-pressed={id === lane} onClick={() => onLane(id)}>
                    {name(id)}{id === BASE_LANE && <span className="text-xs text-muted-foreground"> ({t('som i drift', 'as it runs live')})</span>}
                  </button>
                </td>
                <td className="py-1 text-right font-mono tabular-nums">{cell(lanes.current[id])}</td>
                <td className="py-1 text-right font-mono tabular-nums">{cell(lanes.test[id])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <div id="bench-diagnosis-current">{t('Nuvarande', 'Current')}: {verdict(diagnose(lanes.current))}</div>
        <div id="bench-diagnosis-test">Test: {verdict(diagnose(lanes.test))}</div>
      </div>
    </div>
  );
};

interface CaseViewProps {
  scenario: BenchScenario;
  currentRun: BenchRun | null;
  testRun: BenchRun | null;
  summaryByKey: Map<string, BenchResultSummary>;
  details: { current: BenchResultDetail | null; test: BenchResultDetail | null } | null;
  lane: LaneId;
  onLane: (lane: LaneId) => void;
  lanes: { current: Partial<Record<LaneId, LaneResult>>; test: Partial<Record<LaneId, LaneResult>> };
  seriesLoading: boolean;
  savingStartState: boolean;
  onSaveStartState: (state: CaseStartState) => void;
  shown: 'current' | 'test';
  onShown: (value: 'current' | 'test') => void;
  /** The rules being tried: the saved ones with any unsaved change. They are the same for every case. */
  draft: CriteriaOverrides;
  unsaved: boolean;
  onDraft: (draft: CriteriaOverrides | null) => void;
  onSaveRules: () => void;
  onRerun: () => void;
}

// The palette runs −2…+2; anything worse than −2 takes the darkest red.
const SCORE_COLOUR = (score: number) => `var(--plan-score-${score < 0 ? 'n' : 'p'}${Math.min(2, Math.abs(score))})`;
const signed = (value: number, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;

const CaseView: React.FC<CaseViewProps> = ({
  scenario, currentRun, testRun, summaryByKey,
  details, lane, onLane, lanes, seriesLoading, savingStartState, onSaveStartState, shown, onShown, draft, unsaved, onDraft, onSaveRules, onRerun,
}) => {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<number | null>(null);
  const draftErrors = criteriaErrors(draft);
  const rules = draftErrors.length ? [] : resolveRules(draft);
  const poolTarget = details?.test?.series?.comfort?.pool_target_c ?? details?.current?.series?.comfort?.pool_target_c ?? 30;
  const minC = poolTarget - (rules.find(r => r.key === 'pool_cold')?.threshold ?? 2);
  const comfortC = poolTarget - (rules.find(r => r.key === 'pool_low')?.threshold ?? 1);

  const series = useMemo(() => details && { current: details.current?.series ?? null, test: details.test?.series ?? null }, [details]);
  const shownDetail = shown === 'current' ? details?.current : details?.test;

  // Scored live with the rules being edited, so a change shows before it is saved.
  const currentScore = useMemo(() => !draftErrors.length && series?.current ? scoreQuarters(series.current, draft) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series?.current, draft]);
  const testScore = useMemo(() => !draftErrors.length && series?.test ? scoreQuarters(series.test, draft) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series?.test, draft]);

  // The chart and the rule list show the same period: the whole plan, or one local day.
  const starts = (series?.test ?? series?.current)?.start;
  const days = useMemo(() => benchDays(starts ?? [], TZ), [starts]);
  const [period, setPeriod] = useState<BenchPeriod>('all');
  const range = periodRange(days, period, starts?.length ?? 0);
  /** Explain a quarter, moving a single-day view to the day it is in. */
  const select = (quarter: number) => {
    setSelected(quarter);
    const day = days.findIndex(d => quarter >= d.from && quarter < d.to);
    if (day >= 0) setPeriod(previous => previous === 'all' ? previous : day);
  };

  const shownSeries = shown === 'current' ? series?.current : series?.test;
  const shownScore = shown === 'current' ? currentScore : testScore;
  const errorFor = (run: BenchRun | null) => run ? summaryByKey.get(key(run.sha, scenario.id)) : undefined;
  const errors = [errorFor(currentRun), errorFor(testRun)].filter(s => s?.status === 'error');
  const ruleLabel = new Map(rules.map(r => [r.key, r]));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-lg">{scenario.name} · {formatHomeDayMonthTime(scenario.captured_at, TZ)}</CardTitle>
        <div className="flex gap-2">
          <div className="inline-flex rounded-md border overflow-hidden" role="group" aria-label={t('Visad planerare', 'Planner shown')}>
            {(['current', 'test'] as const).map(value => (
              <button key={value} id={`bench-show-${value}`} aria-pressed={shown === value} onClick={() => onShown(value)}
                className={`px-3 py-1.5 text-sm ${shown === value ? 'bg-foreground text-background' : 'bg-card hover:bg-muted'}`}>
                {value === 'current' ? t('Nuvarande planerare', 'Current planner') : t('Testplanerare', 'Test planner')}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={onRerun}>{t('Kör om fallet', 'Re-run this case')}</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {errors.map(e => (
          <Alert key={e!.sha} variant="destructive"><AlertDescription className="font-mono text-xs whitespace-pre-wrap">{e!.sha.slice(0, 7)}: {e!.error?.split('\n')[0]}</AlertDescription></Alert>
        ))}
        {seriesLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar planer…', 'Loading plans…')}</div>}
        {series && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {([['current', currentRun, currentScore], ['test', testRun, testScore]] as const).map(([which, run, score]) => run && (
                <div key={which} className={`rounded-md border px-3 py-2 ${shown === which ? 'border-foreground' : ''}`}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{which === 'current' ? t('Nuvarande', 'Current') : 'Test'} <span className="font-mono text-xs text-muted-foreground">{run.short_sha}</span></span>
                    <span className="font-mono">{score?.complete && !score.auditPending ? `${signed(score.points)} ${t('p', 'pts')}` : '—'}</span>
                  </div>
                  {score && (!score.audit || score.auditPending) && <div className="mt-1 text-xs text-muted-foreground">{t('Saknar granskning · räkna om', 'Missing audit · recompute')}</div>}
                </div>
              ))}
            </div>
            {(details?.current?.outcome || details?.test?.outcome) && (
              <div id="bench-real-cost" className="grid gap-3 text-sm sm:grid-cols-2">
                {([['current', details?.current], ['test', details?.test]] as const).map(([which, d]) => d?.outcome && (
                  <div key={which} className="rounded-md border px-3 py-2">
                    <div className="font-medium">{which === 'current' ? t('Nuvarande', 'Current') : 'Test'}: <span className="font-mono">{d.outcome.cost_sek.toFixed(1)} kr</span> <span className="font-normal text-muted-foreground">{t('till verkliga priser', 'at real prices')}</span></div>
                    <div className="text-xs text-muted-foreground">
                      {t('Planeraren räknade med', 'The planner expected')} <span className="font-mono">{d.record?.beliefs.grid_cost_sek?.toFixed(1) ?? '—'} kr</span>
                      {' · '}{t('kvar i lagren vid slutet', 'left in the stores at the end')} <span className="font-mono">{signed(d.outcome.terminal.credit_sek, 1)} kr</span>
                      {d.outcome.violations.length > 0 && <>{' · '}<span className="text-red-700 dark:text-red-400">{d.outcome.violations.length} {t('beslut som hushållet inte kunde utföra', 'decisions the household could not carry out')}</span></>}
                      {d.record && d.record.status !== 'ready' && <>{' · '}<span className="text-red-700 dark:text-red-400">{t('planstatus', 'plan status')} {d.record.status}</span></>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <BenchComparePanel current={series.current} test={series.test} timeZone={TZ} minC={minC} comfortC={comfortC} />
            {shownSeries ? (
              <>
                <BenchPlanChart series={shownSeries} timeZone={TZ} quarters={shownScore?.quarters ?? null}
                  selected={selected} onSelect={select} days={days} period={period} onPeriod={setPeriod} />
                <div className="rounded-md border px-3 py-2 text-sm min-h-[3rem]" aria-live="polite">
                  {selected === null || !shownScore?.quarters[selected]
                    ? <span className="text-muted-foreground">{t('Klicka på en kvart i diagrammet för att se varför den fick sin poäng.', 'Click a quarter in the chart to see why it scored what it did.')}</span>
                    : (() => {
                      const q = shownScore.quarters[selected];
                      return (
                        <div className="space-y-1">
                          <div>
                            <span className="font-mono font-semibold" style={{ color: SCORE_COLOUR(q.score) }}>{signed(q.score)}</span>{' '}
                            <span className="font-medium">{formatHomeDayMonthTime(shownSeries.start[selected], TZ)}</span>{' '}
                            <span className="text-muted-foreground">· {shownSeries.importPrice[selected].toFixed(2)} kr/kWh {shownSeries.published[selected]
                              ? t('publicerat', 'published')
                              : shownDetail?.outcome
                                ? t(`verkligt, planeraren trodde ${shownSeries.believedImportPrice?.[selected]?.toFixed(2) ?? '—'}`, `real, the planner expected ${shownSeries.believedImportPrice?.[selected]?.toFixed(2) ?? '—'}`)
                                : t('uppskattat', 'estimated')}</span>
                          </div>
                          {q.fired.length
                            ? <ul className="text-xs space-y-0.5">{q.fired.map(k => (
                              <li key={k} className="font-mono">{signed(ruleLabel.get(k)!.points)} {ruleLabel.get(k)!.label}</li>
                            ))}</ul>
                            : <div className="text-xs text-muted-foreground">{t('Ingen regel slog till.', 'No rule fired.')}</div>}
                        </div>
                      );
                    })()}
                </div>
              </>
            ) : <p className="text-sm text-muted-foreground">{t('Ingen plan för den här planeraren ännu.', 'No plan from this planner yet.')}</p>}
            <LanePanel lane={lane} onLane={onLane} lanes={lanes} />
            <BenchCurvesPanel current={details?.current?.record?.curves ?? null} test={details?.test?.record?.curves ?? null} />
            {scenario.dataset && (
              <BenchStartState value={scenario.dataset.start_state} unread={scenario.dataset.start_state_unread ?? []}
                saving={savingStartState} onSave={onSaveStartState} />
            )}
          </>
        )}

        {draftErrors.length > 0
          ? <Alert variant="destructive"><AlertDescription>{draftErrors.join(' · ')} <Button variant="outline" size="sm" onClick={() => onDraft(null)}>{t('Återställ regler', 'Reset rules')}</Button></AlertDescription></Alert>
          : <BenchRuleList current={series?.current ?? null} test={series?.test ?? null}
            currentScore={currentScore} testScore={testScore} draft={draft} onDraft={onDraft} unsaved={unsaved}
            onSave={onSaveRules} timeZone={TZ}
            range={range} periodLabel={period === 'all' ? t('hela 72 h', 'full 72 h') : days[Math.min(period, days.length - 1)]?.label ?? ''}
            dayStarts={days.map(d => d.from)}
            onSelect={(which, quarter) => { onShown(which); select(quarter); }} />}
      </CardContent>
    </Card>
  );
};

export default PlannerBench;
