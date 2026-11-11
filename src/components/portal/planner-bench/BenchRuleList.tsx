// The scoring rules of one case as a list: one row per rule, with the points
// it takes per quarter and how many quarters it fired in for each planner,
// counted over the period the plan chart shows. Clicking a row opens what
// explains it; rules that did not fire in the period sit in their own section.

import React, { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import PoolComfortRuleInfo from '../energy/PoolComfortRuleInfo';
import { signedPoints as signed } from '../energy/plan/quarter-score';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { RULE_POINTS_MAX, RULE_POINTS_MIN, resolveRules, type CaseScore, type ResolvedRule } from '@/lib/planner-bench/score';
import { OPPORTUNITY_RULES, type OpportunityFinding, type OpportunityRuleMeta } from '@/lib/planner-bench/opportunities';
import type { BenchSeries, CriteriaOverrides } from '@/lib/planner-bench/types';

const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
// On a phone the rule's name takes its own line above its numbers.
const COLUMNS = 'grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_4rem_9rem_9rem] items-center gap-x-2';
const NAME = 'col-span-3 sm:col-span-1';
const POINTS = 'pl-5 sm:pl-0 sm:text-right';
// The palette runs −2…+2, as in the chart's score strip.
const scoreColour = (points: number) => points === 0 ? undefined : `var(--plan-score-${points < 0 ? 'n' : 'p'}${Math.min(2, Math.ceil(Math.abs(points)))})`;

type Side = 'current' | 'test';
interface Range { from: number; to: number }
interface Props {
  current: BenchSeries | null; test: BenchSeries | null;
  currentScore: CaseScore | null; testScore: CaseScore | null;
  /** What each planner goes by: its branch, or its commit. */
  names: Record<Side, string>;
  /** The rules, the same for every case and planner; `unsaved` while a change is only being tried here. */
  draft: CriteriaOverrides; onDraft: (draft: CriteriaOverrides) => void; onSave: () => void; unsaved: boolean;
  timeZone: string; onSelect: (side: Side, quarter: number) => void;
  /** The quarters the plan chart shows, its label, and where a new day starts. */
  range: Range; periodLabel: string; dayStarts: number[];
}

/** What a rule did for one planner within the period. */
interface Cell {
  /** Quarters it fired in. */
  events: number[];
  points: number;
  /** Why there is nothing to count, or what there is instead of points. */
  note: string | null;
}

interface Row {
  key: string;
  label: string;
  perQuarter: number;
  cells: Record<Side, Cell>;
  triggered: boolean;
  comfort?: ResolvedRule;
  energy?: OpportunityRuleMeta;
}

/** Where a rule fired within the period; the number beside it is the exact count. */
function EventStrip({ label, events, range, dayStarts, onSelect }: {
  label: string; events: number[]; range: Range; dayStarts: number[]; onSelect: (quarter: number) => void;
}) {
  const { t } = useLanguage();
  const length = Math.max(1, range.to - range.from);
  const x = (i: number) => (i - range.from) / length * 288;
  return <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_4rem] items-center gap-x-2 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <button type="button" disabled={!events.length} onClick={() => onSelect(events[0])}
      aria-label={`${label}: ${events.length} ${t('kvartar', 'quarters')}. ${t('Visa den första i diagrammet', 'Show the first in the chart')}`}
      className={`min-h-6 w-full text-destructive ${focus} disabled:cursor-default`}>
      <svg viewBox="0 0 288 12" preserveAspectRatio="none" className="w-full h-3" aria-hidden="true">
        <rect width="288" height="12" rx="2" className="fill-muted" />
        {dayStarts.filter(i => i > range.from && i < range.to).map(i => <line key={i} x1={x(i)} x2={x(i)} y1="0" y2="12" className="stroke-muted-foreground" strokeDasharray="2 2" />)}
        {events.map(i => <rect key={i} x={x(i)} y="1" width={Math.max(1, 288 / length)} height="10" fill="currentColor" />)}
      </svg>
    </button>
    <span className="justify-self-end font-mono tabular-nums">{events.length} {t('kv', 'q')}</span>
  </div>;
}

/** A store with and without one finding's move. Solid and dashed work without colour. */
function WitnessPlot({ before, after, from, to, unit, label }: {
  before: number[]; after: number[]; from: number; to: number; unit: string; label: string;
}) {
  const { t } = useLanguage();
  const values = [...before, ...after];
  const lo = Math.min(...values), hi = Math.max(...values), pad = Math.max((hi - lo) * .15, .1);
  const x = (i: number) => 46 + i / Math.max(1, before.length - 1) * 510;
  const y = (v: number) => 120 - (v - lo + pad) / (hi - lo + 2 * pad) * 100;
  const path = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  return <div className="min-w-0">
    <div className="flex flex-wrap justify-between gap-2 text-xs mb-1">
      <span className="font-medium">{label} · {unit}</span>
      <span>{t('━━ Plan · ┄┄ Alternativ', '━━ Plan · ┄┄ Alternative')}</span>
    </div>
    <svg viewBox="0 0 600 152" role="img" aria-label={`${label}: ${t('plan och möjligt alternativ', 'plan and feasible alternative')}`} className="w-full text-foreground">
      <text x="2" y="27" fontSize="12" fill="currentColor">{hi.toFixed(1)}</text>
      <text x="2" y="124" fontSize="12" fill="currentColor">{lo.toFixed(1)}</text>
      <line x1="46" x2="556" y1="120" y2="120" className="stroke-border" />
      <path d={path(before)} fill="none" stroke="currentColor" strokeWidth="2" />
      <path d={path(after)} fill="none" className="stroke-primary" strokeWidth="2.5" strokeDasharray="6 4" />
      {[[from, t('Från', 'From')], [to, t('Till', 'To')]].map(([i, text]) => <g key={text}>
        <line x1={x(Number(i))} x2={x(Number(i))} y1="12" y2="125" className="stroke-muted-foreground" strokeDasharray="2 4" />
        <text x={x(Number(i))} y="145" textAnchor="middle" fontSize="12" fill="currentColor">{text}</text>
      </g>)}
    </svg>
  </div>;
}

export default function BenchRuleList({
  current, test, currentScore, testScore, names, draft, onDraft, onSave, unsaved, timeZone, onSelect, range, periodLabel, dayStarts,
}: Props) {
  const { t } = useLanguage();
  const sides = [
    { side: 'current' as const, label: names.current, series: current, score: currentScore },
    { side: 'test' as const, label: names.test, series: test, score: testScore },
  ];
  type SideData = typeof sides[number];
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showIdle, setShowIdle] = useState(false);
  const [witness, setWitness] = useState<{ rule: string; side: Side; id: string } | null>(null);
  useEffect(() => {
    if (witness) document.getElementById('bench-witness')?.focus();
  }, [witness]);
  const toggle = (key: string) => setOpen(previous => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const patch = (key: string, field: 'enabled' | 'points', value: number | boolean) =>
    onDraft({ ...draft, [key]: { ...draft[key], [field]: value } });

  const inRange = (i: number) => i >= range.from && i < range.to;
  const counted = (events: number[], perQuarter: number): Cell => {
    const within = events.filter(inRange);
    return { events: within, points: within.length * perQuarter, note: null };
  };
  const nothing = (note: string): Cell => ({ events: [], points: 0, note });
  const bySide = (cell: (s: SideData) => Cell) => ({ current: cell(sides[0]), test: cell(sides[1]) });
  const fired = (cells: Record<Side, Cell>) => cells.current.events.length + cells.test.events.length > 0;
  const auditOf = (s: SideData) => s.score?.audit && !s.score.auditPending ? s.score.audit : null;
  /** A rule's findings that take energy from, or put it in, the period shown. */
  const findingsOf = (s: SideData, rule: string): OpportunityFinding[] => auditOf(s)?.findings.filter(f =>
    (f.tags as string[]).includes(rule) && ((f.from < range.to && f.fromEnd >= range.from) || (f.to < range.to && f.toEnd >= range.from))) ?? [];

  const rows: Row[] = [
    ...resolveRules(draft).map((rule): Row => {
      const cells = bySide(s => {
        const application = s.score?.applicability[rule.key];
        if (!s.score || !s.series?.comfort) return nothing(t('Saknar underlag', 'Missing evidence'));
        if (!rule.enabled) return nothing(t('Av', 'Off'));
        if (application && !application.applicable) return nothing('N/A');
        const cell = counted(s.score.quarters.flatMap((q, i) => q.fired.includes(rule.key) ? [i] : []), rule.points);
        const points = s.score.quarters.reduce((sum, q, i) => sum + (inRange(i) ? q.deductions[rule.key] ?? 0 : 0), 0);
        return { ...cell, points };
      });
      return { key: rule.key, label: rule.label, perQuarter: rule.points, cells, triggered: fired(cells), comfort: rule };
    }),
    ...OPPORTUNITY_RULES.map((rule): Row => {
      const cells = bySide(s => {
        const audit = s.score?.audit;
        if (!audit || s.score?.auditPending) return nothing(t('Väntar på omräkning', 'Awaiting rescore'));
        if (audit.status !== 'complete') return nothing(t('Ej bedömd', 'Not assessed'));
        const cell = counted(audit.rules[rule.key].knownQuarters, 0);
        const found = findingsOf(s, rule.key);
        // The row says what its own known findings are worth; the money is on the bill already.
        const sek = found.filter(f => f.rule === rule.key && f.basis === 'known').reduce((sum, f) => sum + f.savingSek, 0);
        return cell.events.length ? { ...cell, note: `${cell.events.length} ${t('kv', 'q')} · ${sek.toFixed(2)} kr` }
          : found.length ? nothing(t(`${found.length} fynd`, `${found.length} found`))
            : audit.applicability[rule.key].applicable ? cell : nothing('N/A');
      });
      return { key: rule.key, label: rule.label, perQuarter: 0, cells, triggered: sides.some(s => findingsOf(s, rule.key).length > 0), energy: rule };
    }),
  ];
  const triggered = rows.filter(row => row.triggered);
  const idle = rows.filter(row => !row.triggered);

  /** What the deductions took within the period; null while the audit their witnesses come from is missing. */
  const total = (s: SideData) => {
    if (!s.score || !auditOf(s)) return null;
    return s.score.quarters.slice(range.from, range.to).reduce((sum, q) => sum + q.score, 0);
  };

  const stamp = (s: SideData, quarter: number) => s.series ? formatHomeDayMonthTime(s.series.start[quarter], timeZone) : '';

  const settings = (rule: ResolvedRule) => {
    const smooth = rule.key === 'pool_shortfall';
    const lo = smooth ? undefined : RULE_POINTS_MIN, hi = smooth ? -.001 : RULE_POINTS_MAX;
    return <div className="flex flex-wrap items-end gap-3 pt-1">
      <label className="flex items-center gap-2 text-xs" htmlFor={`bench-${rule.key}-on`}><Switch id={`bench-${rule.key}-on`} checked={rule.enabled} onCheckedChange={v => patch(rule.key, 'enabled', v)} />{t('På', 'On')}</label>
      <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-points`}><span>{smooth ? t('Kostnad (SEK/°C·h)', 'Cost (SEK/°C·h)') : t('Regelvikt', 'Rule weight')}</span><Input id={`bench-${rule.key}-points`} className="h-8 w-28" type="number" min={smooth ? 0 : lo} max={smooth ? undefined : hi} step={smooth ? "0.1" : "1"} value={smooth ? -rule.points : rule.points} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) { const points = smooth ? -Math.abs(e.target.valueAsNumber) : Math.max(RULE_POINTS_MIN, Math.min(RULE_POINTS_MAX, Math.round(e.target.valueAsNumber))); if (points !== 0) patch(rule.key, 'points', points); } }} /></label>
      <Button size="sm" variant="outline" disabled={!unsaved} onClick={onSave}>{t('Spara regler', 'Save rules')}</Button>
      <span className="basis-full text-xs text-muted-foreground">{t('Reglerna gäller alla testfall och alla planerare. Att spara räknar om alla poäng.', 'Rules apply to every test case and every planner. Saving rescores everything.')}</span>
    </div>;
  };

  const comfortDetail = (rule: ResolvedRule) => {
    if (rule.key === 'car_floor') return <>
      <p>
        {t('Laddmålet stiger en procentenhet per timme och når bilens laddgräns efter 60 timmar. Avdraget beror på hur långt under målet bilen ligger och är större vid låg laddnivå.',
          'The charge target rises by one percentage point per hour and reaches the car’s charge limit after 60 hours. The deduction grows with the shortfall and is steeper at low charge.')}
        {' '}{t('I bänken räknas bilen som inkopplad när fallet börjar.', 'On the bench the car counts as plugged in when the case starts.')}
      </p>
      {sides.map(s => {
        const application = s.score?.applicability[rule.key];
        return application && !application.applicable && <p key={s.side} className="text-muted-foreground">{s.label}: {application.reason}</p>;
      })}
      {settings(rule)}
    </>;
    return <>
      <PoolComfortRuleInfo coefficient={-rule.points} />
      {settings(rule)}
    </>;
  };

  const ruleLabel = (key: string) => OPPORTUNITY_RULES.find(r => r.key === key)?.label ?? key;
  const energyDetail = (rule: OpportunityRuleMeta) => {
    const shown = witness?.rule === rule.key ? sides.find(s => s.side === witness.side) : undefined;
    const finding = shown && findingsOf(shown, rule.key).find(f => f.id === witness?.id);
    return <>
      <p>{rule.description} {t('Visas i kronor och ger inga poängavdrag: pengarna finns redan på elräkningen.', 'Shown in kronor; it takes no points: the money is on the bill already.')}</p>
      <p className="text-xs text-muted-foreground">{t('Efterklokhet: flytten krävde priser som inte var publicerade när planen gjordes. En flytt som passar flera regler räknas under en enda.', 'Hindsight: the move needed prices that were not published when the plan was made. A move that fits several rules is counted under one only.')}</p>
      {sides.map(s => {
        const audit = s.score?.audit;
        const application = audit?.applicability[rule.key];
        return application && !application.applicable && <p key={s.side} className="text-muted-foreground">{s.label}: {application.reason}</p>;
      })}
      {sides.map(s => {
        const findings = findingsOf(s, rule.key);
        return findings.length > 0 && <div key={s.side} className="space-y-1">
          <div className="text-xs text-muted-foreground">{s.label}: {t('billigare flyttar som hittades', 'cheaper moves found')}</div>
          {findings.map(f => <button type="button" key={f.id} aria-pressed={witness?.rule === rule.key && witness.side === s.side && witness.id === f.id}
            onClick={() => { setWitness({ rule: rule.key, side: s.side, id: f.id }); onSelect(s.side, f.from); }}
            className={`flex w-full flex-wrap justify-between gap-x-3 rounded-md border bg-background px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10 ${focus}`}>
            <span>{f.kwh.toFixed(2)} kWh · {stamp(s, f.from)} → {stamp(s, f.to)}</span>
            <span><strong>{f.savingSek.toFixed(2)} SEK</strong> · {f.basis === 'hindsight' ? t('efterklokhet · 0 p', 'hindsight · 0 pts')
              : f.rule === rule.key ? t('känt i förväg', 'known in advance')
                : t(`känt i förväg · räknas under ”${ruleLabel(f.rule)}”`, `known in advance · counted under “${ruleLabel(f.rule)}”`)}</span>
          </button>)}
        </div>;
      })}
      {finding && shown?.series && <div id="bench-witness" tabIndex={-1} className={`rounded-md border border-primary bg-background p-3 space-y-2 min-w-0 ${focus}`} aria-live="polite">
        <div className="font-medium">{shown.label} · {finding.kwh.toFixed(2)} kWh → {finding.savingSek.toFixed(2)} SEK {t('sparat', 'saved')}</div>
        <WitnessPlot before={finding.device === 'pool' ? finding.before.poolC : finding.device === 'ev' ? finding.before.carKm : finding.before.homeSoc}
          after={finding.device === 'pool' ? finding.after.poolC : finding.device === 'ev' ? finding.after.carKm : finding.after.homeSoc}
          from={finding.from} to={finding.to} unit={finding.device === 'pool' ? '°C' : finding.device === 'ev' ? 'km' : '%'} label={finding.device === 'pool' ? 'Pool' : finding.device === 'ev' ? t('Bil', 'Car') : t('Batteri', 'Battery')} />
        <div className="text-xs text-muted-foreground">{t('Nätbesparing', 'Grid saving')}: {finding.gridSavingSek.toFixed(2)} SEK {finding.wearSek < 0 ? `+ ${t('sparat slitage', 'avoided wear')}` : `− ${t('slitage', 'wear')}`}: {Math.abs(finding.wearSek).toFixed(2)} SEK</div>
        <div className="flex flex-wrap gap-2">
          {([['from', t('Från', 'From')], ['to', t('Till', 'To')]] as const).map(([key, label]) => <Button key={key} variant="outline" size="sm" onClick={() => onSelect(shown.side, finding[key])}>{label}: {stamp(shown, finding[key])}</Button>)}
        </div>
      </div>}
    </>;
  };

  const cellText = (cell: Cell) => cell.note ?? (!cell.events.length ? '—'
    : `${cell.events.length} ${t('kv', 'q')} · ${signed(cell.points)}`);

  const renderRow = (row: Row) => {
    const expanded = open.has(row.key);
    return <div key={row.key} id={`bench-rule-${row.key}`} className="border-b last:border-0">
      <button type="button" aria-expanded={expanded} onClick={() => toggle(row.key)}
        className={`${COLUMNS} w-full py-2 text-left text-sm hover:bg-muted/50 ${focus}`}>
        <span className={`${NAME} flex min-w-0 items-center gap-1.5`}>
          <ChevronRight aria-hidden="true" className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <span className="min-w-0">{row.label}{row.comfort?.required && <span className="text-xs text-muted-foreground"> · {t('krav', 'required')}</span>}</span>
        </span>
        <span className={`${POINTS} font-mono font-semibold tabular-nums`} style={{ color: row.energy ? undefined : scoreColour(row.perQuarter) }}>
          {row.energy ? <span className="text-xs font-normal text-muted-foreground">kr</span> : <>{signed(row.perQuarter)}{row.key === 'pool_shortfall' && <span className="block text-xs font-normal">/°C·h</span>}</>}
        </span>
        {(['current', 'test'] as const).map(side => <span key={side} className={`text-right font-mono text-xs tabular-nums ${row.cells[side].events.length ? '' : 'text-muted-foreground'}`}>{cellText(row.cells[side])}</span>)}
      </button>
      {expanded && <div className="mb-2 ml-5 space-y-2 rounded-md bg-muted/40 p-3 text-sm min-w-0">
        {row.comfort ? comfortDetail(row.comfort) : row.energy && energyDetail(row.energy)}
        {row.triggered && <div className="space-y-1 pt-1">
          {sides.map(s => <EventStrip key={s.side} label={s.label} events={row.cells[s.side].events} range={range} dayStarts={dayStarts} onSelect={q => onSelect(s.side, q)} />)}
        </div>}
      </div>}
    </div>;
  };

  return <section id="bench-rules" className="space-y-3 min-w-0" aria-label={t('Poängregler', 'Scoring rules')}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-medium">{t('Poängregler', 'Scoring rules')} <span className="text-sm font-normal text-muted-foreground">· {periodLabel}</span></h3>
      <span id="bench-rules-total" className="font-mono text-sm tabular-nums">
        {sides.map(s => { const points = total(s); return `${s.label} ${points === null ? '—' : signed(points)}`; }).join(' · ')}
      </span>
    </div>
    {sides.map(s => !s.score?.audit || s.score.auditPending
      ? <p key={s.side} className="text-sm text-muted-foreground">{s.label}: {t('Saknar underlag för energireglerna · räkna om poängen', 'Missing evidence for the energy rules · recompute scores')}</p>
      : s.score.audit.status !== 'complete' && <p key={s.side} className="text-sm text-destructive">{s.label}: {s.score.audit.reason}</p>)}

    <div>
      <div className={`${COLUMNS} border-b pb-1 text-xs text-muted-foreground`}>
        <span className={`${NAME} pl-5`}>{t('Regel', 'Rule')}</span>
        <span className={POINTS}>{t('Kostnad', 'Cost')}</span>
        <span className="truncate text-right">{names.current}</span>
        <span className="truncate text-right">{names.test}</span>
      </div>
      {triggered.map(renderRow)}
      {!triggered.length && <p className="py-3 text-sm text-muted-foreground">{t('Ingen regel slog till i perioden.', 'No rule triggered in this period.')}</p>}
    </div>

    <div id="bench-untriggered-rules">
      <button type="button" aria-expanded={showIdle} onClick={() => setShowIdle(v => !v)}
        className={`flex w-full items-center gap-1.5 py-2 text-left text-sm font-medium ${focus}`}>
        <ChevronRight aria-hidden="true" className={`h-4 w-4 text-muted-foreground transition-transform ${showIdle ? 'rotate-90' : ''}`} />
        {t('Regler som inte slog till', 'Untriggered rules')} <span className="font-normal text-muted-foreground">({idle.length})</span>
      </button>
      {showIdle && <div className="border-t">
        {idle.map(renderRow)}
        <p className="py-2 text-xs text-muted-foreground">{t('Bilen antas alltid ansluten. Avgångar, frånvaro, rumsvärme, korta moln, prognosrisk och effekttariffer ingår inte. Att ingen förlust hittades betyder inte att planen är optimal.', 'The car is always considered plugged in. Departures, absence, room heating, brief clouds, forecast risk and peak tariffs are not modelled. No loss found does not mean the plan is optimal.')}</p>
      </div>}
    </div>
  </section>;
}
