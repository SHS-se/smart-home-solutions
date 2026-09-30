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
import { resolveCriteria, runScore, scoreCase, type CaseScore } from '@/lib/planner-bench/score';
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

  /** Every case scored for one run; null where the run has no usable result. */
  const scoresFor = useMemo(() => (sha: string) => new Map(cases.map(c => {
    const summary = summaryByKey.get(key(sha, c.id));
    const verdict = verdictByKey.get(key(sha, c.id))?.verdict ?? null;
    return [c.id, summary?.status === 'ok' && summary.stats ? scoreCase(summary.stats, c.criteria, verdict) : null] as const;
  })), [cases, summaryByKey, verdictByKey]);

  const runScores = useMemo(() => new Map(allRuns.map(run => {
    const points = [...scoresFor(run.sha).values()].filter((s): s is CaseScore => s !== null).map(s => s.points);
    return [run.sha, runScore(points)] as const;
  })), [allRuns, scoresFor]);

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
    onSuccess: () => { refresh(); toast({ title: t('Kriterierna sparade', 'Criteria saved') }); },
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
              currentScore={currentScores?.get(selectedCase.id) ?? null}
              testScore={testScores?.get(selectedCase.id) ?? null}
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
  currentScore: CaseScore | null;
  testScore: CaseScore | null;
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

const CaseView: React.FC<CaseViewProps> = ({
  scenario, currentRun, testRun, currentScore, testScore, summaryByKey, verdictByKey,
  series, seriesLoading, shown, onShown, onVerdict, onSaveCriteria, onRerun,
}) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<CriteriaOverrides>(scenario.criteria ?? {});
  const criteria = resolveCriteria(draft);
  const minC = criteria.find(c => c.key === 'pool_min')?.threshold ?? 28;
  const shownSeries = shown === 'current' ? series?.current : series?.test;
  const errorFor = (run: BenchRun | null) => run ? summaryByKey.get(key(run.sha, scenario.id)) : undefined;
  const errors = [errorFor(currentRun), errorFor(testRun)].filter(s => s?.status === 'error');
  const patch = (criterion: string, field: keyof NonNullable<CriteriaOverrides[string]>, value: number | boolean) =>
    setDraft(d => ({ ...d, [criterion]: { ...d[criterion], [field]: value } }));

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
            <BenchComparePanel current={series.current} test={series.test} timeZone={TZ} minC={minC} comfortC={30} />
            {shownSeries
              ? <BenchPlanChart series={shownSeries} timeZone={TZ} />
              : <p className="text-sm text-muted-foreground">{t('Ingen plan för den här planeraren ännu.', 'No plan from this planner yet.')}</p>}
          </>
        )}

        <div className="space-y-6">
          <div className="space-y-2 min-w-0">
            <h3 className="font-medium">{t('Poäng och kriterier', 'Score and criteria')}</h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Kriterium', 'Criterion')}</TableHead>
                    <TableHead>{t('På', 'On')}</TableHead>
                    <TableHead>{t('Gräns', 'Threshold')}</TableHead>
                    <TableHead>{t('Klarad', 'Pass')}</TableHead>
                    <TableHead>{t('Missad', 'Miss')}</TableHead>
                    <TableHead className="text-right">{t('Nuvarande', 'Current')}</TableHead>
                    <TableHead className="text-right">Test</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {criteria.map(def => {
                    const cur = currentScore?.criteria.find(c => c.key === def.key);
                    const test = testScore?.criteria.find(c => c.key === def.key);
                    const cell = (s: typeof cur) => s ? `${s.value ?? 'n/a'} → ${s.points > 0 ? '+' : ''}${s.points.toFixed(1)}` : '—';
                    return (
                      <TableRow key={def.key}>
                        <TableCell className="text-sm min-w-[220px]">{def.label}{def.required ? ' *' : ''}<div className="text-xs text-muted-foreground">{def.describe(def.threshold)}</div></TableCell>
                        <TableCell><Switch id={`bench-${def.key}-on`} checked={def.enabled} onCheckedChange={v => patch(def.key, 'enabled', v)} /></TableCell>
                        <TableCell><Input id={`bench-${def.key}-threshold`} type="number" step="0.05" className="w-20 h-8" value={def.threshold} onChange={e => patch(def.key, 'threshold', Number(e.target.value))} /></TableCell>
                        <TableCell><Input id={`bench-${def.key}-pass`} type="number" step="0.5" className="w-16 h-8" value={def.pass} onChange={e => patch(def.key, 'pass', Number(e.target.value))} /></TableCell>
                        <TableCell><Input id={`bench-${def.key}-fail`} type="number" step="0.5" className="w-16 h-8" value={def.fail} onChange={e => patch(def.key, 'fail', Number(e.target.value))} /></TableCell>
                        <TableCell className="text-right font-mono text-xs whitespace-nowrap">{cell(cur)}</TableCell>
                        <TableCell className="text-right font-mono text-xs whitespace-nowrap">{cell(test)}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell colSpan={5} className="font-medium">{t('Fallets poäng (−10 till +10)', 'Case score (−10 to +10)')}</TableCell>
                    <TableCell className="text-right font-mono">{currentScore ? currentScore.points.toFixed(1) : '—'}</TableCell>
                    <TableCell className="text-right font-mono">{testScore ? testScore.points.toFixed(1) : '—'}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => onSaveCriteria(draft)}>{t('Spara kriterier för fallet', 'Save criteria for this case')}</Button>
              <span className="text-xs text-muted-foreground">{t('* krävs för godkänt. Ändringar räknar om alla körningar direkt.', '* required to pass. Changes rescore every run immediately.')}</span>
            </div>
          </div>

          <div className="space-y-3 min-w-0">
            <h3 className="font-medium">{t('Din bedömning', 'Your verdict')}</h3>
            <div className="grid gap-3 md:grid-cols-2">
            {[['current', currentRun, currentScore] as const, ['test', testRun, testScore] as const].map(([which, run, score]) => run && (
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
  const auto = score ? (score.passed ? t('godkänd', 'passes') : t('underkänd', 'fails')) : t('inget resultat', 'no result');
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
