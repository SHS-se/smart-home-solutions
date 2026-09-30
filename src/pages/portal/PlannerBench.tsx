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
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { FALLBACK_HOME_TIME_ZONE, formatHomeDayMonthTime, formatHomeStamp } from '@/lib/energy-shift/home-time';
import { stripReplay, type StrippedReplay } from '@/lib/planner-bench/strip';
import { suiteStats, type SuiteStats } from '@/lib/planner-bench/stats';
import {
  isStale, resolveRules, runScore, scoreQuarters, storedPassed, CASE_SCALE, type CaseScore,
} from '@/lib/planner-bench/score';
import type {
  BenchResultSummary, BenchRun, BenchScenario, BenchSeries, BenchVerdict, CriteriaOverrides, Verdict,
} from '@/lib/planner-bench/types';
import BenchPlanChart from '@/components/portal/planner-bench/BenchPlanChart';
import BenchComparePanel from '@/components/portal/planner-bench/BenchComparePanel';

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
      .select('id, name, captured_at, source_filename, criteria, notes, archived, created_at')
      .eq('archived', false).order('captured_at')),
  });
  const summaries = useQuery({
    queryKey: ['bench', 'summaries'],
    queryFn: () => rows<BenchResultSummary[]>(db.from('bench_result_summaries').select('*')),
    refetchInterval: 30_000,
  });
  const verdicts = useQuery({
    queryKey: ['bench', 'verdicts'],
    queryFn: () => rows<BenchVerdict[]>(db.from('bench_verdicts').select('sha, scenario_id, verdict, note')),
  });

  const allRuns = useMemo(() => runs.data ?? [], [runs.data]);
  const cases = useMemo(() => scenarios.data ?? [], [scenarios.data]);
  const currentRun = allRuns.find(run => run.is_current) ?? null;
  const [testSha, setTestSha] = useState<string | null>(null);
  const testRun = allRuns.find(run => run.sha === testSha) ?? allRuns[allRuns.length - 1] ?? null;
  const [caseId, setCaseId] = useState<string | null>(null);
  const selectedCase = cases.find(c => c.id === caseId) ?? cases[0] ?? null;
  const [shown, setShown] = useState<'current' | 'test'>('test');

  const summaryByKey = useMemo(() => new Map((summaries.data ?? []).map(s => [key(s.sha, s.scenario_id), s])), [summaries.data]);
  const verdictByKey = useMemo(() => new Map((verdicts.data ?? []).map(v => [key(v.sha, v.scenario_id), v])), [verdicts.data]);

  /** Every case's stored score for one run; null where the run has no scored result. */
  const scoresFor = useMemo(() => (sha: string) => new Map(cases.map(c => {
    const summary = summaryByKey.get(key(sha, c.id));
    const verdict = verdictByKey.get(key(sha, c.id))?.verdict ?? null;
    const score = summary?.status === 'ok' ? summary.score : null;
    return [c.id, score ? { points: score.points, passed: storedPassed(score, verdict) } : null] as const;
  })), [cases, summaryByKey, verdictByKey]);

  const runScores = useMemo(() => new Map(allRuns.map(run => {
    const points = [...scoresFor(run.sha).values()].filter((s): s is CaseSummary => s !== null).map(s => s.points);
    return [run.sha, runScore(points)] as const;
  })), [allRuns, scoresFor]);

  /** Results scored by an older scorer, or before their case's rules last changed. */
  const staleCount = useMemo(() => {
    const criteria = new Map(cases.map(c => [c.id, c.criteria]));
    return (summaries.data ?? []).filter(s => s.status === 'ok' && criteria.has(s.scenario_id)
      && isStale(s.score, criteria.get(s.scenario_id))).length;
  }, [cases, summaries.data]);

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
    queryKey: ['bench', 'series', selectedCase?.id, currentRun?.sha, testRun?.sha],
    enabled: Boolean(selectedCase && (currentRun || testRun)),
    queryFn: async () => {
      const shas = [currentRun?.sha, testRun?.sha].filter((s): s is string => Boolean(s));
      const data = await rows<{ sha: string; series: BenchSeries | null }[]>(db.from('bench_results')
        .select('sha, series').eq('scenario_id', selectedCase!.id).in('sha', shas));
      const by = new Map(data.map(r => [r.sha, r.series]));
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

  const [pending, setPending] = useState<(StrippedReplay & { filename: string; name: string }) | null>(null);
  const addCase = useMutation({
    mutationFn: async () => {
      const inserted = await rows<{ id: string }>(db.from('bench_scenarios').insert({
        name: pending!.name.trim() || pending!.suggestedName,
        captured_at: pending!.capturedAt,
        source_filename: pending!.filename,
        input_hash: pending!.inputHash,
        input: pending!.input,
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
      const stripped = stripReplay(JSON.parse(await file.text()));
      setPending({ ...stripped, filename: file.name, name: stripped.suggestedName });
    } catch (error) {
      toast({ title: t('Filen kunde inte läsas', 'That file could not be read'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const setVerdict = useMutation({
    mutationFn: async ({ sha, verdict, note }: { sha: string; verdict: Verdict | null; note: string }) => {
      if (!selectedCase) return;
      if (verdict === null) {
        await rows(db.from('bench_verdicts').delete().eq('sha', sha).eq('scenario_id', selectedCase.id));
      } else {
        await rows(db.from('bench_verdicts').upsert({ sha, scenario_id: selectedCase.id, verdict, note: note || null }));
      }
    },
    onSuccess: refresh,
    onError: (error: Error) => toast({ title: t('Kunde inte spara bedömningen', 'Could not save the verdict'), description: error.message, variant: 'destructive' }),
  });

  const saveCriteria = useMutation({
    mutationFn: async (criteria: CriteriaOverrides) => {
      await rows(db.from('bench_scenarios').update({ criteria }).eq('id', selectedCase!.id));
    },
    onSuccess: () => {
      refresh();
      toast({ title: t('Reglerna sparade', 'Rules saved') });
      // Stored scores for this case are now stale; recompute them without re-running planners.
      dispatch.mutate({ shas: 'none' });
    },
    onError: (error: Error) => toast({ title: t('Kunde inte spara kriterierna', 'Could not save the criteria'), description: error.message, variant: 'destructive' }),
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
            <span>{t(`${staleCount} resultat har poäng från en äldre poängsättning. Listor och summor visar de gamla poängen tills de räknats om.`,
              `${staleCount} result${staleCount === 1 ? ' has' : 's have'} scores from an older scorer. Lists and totals show the old scores until they are recomputed.`)}</span>
            <Button size="sm" variant="outline" disabled={dispatch.isPending} onClick={() => dispatch.mutate({ shas: 'none' })}>
              {t('Räkna om poäng', 'Recompute scores')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !loadError && (
        <>
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

          <div className="flex flex-wrap gap-2" role="group" aria-label={t('Testfall', 'Test case')}>
            {cases.map(c => {
              const score = testScores?.get(c.id);
              const dot = score == null ? 'bg-muted-foreground/40' : score.passed ? 'bg-emerald-500' : 'bg-red-500';
              const active = c.id === selectedCase?.id;
              return (
                <button key={c.id} id={`bench-case-${c.id}`} onClick={() => setCaseId(c.id)} aria-pressed={active}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${active ? 'bg-foreground text-background border-foreground' : 'bg-muted/40 hover:bg-muted'}`}>
                  <span className={`h-2 w-2 rounded-full ${dot}`} />
                  <span className="font-mono text-xs">{c.name}</span>
                  <span>{formatHomeDayMonthTime(c.captured_at, TZ)}</span>
                  {score && <span className="font-mono text-xs opacity-70">{score.points > 0 ? '+' : ''}{score.points.toFixed(1)}</span>}
                </button>
              );
            })}
          </div>

          {selectedCase && (
            <CaseView
              key={selectedCase.id}
              scenario={selectedCase}
              currentRun={currentRun}
              testRun={testRun}
              summaryByKey={summaryByKey}
              verdictByKey={verdictByKey}
              series={series.data ?? null}
              seriesLoading={series.isLoading}
              shown={shown}
              onShown={setShown}
              onVerdict={(sha, verdict, note) => setVerdict.mutate({ sha, verdict, note })}
              onSaveCriteria={criteria => saveCriteria.mutate(criteria)}
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
                `Planerat ${formatHomeStamp(pending.capturedAt, TZ)}. Bara planerarens indata sparas (${Math.round(JSON.stringify(pending.input).length / 1024)} kB).`,
                `Planned at ${formatHomeStamp(pending.capturedAt, TZ)}. Only the planner's input is kept (${Math.round(JSON.stringify(pending.input).length / 1024)} kB).`)}
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

const n1 = (v: number | null) => v === null ? '—' : v.toFixed(1);
const n2 = (v: number | null) => v === null ? '—' : v.toFixed(2);

const SuiteTable: React.FC<{ totals: { cases: number; current: SuiteStats; test: SuiteStats }; scores: { current: number | null; test: number | null } }> = ({ totals, scores }) => {
  const { t } = useLanguage();
  const { current: c, test: x } = totals;
  const lines: [string, string, string, number | null, number | null][] = [
    [t('Poäng', 'Score'), `${scores.current ?? '—'}`, `${scores.test ?? '—'}`, scores.current, scores.test],
    [t('Total förbrukning, 72 h', 'Total kWh used, 72 h'), `${n1(c.kwh_used)} kWh`, `${n1(x.kwh_used)} kWh`, c.kwh_used, x.kwh_used],
    [t('Total nätkostnad, 72 h', 'Total grid cost, 72 h'), `${n1(c.grid_cost_sek)} kr`, `${n1(x.grid_cost_sek)} kr`, c.grid_cost_sek, x.grid_cost_sek],
    [t('Snittkostnad per kWh', 'Average cost per kWh'), `${n2(c.cost_per_kwh)} kr`, `${n2(x.cost_per_kwh)} kr`, c.cost_per_kwh, x.cost_per_kwh],
    [t('Poolvärme, timmar', 'Pool heating, hours'), `${n1(c.pool_heating_hours)} h`, `${n1(x.pool_heating_hours)} h`, c.pool_heating_hours, x.pool_heating_hours],
    [t('Pool lägsta / högsta', 'Pool lowest / highest'), `${n2(c.pool_min_c)} / ${n2(c.pool_max_c)} °C`, `${n2(x.pool_min_c)} / ${n2(x.pool_max_c)} °C`, null, null],
    [t('Hembatteri laddat', 'Home battery charged'), `${n1(c.battery_charge_kwh)} kWh`, `${n1(x.battery_charge_kwh)} kWh`, c.battery_charge_kwh, x.battery_charge_kwh],
    [t('Elbil laddad', 'EV charged'), `${n1(c.ev_kwh)} kWh`, `${n1(x.ev_kwh)} kWh`, c.ev_kwh, x.ev_kwh],
    [t('Solel använd', 'Solar used'), `${n1(c.solar_used_kwh)} kWh`, `${n1(x.solar_used_kwh)} kWh`, c.solar_used_kwh, x.solar_used_kwh],
    [t('Solel exporterad', 'Solar exported'), `${n1(c.solar_exported_kwh)} kWh`, `${n1(x.solar_exported_kwh)} kWh`, c.solar_exported_kwh, x.solar_exported_kwh],
    [t('Snittpris export per kWh', 'Average export price per kWh'), `${n2(c.export_price)} kr`, `${n2(x.export_price)} kr`, c.export_price, x.export_price],
  ];
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(`Alla ${totals.cases} testfall`, `All ${totals.cases} test cases`)}</TableHead>
            <TableHead className="text-right">{t('Nuvarande', 'Current')}</TableHead>
            <TableHead className="text-right">Test</TableHead>
            <TableHead className="text-right">{t('Skillnad', 'Change')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map(([label, cur, test, a, b]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{cur}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{test}</TableCell>
              <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                {a !== null && b !== null ? `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(Math.abs(b - a) < 1 ? 2 : 1)}` : ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

interface CaseViewProps {
  scenario: BenchScenario;
  currentRun: BenchRun | null;
  testRun: BenchRun | null;
  summaryByKey: Map<string, BenchResultSummary>;
  verdictByKey: Map<string, BenchVerdict>;
  series: { current: BenchSeries | null; test: BenchSeries | null } | null;
  seriesLoading: boolean;
  shown: 'current' | 'test';
  onShown: (value: 'current' | 'test') => void;
  onVerdict: (sha: string, verdict: Verdict | null, note: string) => void;
  onSaveCriteria: (criteria: CriteriaOverrides) => void;
  onRerun: () => void;
}

const SCORE_COLOUR = (score: number) => `var(--plan-score-${score < 0 ? 'n' : 'p'}${Math.abs(score)})`;
const signed = (value: number, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;

const CaseView: React.FC<CaseViewProps> = ({
  scenario, currentRun, testRun, summaryByKey, verdictByKey,
  series, seriesLoading, shown, onShown, onVerdict, onSaveCriteria, onRerun,
}) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<CriteriaOverrides>(scenario.criteria ?? {});
  const [selected, setSelected] = useState<number | null>(null);
  const rules = resolveRules(draft);
  const minC = rules.find(r => r.key === 'pool_cold')?.threshold ?? 28;
  const comfortC = rules.find(r => r.key === 'pool_low')?.threshold ?? 29;
  const verdictOf = (run: BenchRun | null) => (run ? verdictByKey.get(key(run.sha, scenario.id))?.verdict : null) ?? null;

  // Scored live with the rules being edited, so a change shows before it is saved.
  const currentScore = useMemo(() => series?.current ? scoreQuarters(series.current, draft, verdictOf(currentRun)) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series?.current, draft, currentRun, verdictByKey]);
  const testScore = useMemo(() => series?.test ? scoreQuarters(series.test, draft, verdictOf(testRun)) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series?.test, draft, testRun, verdictByKey]);

  const shownSeries = shown === 'current' ? series?.current : series?.test;
  const shownScore = shown === 'current' ? currentScore : testScore;
  const errorFor = (run: BenchRun | null) => run ? summaryByKey.get(key(run.sha, scenario.id)) : undefined;
  const errors = [errorFor(currentRun), errorFor(testRun)].filter(s => s?.status === 'error');
  const patch = (rule: string, field: 'enabled' | 'threshold' | 'points', value: number | boolean) =>
    setDraft(d => ({ ...d, [rule]: { ...d[rule], [field]: value } }));
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
                    <span className="font-mono">{score ? `${signed(score.points, 1)} ${t('p', 'pts')}` : '—'}</span>
                  </div>
                  {score && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
                      {[2, 1, 0, -1, -2].map(v => (
                        <span key={v} style={{ color: SCORE_COLOUR(v) }}>{signed(v)} × {score.histogram[String(v)]}</span>
                      ))}
                      <span className="text-muted-foreground">{t('summa', 'sum')} {signed(score.sum)} ÷ {CASE_SCALE}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <BenchComparePanel current={series.current} test={series.test} timeZone={TZ} minC={minC} comfortC={Math.max(comfortC, 30)} />
            {shownSeries ? (
              <>
                <BenchPlanChart series={shownSeries} timeZone={TZ} quarters={shownScore?.quarters ?? null}
                  selected={selected} onSelect={setSelected} />
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
                            <span className="text-muted-foreground">· {shownSeries.importPrice[selected].toFixed(2)} kr/kWh {shownSeries.published[selected] ? t('publicerat', 'published') : t('uppskattat', 'estimated')}</span>
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
          </>
        )}

        <div className="space-y-6">
          <div className="space-y-2 min-w-0">
            <h3 className="font-medium">{t('Regler per kvart', 'Quarter rules')}</h3>
            <p className="text-xs text-muted-foreground max-w-3xl">
              {t(`Varje kvart får summan av reglerna som slår till, begränsad till −2…+2. Fallets poäng är kvartssumman ÷ ${CASE_SCALE}, begränsad till −10…+10.`,
                `Each quarter scores the sum of the rules that fire, limited to −2…+2. The case scores its quarter sum ÷ ${CASE_SCALE}, limited to −10…+10.`)}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Regel', 'Rule')}</TableHead>
                    <TableHead>{t('På', 'On')}</TableHead>
                    <TableHead>{t('Gräns', 'Threshold')}</TableHead>
                    <TableHead>{t('Poäng', 'Points')}</TableHead>
                    <TableHead className="text-right">{t('Nuvarande', 'Current')}</TableHead>
                    <TableHead className="text-right">Test</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map(rule => {
                    const cell = (score: CaseScore | null) => {
                      if (!score) return '—';
                      const count = score.counts[rule.key] ?? 0;
                      return count ? `${count} × ${signed(rule.points)}` : '0';
                    };
                    return (
                      <TableRow key={rule.key}>
                        <TableCell className="text-sm min-w-[260px]">{rule.label}{rule.required ? ' *' : ''}<div className="text-xs text-muted-foreground">{rule.describe(rule.threshold)}</div></TableCell>
                        <TableCell><Switch id={`bench-${rule.key}-on`} checked={rule.enabled} onCheckedChange={v => patch(rule.key, 'enabled', v)} /></TableCell>
                        <TableCell><Input id={`bench-${rule.key}-threshold`} type="number" step="0.05" className="w-20 h-8" value={rule.threshold} onChange={e => patch(rule.key, 'threshold', Number(e.target.value))} /></TableCell>
                        <TableCell>
                          <Input id={`bench-${rule.key}-points`} type="number" step="1" min={-2} max={2} className="w-16 h-8" value={rule.points}
                            onChange={e => patch(rule.key, 'points', Math.max(-2, Math.min(2, Math.round(Number(e.target.value)))))} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs whitespace-nowrap">{cell(currentScore)}</TableCell>
                        <TableCell className="text-right font-mono text-xs whitespace-nowrap">{cell(testScore)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => onSaveCriteria(draft)}>{t('Spara regler för fallet', 'Save rules for this case')}</Button>
              <span className="text-xs text-muted-foreground">{t('* slår regeln till blir fallet underkänt. Sparade ändringar räknar om fallet för alla körningar.', '* the case fails if this rule fires anywhere. Saving rescores this case for every run.')}</span>
            </div>
          </div>

          <div className="space-y-3 min-w-0">
            <h3 className="font-medium">{t('Din bedömning', 'Your verdict')}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {([['current', currentRun, currentScore] as const, ['test', testRun, testScore] as const]).map(([which, run, score]) => run && (
                <VerdictRow key={which} label={which === 'current' ? t('Nuvarande', 'Current') : 'Test'} run={run} score={score}
                  existing={verdictByKey.get(key(run.sha, scenario.id)) ?? null}
                  onVerdict={(verdict, note) => onVerdict(run.sha, verdict, note)} />
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const VerdictRow: React.FC<{
  label: string;
  run: BenchRun;
  score: CaseScore | null;
  existing: BenchVerdict | null;
  onVerdict: (verdict: Verdict | null, note: string) => void;
}> = ({ label, run, score, existing, onVerdict }) => {
  const { t } = useLanguage();
  const [note, setNote] = useState(existing?.note ?? '');
  const auto = score
    ? (score.requiredFired.length === 0 && score.points >= 0 ? t('godkänd', 'passes') : t('underkänd', 'fails'))
    : t('inget resultat', 'no result');
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span><span className="font-medium">{label}</span> <span className="font-mono text-xs text-muted-foreground">{run.short_sha}</span></span>
        <span className="text-xs text-muted-foreground">{existing ? t(`Din bedömning: ${existing.verdict === 'pass' ? 'godkänd' : 'underkänd'}`, `Your verdict: ${existing.verdict}`) : t(`Automatiskt: ${auto}`, `Automatic: ${auto}`)}</span>
      </div>
      <Textarea id={`bench-note-${run.sha}`} rows={2} placeholder={t('Varför? (valfritt)', 'Why? (optional)')} value={note} onChange={e => setNote(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant={existing?.verdict === 'pass' ? 'default' : 'outline'} onClick={() => onVerdict('pass', note)}>{t('Godkänd', 'Pass')}</Button>
        <Button size="sm" variant={existing?.verdict === 'fail' ? 'destructive' : 'outline'} onClick={() => onVerdict('fail', note)}>{t('Underkänd', 'Fail')}</Button>
        {existing && <Button size="sm" variant="ghost" onClick={() => onVerdict(null, '')}>{t('Rensa', 'Clear')}</Button>}
      </div>
    </div>
  );
};

export default PlannerBench;
