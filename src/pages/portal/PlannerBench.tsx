import BenchBufferEvent from '@/components/portal/planner-bench/BenchBufferEvent';
// Planner bench: every planner version replayed on the same test cases,
// scored, and compared against the planner currently deployed
// (docs/planner-bench/README.md). Staff only. The bench tables exist only in
// the TEST Supabase project, so elsewhere the page points to the test site.
//
// Two tabs, kept in the URL. The bench gives every planner the real prices of
// a case, so it judges planning alone; how well unpublished prices are
// estimated has its own tab (PriceEstimateAccuracy).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Loader2, Play, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectGroup, SelectLabel, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { FALLBACK_HOME_TIME_ZONE, formatHomeDayMonthTime, formatHomeStamp } from '@/lib/energy-shift/home-time';
import { caseFromReplay, type ConvertedReplay } from '@/lib/planner-bench/convert-replay';
import type { CaseStartState } from '@/lib/planner-bench/case';
import { HOUSEHOLD } from '@/lib/planner-bench/household';
import { BASE_LANE } from '@/lib/planner-bench/lanes';
import { fetchAllRows } from '@/lib/fetch-all-rows';
import { resultState, runCoverage } from '@/lib/planner-bench/coverage';
import { suiteStats, type SuiteStats } from '@/lib/planner-bench/stats';
import { benchDays, periodRange, type BenchPeriod } from '@/lib/planner-bench/days';
import {
  distinctScoreRuns, isStale, resolveRules, scoreQuarters, criteriaErrors,
} from '@/lib/planner-bench/score';
import type {
  BenchResultDetail, BenchResultSummary, BenchRun, BenchScenario, BenchSeries, CriteriaOverrides,
} from '@/lib/planner-bench/types';
import BenchPlanChart from '@/components/portal/planner-bench/BenchPlanChart';
import BenchChartDownload from '@/components/portal/planner-bench/BenchChartDownload';
import QuarterScoreDetail, { type QuarterScoreLine } from '@/components/portal/energy/plan/QuarterScoreDetail';
import { signedPoints as signed } from '@/components/portal/energy/plan/quarter-score';
import BenchStartState from '@/components/portal/planner-bench/BenchStartState';
import BenchRuleList from '@/components/portal/planner-bench/BenchRuleList';
import BenchOverlapMove from '@/components/portal/planner-bench/BenchOverlapMove';
import PriceEstimateAccuracy from '@/components/portal/planner-bench/PriceEstimateAccuracy';
import { useBenchJob, type BenchJobRun, type BenchTask } from '@/components/portal/planner-bench/useBenchJob';

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

/** A commit at a branch head goes by the branch: main is production, dev the test site. Any other goes by its hash. */
const runName = (run: BenchRun) => [run.is_current && 'main', run.is_test && 'dev'].filter(Boolean).join(' · ') || run.short_sha;
/** What the two compared planners go by wherever the page tells them apart. */
type RunNames = { current: string; test: string };
const exportedRun = ({ sha, committed_at, subject }: BenchRun) => ({ sha, committed_at, subject });

/** PostgREST's answer when a table is not in the schema: this is not the test project. */
const isMissingTable = (error: unknown) => /PGRST205|bench_\w+.*(does not exist|schema cache)/i.test(String((error as Error)?.message ?? error));

const PlannerBench: React.FC = () => <Bench />;

const RunError: React.FC<{ run: BenchRun | null }> = ({ run }) => {
  const { t } = useLanguage();
  return run?.error ? <p role="status" className="text-xs text-destructive">{run.status === 'unavailable'
    ? t('Den här commiten innehåller ingen planerare.', 'This commit does not contain a planner.') : run.error}</p> : null;
};

const Bench: React.FC = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'prices' ? 'prices' : 'bench';
  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'prices') next.set('tab', 'prices'); else next.delete('tab');
    setParams(next, { replace: true });
  };

  const runs = useQuery({
    queryKey: ['bench', 'runs'],
    queryFn: () => fetchAllRows<BenchRun>((from, to) => db.from('bench_runs').select('*').order('committed_at').order('sha').range(from, to)),
    refetchInterval: 30_000,
  });
  const scenarios = useQuery({
    queryKey: ['bench', 'scenarios'],
    queryFn: () => fetchAllRows<BenchScenario>((from, to) => db.from('bench_scenarios')
      .select('id, revision, name, captured_at, source_filename, notes, archived, created_at, pending_reason, dataset, recorded_at:recorded->>recorded_at')
      .eq('archived', false).order('captured_at').order('id').range(from, to)),
    refetchInterval: 30_000,
  });
  const summaries = useQuery({
    queryKey: ['bench', 'summaries'],
    queryFn: () => fetchAllRows<BenchResultSummary>((from, to) => db.from('bench_result_summaries').select('*')
      .eq('lane', BASE_LANE).order('sha').order('scenario_id').order('lane').range(from, to)),
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
  const testRun = allRuns.find(run => run.sha === testSha) ?? allRuns.find(run => run.is_test) ?? null;
  const [caseId, setCaseId] = useState<string | null>(null);
  const selectedCase = cases.find(c => c.id === caseId) ?? cases[0] ?? null;
  const [shown, setShown] = useState<'current' | 'test'>('test');
  const comparisonShas = [...new Set([testRun?.sha, currentRun?.sha].filter((s): s is string => Boolean(s)))].join(',');

  // The bench shows the base lane: the planner as it runs live.
  const baseSummaries = useMemo(() => (summaries.data ?? []).filter(s => (s.lane ?? BASE_LANE) === BASE_LANE), [summaries.data]);
  const summaryByKey = useMemo(() => new Map(baseSummaries.map(s => [key(s.sha, s.scenario_id), s])), [baseSummaries]);

  const coverage = useMemo(() => new Map(allRuns.map(run => [run.sha, runCoverage(run.status === 'unavailable' ? [] : cases,
    new Map(baseSummaries.filter(s => s.sha === run.sha).map(s => [s.scenario_id, s])), savedRules)])),
  [allRuns, cases, baseSummaries, savedRules]);
  const scoresFor = (sha: string) => coverage.get(sha)?.scores ?? null;
  const runScores = useMemo(() => new Map([...coverage].map(([sha, value]) => [sha, value.score])), [coverage]);

  /** The planners offered for testing: a version that scored the same as the one after it is left out. */
  const listedRuns = useMemo(() => distinctScoreRuns(
    allRuns,
    // A run still going, or one that failed, has only part of its score.
    run => run.status === 'done' ? runScores.get(run.sha) ?? null : null,
    run => run.is_current || run.is_test || run.sha === testRun?.sha,
  ), [allRuns, runScores, testRun?.sha]);

  /** Results scored by an older scorer, or before the rules last changed. */
  const staleCount = useMemo(() => {
    const known = new Set(cases.map(c => c.id));
    return baseSummaries.filter(s => s.status === 'ok' && known.has(s.scenario_id) && isStale(s.score, savedRules)).length;
  }, [cases, baseSummaries, savedRules]);

  /** The plan a rescore is on: it works through plans in sha order, so the first with a stale result. */
  const rescoringSha = useMemo(() => {
    const known = new Set(cases.map(c => c.id));
    return baseSummaries.filter(s => s.status === 'ok' && known.has(s.scenario_id) && isStale(s.score, savedRules))
      .map(s => s.sha).sort()[0] ?? null;
  }, [cases, baseSummaries, savedRules]);

  const currentScores = currentRun ? scoresFor(currentRun.sha) : null;
  const testScores = testRun ? scoresFor(testRun.sha) : null;
  const names: RunNames = { current: currentRun ? runName(currentRun) : 'main', test: testRun ? runName(testRun) : 'dev' };

  /** Both complete runs use the entire recorded cohort; never a partial intersection. */
  const totals = useMemo(() => {
    if (!currentRun || !testRun || runScores.get(currentRun.sha) == null || runScores.get(testRun.sha) == null) return null;
    const ready = cases.filter(c => c.dataset && c.recorded_at);
    const stats = (sha: string) => suiteStats(ready.map(c => summaryByKey.get(key(sha, c.id))!.stats!));
    return { cases: ready.length, current: stats(currentRun.sha), test: stats(testRun.sha) };
  }, [cases, currentRun, testRun, summaryByKey, runScores]);

  /** How many measured cases the test planner scored better or worse on, at the decimal the chips show. */
  const caseVerdicts = useMemo(() => {
    const count = { better: 0, worse: 0, same: 0 };
    for (const c of cases) {
      const a = currentScores?.get(c.id), b = testScores?.get(c.id);
      if (!a || !b) continue;
      const d = Math.round(b.points * 10) - Math.round(a.points * 10);
      count[d > 0 ? 'better' : d < 0 ? 'worse' : 'same']++;
    }
    return count;
  }, [cases, currentScores, testScores]);

  const series = useQuery({
    queryKey: ['bench', 'series', selectedCase?.id, selectedCase?.revision, currentRun?.sha, testRun?.sha],
    enabled: Boolean(selectedCase?.recorded_at && (currentRun || testRun)),
    queryFn: async () => {
      const shas = [currentRun?.sha, testRun?.sha].filter((s): s is string => Boolean(s));
      const data = await rows<({ sha: string } & BenchResultDetail)[]>(db.from('bench_results')
        .select('sha, series, record, outcome').eq('scenario_id', selectedCase!.id).eq('lane', BASE_LANE).eq('case_revision', selectedCase!.revision).in('sha', shas));
      const by = new Map(data.map(r => [r.sha, r]));
      return { current: currentRun ? by.get(currentRun.sha) ?? null : null, test: testRun ? by.get(testRun.sha) ?? null : null };
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['bench'] });

  const job = useBenchJob((run: BenchJobRun, task: BenchTask | null) => {
    refresh();
    if (run.conclusion === 'success') {
      toast({ title: task?.kind === 'rescore' ? t('Poängen är omräknade', 'Scores recomputed') : t('Bänkkörningen är klar', 'Bench run finished') });
    } else {
      toast({
        title: t('Bänkkörningen misslyckades', 'The bench run did not finish'),
        description: t(`Öppna körningen på GitHub för att se varför: ${run.url}`, `Open the run on GitHub to see why: ${run.url}`),
        variant: 'destructive',
      });
    }
  });
  // The workflow reports no progress; what it has stored so far is the progress.
  const jobActive = job.active;
  useEffect(() => {
    if (!jobActive) return;
    const poll = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['bench', 'runs'] });
      queryClient.invalidateQueries({ queryKey: ['bench', 'summaries'] });
    }, 5_000);
    return () => clearInterval(poll);
  }, [jobActive, queryClient]);

  const dispatch = useMutation({
    mutationFn: async (body: { shas: string; scenario?: string; force?: boolean }) => {
      const { data, error } = await supabase.functions.invoke('planner-bench-dispatch', { body });
      if (error) {
        const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
        throw new Error(detail?.message ?? detail?.error ?? error.message);
      }
      return data as { runs_url: string };
    },
    onSuccess: (_data, body) => job.begin({ kind: body.shas === 'none' ? 'rescore' : 'run', staleAtStart: staleCount }),
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
      // Every planner on the bench, so earlier commits stay comparable with the branch heads.
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
      // Rule-driven decisions must be optimized again; unchanged legacy inputs skip solve.
      dispatch.mutate({ shas: 'all' });
    },
    onError: (error: Error) => toast({ title: t('Kunde inte spara reglerna', 'Could not save the rules'), description: error.message, variant: 'destructive' }),
  });

  const loading = runs.isLoading || scenarios.isLoading || summaries.isLoading;
  const loadError = runs.error ?? scenarios.error ?? summaries.error;
  // One score means one thing: every measured case, today's scorer. A run without that has no points to show.
  const runLabel = (run: BenchRun) => {
    const score = runScores.get(run.sha);
    const state = run.status === 'pending' ? t('väntar på körning', 'awaiting run') : run.status === 'running' ? t('kör', 'running')
      : run.status === 'failed' ? t('misslyckades', 'failed') : run.status === 'unavailable' ? t('saknar planerare', 'no planner')
      : score == null ? t('behöver köras om', 'needs a rerun') : `${score.toFixed(1)} ${t('p', 'pts')}`;
    return `${runName(run)}${run.is_current || run.is_test ? ` · ${run.short_sha}` : ''} · ${formatHomeStamp(run.committed_at, TZ)} · ${state}`;
  };

  const shortRun = (sha: string | null) => {
    const run = allRuns.find(r => r.sha === sha);
    return run ? `${run.short_sha} · ${run.subject}` : null;
  };
  const kind = job.task?.kind ?? null;
  const jobTitle = kind === 'rescore' ? t('Räknar om poäng', 'Recomputing scores')
    : kind === 'run' ? t('Kör planerarbänken', 'Running the planner bench')
    : job.run?.event === 'push' ? t('Planerarbänken körs för senaste pushen', 'The planner bench is running for the latest push')
    : t('Planerarbänken körs', 'The planner bench is running');
  const minutes = Math.floor(job.elapsedMs / 60_000), seconds = Math.floor(job.elapsedMs / 1000) % 60;
  const elapsed = `${minutes}:${String(seconds).padStart(2, '0')}`;
  const left = job.task ? Math.max(0, job.task.staleAtStart - staleCount) : 0;
  const jobDetail = job.waiting
    ? t(`Väntar på att GitHub Actions ska starta · ${elapsed}`, `Waiting for GitHub Actions to start · ${elapsed}`)
    : kind === 'rescore' && job.task!.staleAtStart > 0
      ? t(`${left} av ${job.task!.staleAtStart} poäng omräknade · ${elapsed}`, `${left} of ${job.task!.staleAtStart} scores recomputed · ${elapsed}`)
      : t(`Körs på GitHub Actions · ${elapsed}`, `Running on GitHub Actions · ${elapsed}`);
  // A rescore works through the planners one after another, and a run stores each one as it starts.
  const jobPlan = job.waiting ? null
    : shortRun(kind === 'rescore' ? rescoringSha : allRuns.find(r => r.status === 'running')?.sha ?? null);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1400px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t('Planerarbänk', 'Planner bench')}</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            {t('Varje planerarversion körs på samma testfall, med testfallets verkliga priser, och jämförs med den planerare som körs nu.',
              'Every planner version replays the same test cases, on each case’s real prices, and is compared with the planner running now.')}
          </p>
        </div>
        <div className={`flex flex-wrap gap-2 ${tab === 'bench' ? '' : 'hidden'}`}>
          <input ref={fileInput} id="bench-replay-file" type="file" accept="application/json,.json" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          <Button variant="outline" onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4 mr-2" />{t('Lägg till testfall', 'Add test case')}</Button>
          <Button variant="outline" disabled={dispatch.isPending || job.active} onClick={() => dispatch.mutate({ shas: 'all' })}>
            {dispatch.isPending || job.active ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            {t('Kör saknade', 'Run missing results')}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-5">
      <TabsList className="h-auto max-w-full flex-wrap justify-start">
        <TabsTrigger id="bench-tab-bench" value="bench" className="min-h-9">{t('Planerarbänk', 'Planner bench')}</TabsTrigger>
        <TabsTrigger id="bench-tab-prices" value="prices" className="min-h-9">{t('Prisuppskattningens träffsäkerhet', 'Price estimate accuracy')}</TabsTrigger>
      </TabsList>
      <TabsContent value="bench" className="mt-0 space-y-5">
      {loadError && (isMissingTable(loadError)
        ? <Alert><AlertDescription>
            {t('Bänken finns bara på testsajten, eftersom testfallen ligger i testdatabasen.',
              'The bench runs on the test site only, because its test cases live in the test database.')}{' '}
            <a className="underline" href={TEST_SITE}>{TEST_SITE}</a>
          </AlertDescription></Alert>
        : <Alert variant="destructive"><AlertDescription>{(loadError as Error).message}</AlertDescription></Alert>)}
      {loading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar…', 'Loading…')}</div>}

      {!loading && !loadError && job.active && (
        <Alert role="status">
          <AlertDescription className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-3">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <div className="space-y-0.5">
                <div className="font-medium">{jobTitle}</div>
                <div className="text-muted-foreground">{jobDetail}</div>
                {jobPlan && <div className="font-mono text-xs">{jobPlan}</div>}
              </div>
            </div>
            {job.run && <a className="text-sm underline" href={job.run.url} target="_blank" rel="noreferrer">{t('Visa på GitHub', 'View on GitHub')}</a>}
          </AlertDescription>
        </Alert>
      )}

      {!loading && !loadError && !job.active && staleCount > 0 && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t(`${staleCount} resultat har poäng från en äldre poängsättning. Sparade poäng visas fortfarande; räkna om för att jämföra med dagens poängsättare.`,
              `${staleCount} result${staleCount === 1 ? ' has' : 's have'} scores from an older scorer. Saved points remain visible; recompute to compare with the current scorer.`)}</span>
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
              const state = resultState(c, testRun ? summaryByKey.get(key(testRun.sha, c.id)) : undefined, savedRules);
              const stateLabel = state === 'missing' ? t('saknar resultat', 'missing result')
                : state === 'inputs-changed' ? t('ändrade indata · kör om', 'inputs changed · rerun')
                : state === 'needs-rescore' ? t('räkna om poäng', 'recompute score')
                : state === 'error' ? t('planerarfel', 'planner error') : null;
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
                  {stateLabel && <span className="text-xs opacity-70">{stateLabel}</span>}
                  {currentScore && <span className="font-mono text-xs opacity-70">{names.current} {signed(currentScore.points, 1)}</span>}
                  {testScore && testRun?.sha !== currentRun?.sha && <span className="font-mono text-xs opacity-70">{names.test} {signed(testScore.points, 1)}</span>}
                </button>
              );
            })}
          </div>

          <Card id="bench-summary">
            <CardContent className="pt-6 space-y-4">
              <div className="grid items-start gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-1.5 min-w-0">
                  <div className="text-xs text-muted-foreground">{t('Planerare i produktion', 'Planner in production')}</div>
                  <div id="bench-current-run" className="flex h-10 items-center font-mono text-sm rounded-md border px-3"><span className="truncate">{currentRun ? runLabel(currentRun) : t('Ingen markerad ännu', 'None marked yet')}</span></div>
                  <RunError run={currentRun} />
                </div>
                <div className="flex flex-col gap-1.5 min-w-0">
                  <label htmlFor="bench-test-run" className="text-xs text-muted-foreground">{t('Jämförs med', 'Compared with')}</label>
                  <div className="flex items-center gap-2">
                    <Select value={testRun?.sha ?? ''} onValueChange={setTestSha}>
                      <SelectTrigger id="bench-test-run" className="font-mono text-sm"><SelectValue placeholder={t('Inga körningar ännu', 'No runs yet')} /></SelectTrigger>
                      <SelectContent scrollButtons={false} className="max-h-[min(20rem,var(--radix-select-content-available-height))]">
                        {[true, false].map(environment => <SelectGroup key={String(environment)}>
                          <SelectLabel>{environment ? t('Grenar', 'Branches') : t('Tidigare commits', 'Earlier commits')}</SelectLabel>
                          {listedRuns.filter(run => Boolean(run.is_current || run.is_test) === environment).map(run =>
                            <SelectItem key={run.sha} value={run.sha} className="font-mono text-sm">{runLabel(run)}</SelectItem>)}
                        </SelectGroup>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <RunError run={testRun} />
                </div>
              </div>
              {!totals && cases.some(c => c.recorded_at) && <p id="bench-incomplete" className="text-sm text-muted-foreground">
                {currentRun?.status === 'unavailable' || testRun?.status === 'unavailable'
                  ? t('Jämförelsen kan inte göras eftersom en av dessa commits saknar planerare.',
                    'These commits cannot be compared because one does not contain a planner.')
                  : t('Jämförelsen behöver resultat för alla uppmätta testfall från båda planerarna. Kör saknade resultat.',
                    'The comparison needs a result for every measured case from both planners. Run missing results.')}
              </p>}
              {totals && <SuiteTable names={names} totals={totals} verdicts={caseVerdicts} scores={{ current: currentRun ? runScores.get(currentRun.sha) ?? null : null, test: testRun ? runScores.get(testRun.sha) ?? null : null }} />}
              {!cases.length && <p className="text-sm text-muted-foreground">{t('Inga testfall ännu. Lägg till en replay-fil.', 'No test cases yet. Add a replay file to start.')}</p>}
            </CardContent>
          </Card>

          {selectedCase && (
            <CaseView
              key={selectedCase.id}
              scenario={selectedCase}
              currentRun={currentRun}
              testRun={testRun}
              names={names}
              summaryByKey={summaryByKey}
              details={selectedCase.recorded_at ? series.data ?? null : null}
              seriesLoading={series.isLoading}
              savingStartState={saveStartState.isPending}
              onSaveStartState={state => saveStartState.mutate(state)}
              shown={shown}
              onShown={setShown}
              draft={rulesDraft ?? savedRules}
              unsaved={rulesDraft !== null}
              onDraft={setRulesDraft}
              onSaveRules={() => saveRules.mutate(rulesDraft ?? savedRules)}
              onRerun={() => dispatch.mutate({ shas: comparisonShas, scenario: selectedCase.id, force: true })}
            />
          )}
        </>
      )}

      </TabsContent>
      <TabsContent value="prices" className="mt-0">
        <PriceEstimateAccuracy />
      </TabsContent>
      </Tabs>

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
              {addCase.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{t('Spara och kör aktuella planerare', 'Save and run current planners')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};


/** One planner's bill for the case in view: what it cost at real prices, what the score counts, and what the planner expected. */
const CaseCost: React.FC<{ detail: BenchResultDetail }> = ({ detail: d }) => {
  const { t } = useLanguage();
  if (!d.outcome) return null;
  return <div className="mt-1 space-y-0.5 text-xs">
    <div><span className="font-mono">{d.outcome.cost_sek.toFixed(1)} kr</span> <span className="text-muted-foreground">{t('till verkliga priser', 'at real prices')}</span></div>
    {d.series?.bill && <div data-testid="bench-bill">
      {t('Nettokostnad', 'Net bill')} <span className="font-mono">{d.series.bill.net_sek.toFixed(1)} kr</span>
      {' = '}{t('nät', 'grid')} <span className="font-mono">{d.series.bill.grid_sek.toFixed(1)}</span>
      {' + '}{t('modellerat slitage', 'modelled wear')} <span className="font-mono">{d.series.bill.wear_sek.toFixed(1)}</span>
      {' − '}{t('kvar i lagren', 'left in the stores')} <span className="font-mono">{d.series.bill.credit.credit_sek.toFixed(1)}</span>
      <span className="text-muted-foreground">
        {' ('}{[
          ...([['battery', t('batteri', 'battery')], ['pool', 'pool'], ['ev', t('bil', 'car')]] as const)
            .flatMap(([store, label]) => d.series!.bill!.credit[store] ? [`${label} ${signed(d.series!.bill!.credit[store]!.credit_sek, 1)}`] : []),
          `${t('upp till målen, vid', 'up to the targets, at')} ${d.series.bill.credit.reference_sek_per_kwh.toFixed(2)} kr/kWh`,
        ].join(' · ')}{')'}
      </span>
    </div>}
    <div className="text-muted-foreground">
      {t('Planeraren räknade med', 'The planner expected')} <span className="font-mono">{d.record?.beliefs.grid_cost_sek?.toFixed(1) ?? '—'} kr</span>
      {d.outcome.violations.length > 0 && <>{' · '}<span className="text-red-700 dark:text-red-400">{d.outcome.violations.length} {t('beslut som hushållet inte kunde utföra', 'decisions the household could not carry out')}</span></>}
      {d.record && d.record.status !== 'ready' && <>{' · '}<span className="text-red-700 dark:text-red-400">{t('planstatus', 'plan status')} {d.record.status}</span></>}
    </div>
  </div>;
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

interface SuiteLine { key: keyof SuiteStats; label: string; unit: string; digits: number; a: number | null; b: number | null; better: Better; about?: string }

/** A label, both planners' figures and the change. On a phone the label has a line of its own above the figures. */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem_4.5rem] items-center gap-x-3';
const ROW_LABEL = 'col-span-4 min-w-0 truncate sm:col-span-1';
const ROW_FIRST_FIGURE = 'col-start-2 sm:col-start-auto';

const VALUE_CLASS: Record<Tone, string> = {
  better: 'font-semibold text-emerald-700 dark:text-emerald-400',
  worse: 'font-semibold text-red-700 dark:text-red-400',
  same: '',
  neutral: '',
};

const SuiteTable: React.FC<{
  names: RunNames;
  totals: { cases: number; current: SuiteStats; test: SuiteStats };
  /** Test cases by whether the test planner's score is above or below the current one's. */
  verdicts: { better: number; worse: number; same: number };
  scores: { current: number | null; test: number | null };
}> = ({ names, totals, verdicts, scores }) => {
  const { t } = useLanguage();
  const { current: c, test: x } = totals;
  const line = (label: string, unit: string, digits: number, key: keyof SuiteStats, better: Better, about?: string): SuiteLine =>
    ({ key, label, unit, digits, a: c[key] as number | null, b: x[key] as number | null, better, about });
  const wearRate = HOUSEHOLD.site.battery_degradation_sek_per_kwh;
  type Group = [title: string, lines: SuiteLine[]];
  // What the meter charged and paid, at each case's real prices; wear is a modelled cost and stands apart.
  const cost: Group = [t('Kostnad, elnät', 'Cost, grid'), [
    line(t('Nätkostnad, netto', 'Net grid cost'), 'kr', 1, 'grid_cost_sek', 'lower', t('Köpt minus sålt, till verkliga priser', 'Bought less sold, at real prices')),
    line(t('Köpt från nätet', 'Bought from grid'), 'kr', 1, 'grid_import_sek', null),
    line(t('Snittpris per köpt kWh', 'Avg price per kWh bought'), 'kr', 2, 'import_price', 'lower'),
    line(t('Sålt till nätet', 'Sold to grid'), 'kr', 1, 'export_revenue_sek', null),
    line(t('Snittpris per såld kWh', 'Avg price per kWh sold'), 'kr', 2, 'export_price', 'higher', t('All export, även batteriets', 'All export, the battery’s included')),
  ]];
  const energy: Group = [t('Energi', 'Energy'), [
    line(t('Total förbrukning, 72 h', 'Total used, 72 h'), 'kWh', 1, 'kwh_used', null,
      t('Allt huset drog, oavsett om det kom från nätet, solen eller batteriet', 'Everything the house drew, whether from the grid, the sun or the battery')),
    line(t('Köpt från nätet', 'Bought from grid'), 'kWh', 1, 'grid_import_kwh', null),
    line(t('Sålt till nätet', 'Sold to grid'), 'kWh', 1, 'grid_export_kwh', null),
    line(t('Hembatteri laddat', 'Home battery charged'), 'kWh', 1, 'battery_charge_kwh', null),
    line(t('Elbil laddad', 'EV charged'), 'kWh', 1, 'ev_kwh', null),
  ]];
  const solar: Group = [t('Sol', 'Solar'), [
    line(t('Solel använd', 'Solar used'), 'kWh', 1, 'solar_used_kwh', 'higher',
      t('Solen försörjer huset innan något säljs: baslast först, sedan pool och elbil i proportion, sedan batteriladdning.',
        'The sun serves the house before any is sold: base load first, then pool and car in proportion, then battery charging.')),
    line(t('Sol till baslast', 'Solar to base load'), 'kWh', 1, 'solar_base_kwh', null),
    line(t('Sol till pool', 'Solar to pool'), 'kWh', 1, 'solar_pool_kwh', null),
    line(t('Sol till elbil', 'Solar to EV'), 'kWh', 1, 'solar_ev_kwh', null),
    line(t('Sol till hembatteri', 'Solar to home battery'), 'kWh', 1, 'solar_battery_kwh', null),
    line(t('Solel exporterad', 'Solar exported'), 'kWh', 1, 'solar_exported_kwh', null),
    line(t('Snittpris såld solel', 'Avg price, solar sold'), 'kr', 2, 'solar_export_price', 'higher',
      t('Per kWh solel som gick direkt ut på nätet', 'Per kWh of solar sent straight out to the grid')),
  ]];
  const pool: Group = [t('Pool', 'Pool'), [
    line(t('Poolvärme', 'Pool heating'), 'h', 1, 'pool_heating_hours', null),
    line(t('Poolens el', 'Pool electricity'), 'kWh', 1, 'pool_kwh', null),
    line(t('Snittpris poolens el', 'Avg price, pool kWh'), 'kr', 2, 'pool_price', 'lower',
      t('Nätets pris i kvartarna poolen värmde, viktat med poolens el. Solel räknas inte som gratis.',
        'The grid price in the quarters the pool heated, weighted by its electricity. Solar is not counted as free.')),
    line(t('Pool lägsta', 'Pool lowest'), '°C', 2, 'pool_min_c', null),
    line(t('Pool högsta', 'Pool highest'), '°C', 2, 'pool_max_c', null),
  ]];
  const wear: Group = [t('Slitage, modellerat', 'Wear, modelled'), [
    line(t('Batterislitage', 'Battery wear'), 'kr', 1, 'battery_wear_sek', 'lower',
      t(`${wearRate.toFixed(2)} kr per urladdad kWh. Finns inte på elräkningen. Värmepumpens starter kostar ytterligare 3 kr per start.`,
        `${wearRate.toFixed(2)} kr per kWh discharged. Not on the electricity bill. Pool-heater starts cost an additional 3 kr each.`)),
    line(t('Hembatteri urladdat', 'Home battery discharged'), 'kWh', 1, 'battery_discharge_kwh', null),
  ]];
  const columns: Group[][] = [[cost, energy, wear], [solar, pool]];
  const scoreTone = toneOf(scores.current, scores.test, 'higher');
  const scoreDelta = scores.current !== null && scores.test !== null ? scores.test - scores.current : null;
  // A sum that rounds to nothing is shown as 0, never as −0.
  const fmt = (v: number | null, digits: number) => v === null ? '—' : (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits);

  return (
    <div className="space-y-3">
      <div id="bench-total-score" className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg px-4 py-3 ${TONE_CLASS[scoreTone === 'same' ? 'neutral' : scoreTone]}`}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs uppercase tracking-wide opacity-80">{t('Poäng', 'Score')}</span>
          <span id="bench-score-current" className="font-mono tabular-nums text-foreground">{scores.current?.toFixed(1) ?? '—'}</span>
          <span className="opacity-60">→</span>
          <span id="bench-score-test" className="font-mono tabular-nums text-2xl font-semibold">{scores.test?.toFixed(1) ?? '—'}</span>
          {scoreDelta !== null && <span className="font-mono tabular-nums font-semibold">({signed(scoreDelta, 1)})</span>}
        </div>
        <div className="font-medium">
          {scores.current === null || scores.test === null ? t('Väntar på poäng', 'Awaiting scores')
            : scoreTone === 'better' ? t(`${names.test} är bättre än ${names.current}`, `${names.test} is better than ${names.current}`)
            : scoreTone === 'worse' ? t(`${names.test} är sämre än ${names.current}`, `${names.test} is worse than ${names.current}`)
            : t('Ingen skillnad i poäng', 'No score difference')}
        </div>
        <div id="bench-case-verdicts" className="ml-auto flex items-center gap-3 text-xs text-muted-foreground"
          title={t('Testfall där poängen är högre respektive lägre än hos planeraren i produktion', 'Test cases whose score is above or below the production planner’s')}>
          <span>{t(`${totals.cases} testfall`, `${totals.cases} test cases`)}</span>
          <span id="bench-cases-better" className="text-emerald-700 dark:text-emerald-400">● {verdicts.better} {t('bättre', 'better')}</span>
          <span id="bench-cases-worse" className="text-red-700 dark:text-red-400">● {verdicts.worse} {t('sämre', 'worse')}</span>
          {verdicts.same > 0 && <span id="bench-cases-same">● {verdicts.same} {t('lika', 'same')}</span>}
        </div>
      </div>

      <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        {columns.map((groups, column) => (
          <div key={column} className="space-y-3">
            {groups.map(([title, lines]) => (
              <div key={title}>
                <div className={`${ROW_GRID} border-b pb-1 text-xs text-muted-foreground`}>
                  <span className={`${ROW_LABEL} font-medium uppercase tracking-wide`}>{title}</span>
                  <span className={`${ROW_FIRST_FIGURE} truncate text-right`}>{names.current}</span>
                  <span className="truncate text-right">{names.test}</span>
                  <span />
                </div>
                {lines.map(l => {
                  const tone = toneOf(l.a, l.b, l.better);
                  return (
                    <div key={l.key} id={`bench-total-${l.key}`} data-tone={tone} className={`${ROW_GRID} border-b border-border/50 py-0.5 text-sm last:border-0`}>
                      <span className={ROW_LABEL} title={l.about ? `${l.label}. ${l.about}` : l.label}>{l.label}</span>
                      <span className={`${ROW_FIRST_FIGURE} text-right font-mono tabular-nums text-muted-foreground`}>{fmt(l.a, l.digits)}</span>
                      <span className={`text-right font-mono tabular-nums ${VALUE_CLASS[tone]}`}>
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
        ))}
      </div>
    </div>
  );
};

interface CaseViewProps {
  scenario: BenchScenario;
  currentRun: BenchRun | null;
  testRun: BenchRun | null;
  names: RunNames;
  summaryByKey: Map<string, BenchResultSummary>;
  details: { current: BenchResultDetail | null; test: BenchResultDetail | null } | null;
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

const CaseView: React.FC<CaseViewProps> = ({
  scenario, currentRun, testRun, names, summaryByKey,
  details, seriesLoading, savingStartState, onSaveStartState, shown, onShown, draft, unsaved, onDraft, onSaveRules, onRerun,
}) => {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<number | null>(null);
  const draftErrors = criteriaErrors(draft);
  const rules = draftErrors.length ? [] : resolveRules(draft);

  const series = useMemo(() => {
    const ready = (s: BenchSeries | null | undefined) => s?.devices && s.deviceW ? s : null;
    return details && { current: ready(details.current?.series), test: ready(details.test?.series) };
  }, [details]);
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
  const periodLabel = period === 'all' ? t('hela 72 h', 'full 72 h') : days[Math.min(period, days.length - 1)]?.label ?? '';
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

  /** The selected quarter of the shown plan: its points, and each rule that fired with the evidence for it. */
  const explained = (() => {
    const q = selected === null ? undefined : shownScore?.quarters[selected];
    if (selected === null || !q || !shownSeries || !shownScore) return null;
    const lines: QuarterScoreLine[] = [...q.fired, ...q.noted].map((k, n) => {
      const move = k === 'large_load_overlap' ? shownScore.audit!.overlap.moves.find(m => m.from === selected)!
        : k === 'early_grid_charge' ? shownScore.audit!.earlyCharge.moves.find(m => m.from === selected)! : null;
      const gap = k === 'pool_short_gap'
        ? shownScore.audit!.shortGaps.gaps.find(g => g.device === 'pool' && g.from <= selected && selected < g.to)!
        : null;
      return { key: k, points: ruleLabel.get(k)!.points, noted: n >= q.fired.length, label: <>
        {k === 'pool_buffer' && shownScore.thermalBuffer?.[selected].event
          ? <BenchBufferEvent event={shownScore.thermalBuffer[selected].event!} series={shownSeries} timeZone={TZ} />
          : ruleLabel.get(k)!.label}
        {move && <BenchOverlapMove move={move} series={shownSeries} timeZone={TZ} onSelect={select} />}
        {gap && <> · {formatHomeDayMonthTime(shownSeries.start[gap.from], TZ)} → {formatHomeDayMonthTime(shownSeries.start[gap.to], TZ)}
          {' · '}{gap.to - gap.from} {t('kvartar', 'quarters')}{' · '}{t('sammanhängande drift var möjlig', 'a continuous run was possible')}</>}
      </> };
    });
    return { score: q.score, when: formatHomeDayMonthTime(shownSeries.start[selected], TZ), price: shownSeries.importPrice[selected], lines };
  })();

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
        <CardTitle className="text-lg">{scenario.name} · {formatHomeDayMonthTime(scenario.captured_at, TZ)}</CardTitle>
        <div className="flex gap-2">
          <div className="inline-flex rounded-md border overflow-hidden" role="group" aria-label={t('Visad planerare', 'Planner shown')}>
            {(['current', 'test'] as const).map(value => (
              <button key={value} id={`bench-show-${value}`} aria-pressed={shown === value} onClick={() => onShown(value)}
                className={`px-3 py-1.5 text-sm ${shown === value ? 'bg-foreground text-background' : 'bg-card hover:bg-muted'}`}>
                {names[value]}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={onRerun}>{t('Kör om fallet', 'Re-run this case')}</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!scenario.recorded_at && <Alert><AlertDescription>
          {t('Väntar på fullständiga mätningar. ', 'Waiting for complete measurements. ')}{scenario.pending_reason}
        </AlertDescription></Alert>}
        {scenario.notes && <p className="text-sm text-muted-foreground">{scenario.notes}</p>}
        {errors.map(e => (
          <Alert key={e!.sha} variant="destructive"><AlertDescription className="font-mono text-xs whitespace-pre-wrap">{e!.sha.slice(0, 7)}: {e!.error?.split('\n')[0]}</AlertDescription></Alert>
        ))}
        {shownDetail?.series && !shownSeries && <p className="text-sm text-muted-foreground">{t('Enhetsprognoserna behöver räknas om innan planen kan visas.', 'Device projections need recomputing before this plan can be displayed.')}</p>}
        {seriesLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar planer…', 'Loading plans…')}</div>}
        {series && (
          <>
            <div id="bench-real-cost" className="grid gap-3 sm:grid-cols-2">
              {([['current', currentRun, currentScore], ['test', testRun, testScore]] as const).map(([which, run, score]) => run && (
                <div key={which} className={`rounded-md border px-3 py-2 ${shown === which ? 'border-foreground' : ''}`}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium">{names[which]}{names[which] !== run.short_sha && <> <span className="font-mono text-xs text-muted-foreground">{run.short_sha}</span></>}</span>
                    <span className="font-mono">{score?.complete && !score.auditPending ? `${signed(score.points, 1)} ${t('p', 'pts')}` : '—'}</span>
                  </div>
                  {score && (!score.audit || score.auditPending) && <div className="mt-1 text-xs text-muted-foreground">{t('Saknar granskning · räkna om', 'Missing audit · recompute')}</div>}
                  {details?.[which] && <CaseCost detail={details[which]!} />}
                </div>
              ))}
            </div>
            {shownSeries ? (
              <BenchPlanChart series={shownSeries} compared={series} names={names} timeZone={TZ} quarters={shownScore?.quarters ?? null}
                selected={selected} onSelect={select} days={days} period={period} onPeriod={setPeriod}
                scoreDetail={<QuarterScoreDetail id="bench-quarter-explanation" quarter={explained} action={<BenchChartDownload input={{
                  scenario: { id: scenario.id, name: scenario.name, captured_at: scenario.captured_at, revision: scenario.revision, start_state: scenario.dataset?.start_state },
                  timeZone: TZ, period: { label: periodLabel, ...range }, shown, rules,
                  plans: {
                    current: currentRun && series.current ? { ...exportedRun(currentRun), name: names.current, series: series.current, score: currentScore } : null,
                    test: testRun && series.test ? { ...exportedRun(testRun), name: names.test, series: series.test, score: testScore } : null,
                  },
                }} />} />} />
            ) : <p className="text-sm text-muted-foreground">{t('Ingen plan för den här planeraren ännu.', 'No plan from this planner yet.')}</p>}
            {scenario.dataset && (
              <BenchStartState value={scenario.dataset.start_state} unread={scenario.dataset.start_state_unread ?? []}
                saving={savingStartState} onSave={onSaveStartState} />
            )}
          </>
        )}

        {draftErrors.length > 0
          ? <Alert variant="destructive"><AlertDescription>{draftErrors.join(' · ')} <Button variant="outline" size="sm" onClick={() => onDraft(null)}>{t('Återställ regler', 'Reset rules')}</Button></AlertDescription></Alert>
          : <BenchRuleList current={series?.current ?? null} test={series?.test ?? null}
            currentScore={currentScore} testScore={testScore} names={names} draft={draft} onDraft={onDraft} unsaved={unsaved}
            onSave={onSaveRules} timeZone={TZ}
            range={range} periodLabel={periodLabel}
            dayStarts={days.map(d => d.from)}
            onSelect={(which, quarter) => { onShown(which); select(quarter); }} />}
      </CardContent>
    </Card>
  );
};

export default PlannerBench;
