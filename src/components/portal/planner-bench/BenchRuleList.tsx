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
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { resolveRules, type CaseScore, type ResolvedRule } from '@/lib/planner-bench/score';
import { OPPORTUNITY_RULES, type OpportunityFinding, type OpportunityRuleMeta } from '@/lib/planner-bench/opportunities';
import type { BenchSeries, CriteriaOverrides } from '@/lib/planner-bench/types';

const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
// On a phone the rule's name takes its own line above its numbers.
const COLUMNS = 'grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_4rem_9rem_9rem] items-center gap-x-2';
const NAME = 'col-span-3 sm:col-span-1';
const POINTS = 'pl-5 sm:pl-0 sm:text-right';
const LIMIT_KEY = 'can_execute';
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;
// The palette runs −2…+2, as in the chart's score strip.
const scoreColour = (points: number) => points === 0 ? undefined : `var(--plan-score-${points < 0 ? 'n' : 'p'}${Math.min(2, Math.abs(points))})`;

type Side = 'current' | 'test';
interface Range { from: number; to: number }
interface Props {
  current: BenchSeries | null; test: BenchSeries | null;
  currentScore: CaseScore | null; testScore: CaseScore | null;
  draft: CriteriaOverrides; onDraft: (draft: CriteriaOverrides) => void; onSave: () => void;
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
  /** Points per quarter; null for the physical limits, which fail the case instead. */
  perQuarter: number | null;
  required: boolean;
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
  current, test, currentScore, testScore, draft, onDraft, onSave, timeZone, onSelect, range, periodLabel, dayStarts,
}: Props) {
  const { t } = useLanguage();
  const sides = [
    { side: 'current' as const, label: t('Nuvarande', 'Current'), series: current, score: currentScore },
    { side: 'test' as const, label: 'Test', series: test, score: testScore },
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
  const patch = (key: string, field: 'enabled' | 'threshold' | 'points', value: number | boolean) =>
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

  const limitCells = bySide(s => s.score?.audit
    ? counted([...new Set(s.score.audit.violations.map(v => v.quarter))], 0)
    : nothing(t('Saknar underlag', 'Missing evidence')));
  const rows: Row[] = [
    { key: LIMIT_KEY, label: t('Planen kan inte utföras', 'Plan cannot be carried out'), perQuarter: null, required: true, cells: limitCells, triggered: fired(limitCells) },
    ...resolveRules(draft).map((rule): Row => {
      const cells = bySide(s => {
        const application = s.score?.applicability[rule.key];
        return !s.series?.comfort || !s.score ? nothing(t('Saknar underlag', 'Missing evidence'))
          : !rule.enabled ? nothing(t('Av', 'Off'))
            : application && !application.applicable ? nothing('N/A')
              : counted(s.score.quarters.flatMap((q, i) => q.fired.includes(rule.key) ? [i] : []), rule.points);
      });
      return { key: rule.key, label: rule.label, perQuarter: rule.points, required: !!rule.required, cells, triggered: fired(cells), comfort: rule };
    }),
    ...OPPORTUNITY_RULES.map((rule): Row => {
      const cells = bySide(s => {
        const audit = s.score?.audit;
        if (!audit || s.score?.auditPending) return nothing(t('Väntar på omräkning', 'Awaiting rescore'));
        if (audit.status !== 'complete') return nothing(t('Ej bedömd', 'Not assessed'));
        const cell = counted(audit.rules[rule.key].knownQuarters, -1);
        const findings = findingsOf(s, rule.key).length;
        return cell.events.length ? cell
          : findings ? nothing(t(`${findings} fynd · 0 p`, `${findings} found · 0 pts`))
            : audit.applicability[rule.key].applicable ? cell : nothing('N/A');
      });
      return { key: rule.key, label: rule.label, perQuarter: -1, required: false, cells, triggered: fired(cells), energy: rule };
    }),
  ];
  const triggered = rows.filter(row => row.triggered);
  const idle = rows.filter(row => !row.triggered);

  /** Points lost within the period; null while the energy audit is missing. */
  const total = (s: SideData) => {
    if (!s.score) return null;
    const audit = auditOf(s);
    if (!audit) return null;
    const comfort = s.score.quarters.slice(range.from, range.to).reduce((sum, q) => sum + q.score, 0);
    const energy = audit.status === 'complete' ? Object.values(audit.rules).reduce((sum, r) => sum + r.knownQuarters.filter(inRange).length, 0) : 0;
    return comfort - energy;
  };

  const stamp = (s: SideData, quarter: number) => s.series ? formatHomeDayMonthTime(s.series.start[quarter], timeZone) : '';

  const comfortDetail = (rule: ResolvedRule) => {
    const pool = rule.key.startsWith('pool'), above = rule.key === 'pool_hot';
    const comfort = test?.comfort ?? current?.comfort;
    const target = pool ? comfort?.pool_target_c : comfort?.ev_target_km;
    const unit = pool ? '°C' : 'km';
    const level = target === undefined ? null : Number((target + (above ? rule.threshold : -rule.threshold)).toFixed(2));
    return <>
      {level !== null && <p>
        {pool
          ? above ? t(`Poolen är varmare än ${level} ${unit}.`, `The pool is warmer than ${level} ${unit}.`) : t(`Poolen är kallare än ${level} ${unit}.`, `The pool is colder than ${level} ${unit}.`)
          : t(`Bilens räckvidd är under ${level} ${unit}.`, `The car has less than ${level} ${unit} of range.`)}
        {' '}{t(`Målet är ${target} ${unit}.`, `The target is ${target} ${unit}.`)}
        {above && ` ${t('Markeras bara: varmt vatten är lagrad värme och kostar inga poäng.', 'Marked only: warm water is stored heat and costs no points.')}`}
        {rule.required && ` ${t('En enda kvart underkänner fallet.', 'A single quarter fails the case.')}`}
        {!above && ` ${t('Räknas först ett dygn efter att nivån gick att nå.', 'Counts only from a day after the level could be reached.')}`}
      </p>}
      {sides.map(s => {
        const application = s.score?.applicability[rule.key];
        return application && !application.applicable && <p key={s.side} className="text-muted-foreground">{s.label}: {application.reason}</p>;
      })}
      {!above && <div className="flex flex-wrap items-end gap-3 pt-1">
        <label className="flex items-center gap-2 text-xs" htmlFor={`bench-${rule.key}-on`}><Switch id={`bench-${rule.key}-on`} checked={rule.enabled} onCheckedChange={v => patch(rule.key, 'enabled', v)} />{t('På', 'On')}</label>
        <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-threshold`}><span>{t('Avstånd från mål', 'Distance from target')} ({unit})</span><Input id={`bench-${rule.key}-threshold`} className="h-8 w-28" type="number" min="0" step="0.1" value={rule.threshold} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber >= 0) patch(rule.key, 'threshold', e.target.valueAsNumber); }} /></label>
        <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-points`}><span>{t('Poäng per kvart', 'Points per quarter')}</span><Input id={`bench-${rule.key}-points`} className="h-8 w-28" type="number" min="-2" max="0" step="1" value={rule.points} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber <= 0) patch(rule.key, 'points', Math.max(-2, Math.round(e.target.valueAsNumber))); }} /></label>
        <Button size="sm" variant="outline" onClick={onSave}>{t('Spara regler för fallet', 'Save rules for this case')}</Button>
      </div>}
    </>;
  };

  const energyDetail = (rule: OpportunityRuleMeta) => {
    const shown = witness?.rule === rule.key ? sides.find(s => s.side === witness.side) : undefined;
    const finding = shown && findingsOf(shown, rule.key).find(f => f.id === witness?.id);
    return <>
      <p>{rule.description} {t('−1 poäng för varje kvart som en billigare flytt hade ändrat, när priserna redan var publicerade.', '−1 point for each quarter a cheaper move would have changed, where prices were already published.')}</p>
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
            <span><strong>{f.savingSek.toFixed(2)} SEK</strong> · {f.basis === 'known' ? t('känt i förväg', 'known in advance') : t('efterklokhet · 0 p', 'hindsight · 0 pts')}</span>
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

  const cellText = (row: Row, cell: Cell) => cell.note ?? (!cell.events.length ? '—'
    : row.perQuarter === null ? `${cell.events.length} ${t('kv', 'q')}`
      : `${cell.events.length} ${t('kv', 'q')} · ${signed(cell.points)}`);

  const renderRow = (row: Row) => {
    const expanded = open.has(row.key);
    return <div key={row.key} id={`bench-rule-${row.key}`} className="border-b last:border-0">
      <button type="button" aria-expanded={expanded} onClick={() => toggle(row.key)}
        className={`${COLUMNS} w-full py-2 text-left text-sm hover:bg-muted/50 ${focus}`}>
        <span className={`${NAME} flex min-w-0 items-center gap-1.5`}>
          <ChevronRight aria-hidden="true" className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <span className="min-w-0">{row.label}{row.required && row.perQuarter !== null && <span className="text-xs text-muted-foreground"> · {t('krav', 'required')}</span>}</span>
        </span>
        <span className={`${POINTS} font-mono font-semibold tabular-nums`} style={{ color: row.perQuarter === null ? undefined : scoreColour(row.perQuarter) }}>
          {row.perQuarter === null ? <span className="text-destructive">{t('Fel', 'Fail')}</span> : signed(row.perQuarter)}
        </span>
        {(['current', 'test'] as const).map(side => <span key={side} className={`text-right font-mono text-xs tabular-nums ${row.cells[side].events.length ? '' : 'text-muted-foreground'}`}>{cellText(row, row.cells[side])}</span>)}
      </button>
      {expanded && <div className="mb-2 ml-5 space-y-2 rounded-md bg-muted/40 p-3 text-sm min-w-0">
        {row.comfort ? comfortDetail(row.comfort) : row.energy ? energyDetail(row.energy) : <>
          <p>{t('Planen ber om något hushållet inte kan göra: effektgränser, lagringsgränser eller ogiltiga beslut. En enda överträdelse underkänner fallet, oavsett poäng.', 'The plan asks for something the household cannot do: power limits, storage limits or invalid decisions. A single violation fails the case, whatever its points.')}</p>
          {sides.map(s => {
            const kinds = [...new Set(s.score?.audit?.violations.filter(v => inRange(v.quarter)).map(v => v.kind) ?? [])];
            return kinds.length > 0 && <p key={s.side} className="text-muted-foreground">{s.label}: {kinds.map(kind => kind.replace(/_/g, ' ')).join(' · ')}</p>;
          })}
        </>}
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
        <span className={POINTS}>{t('P/kvart', 'Pts/q')}</span>
        <span className="text-right">{t('Nuvarande', 'Current')}</span>
        <span className="text-right">Test</span>
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
        <p className="py-2 text-xs text-muted-foreground">{t('Bilen antas alltid ansluten. Avgångar, frånvaro, rumsvärme, varmvattenstyrning, korta moln, prognosrisk, effekttariffer, startkostnader och körskydd ingår inte. Att ingen förlust hittades betyder inte att planen är optimal.', 'The car is always considered plugged in. Departures, absence, room heating, hot water control, brief clouds, forecast risk, peak tariffs, equipment start costs and run protection are not modelled. No loss found does not mean the plan is optimal.')}</p>
      </div>}
    </div>
  </section>;
}
