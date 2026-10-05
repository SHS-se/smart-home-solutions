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
import { AHEAD_MARGIN, CHEAP_CHARGE_BATTERY_SOC, DEAR_RULE_KEYS, FLEXIBLE_W, RULE_POINTS_MAX, RULE_POINTS_MIN, arbitragePreparation, resolveRules, type CaseScore, type ResolvedRule } from '@/lib/planner-bench/score';
import { OPPORTUNITY_RULES, type OpportunityFinding, type OpportunityRuleMeta } from '@/lib/planner-bench/opportunities';
import { SHORT_GAP_PRICE_FRACTION } from '@/lib/planner-bench/short-gaps';
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
  current, test, currentScore, testScore, draft, onDraft, onSave, unsaved, timeZone, onSelect, range, periodLabel, dayStarts,
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
        return (rule.about !== 'price' && !s.series?.comfort) || !s.score ? nothing(t('Saknar underlag', 'Missing evidence'))
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

  /** A quarter rule's settings: on or off, its threshold and its points, saved for the case. */
  const settings = (rule: ResolvedRule, thresholdLabel: string, step: string) => {
    const lo = RULE_POINTS_MIN, hi = RULE_POINTS_MAX;
    return <div className="flex flex-wrap items-end gap-3 pt-1">
      <label className="flex items-center gap-2 text-xs" htmlFor={`bench-${rule.key}-on`}><Switch id={`bench-${rule.key}-on`} checked={rule.enabled} onCheckedChange={v => patch(rule.key, 'enabled', v)} />{t('På', 'On')}</label>
      <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-threshold`}><span>{thresholdLabel}</span><Input id={`bench-${rule.key}-threshold`} className="h-8 w-28" type="number" min="0" step={step} value={rule.threshold} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber >= 0) patch(rule.key, 'threshold', e.target.valueAsNumber); }} /></label>
      <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-points`}><span>{t('Poäng per kvart', 'Points per quarter')}</span><Input id={`bench-${rule.key}-points`} className="h-8 w-28" type="number" min={lo} max={hi} step="1" value={rule.points} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) { const points = Math.max(lo, Math.min(hi, Math.round(e.target.valueAsNumber))); if (points !== 0) patch(rule.key, 'points', points); } }} /></label>
      <Button size="sm" variant="outline" disabled={!unsaved} onClick={onSave}>{t('Spara regler', 'Save rules')}</Button>
      <span className="basis-full text-xs text-muted-foreground">{t('Reglerna gäller alla testfall och alla planerare. Att spara räknar om alla poäng.', 'Rules apply to every test case and every planner. Saving rescores everything.')}</span>
    </div>;
  };

  const priceDetail = (rule: ResolvedRule) => {
    if (rule.key === 'arbitrage_no_export' || rule.key === 'arbitrage_not_full') {
      const preparationRule = rule.key === 'arbitrage_not_full';
      return <>
        <p>{preparationRule
          ? t(`Varje kvart med säljpris över ${rule.threshold} SEK/kWh ger avdrag om den sista laddningen före den första sådana kvarten inte slutade på 100%. Om ingen laddning gjordes räknas ett fullt batteri vid testfallets början. Urladdning efter den fulla laddningen är tillåten.`,
            `Every quarter with a sale price above ${rule.threshold} SEK/kWh loses a point if the last charge before the first such quarter did not finish at 100%. If there was no charge, a full battery at the case start counts. Discharge after that full charge is allowed.`)
          : t(`Varje kvart med säljpris över ${rule.threshold} SEK/kWh ger avdrag om ingen energi exporteras till nätet. All positiv export räknas, från batteriet eller solen, utan minsta energimängd.`,
            `Every quarter with a sale price above ${rule.threshold} SEK/kWh loses a point if no energy is exported to the grid. Any positive export counts, from battery or solar, with no minimum energy amount.`)}</p>
        <p className="text-xs text-muted-foreground">{preparationRule
          ? t('Förberedelsen bedöms en gång före den första möjligheten i hela testfallet. En senare delvis full laddning före den första möjligheten ersätter en tidigare full laddning. Laddning under eller efter den första möjligheten tar inte bort avdragen. Även åtskilda senare högpriskvartar räknas.',
            'Preparation is assessed once before the first opportunity in the whole case. A later partial charge before that opportunity replaces an earlier full charge. Charging during or after the first opportunity does not remove the penalties. Separated later high-price quarters also count.')
          : t('Exporten behöver inte vara lika stor i varje kvart. Den mest lönsamma kvarten kan få mest energi.',
            'Export does not have to be equal across quarters. The most profitable quarter can receive the most energy.')}</p>
        <p className="text-xs text-muted-foreground">{t('Verkliga säljpriser används, även opublicerade. De två arbitrageavdragen är oberoende och kan tillsammans ge −2 per kvart.',
          'Actual sale prices are used, including unpublished prices. The two arbitrage deductions are independent and can total −2 per quarter.')}</p>
        {preparationRule && sides.map(s => {
          if (!s.series) return null;
          const preparation = arbitragePreparation(s.series, rule.threshold);
          if (preparation.firstQuarter < 0) return null;
          const soc = preparation.lastChargeQuarter === null ? s.series.homeStartSoc : s.series.homeSoc[preparation.lastChargeQuarter];
          return <div key={s.side} className="flex flex-wrap items-center gap-2 text-xs">
            <span>{s.label} · {preparation.prepared ? t('Förberett', 'Prepared') : t('Inte förberett', 'Not prepared')} · {soc === null ? '—' : `${soc}%`}</span>
            <span>{preparation.lastChargeQuarter === null ? t('Testfallets början', 'Case start') : t('Sista laddning', 'Last charge')}</span>
            {preparation.lastChargeQuarter !== null && <Button size="sm" variant="outline" onClick={() => onSelect(s.side, preparation.lastChargeQuarter!)}>{stamp(s, preparation.lastChargeQuarter)}</Button>}
            <span>→ {t('Första möjlighet', 'First opportunity')}</span>
            <Button size="sm" variant="outline" onClick={() => onSelect(s.side, preparation.firstQuarter)}>{stamp(s, preparation.firstQuarter)}</Button>
          </div>;
        })}
        {settings(rule, t('Säljpris över (SEK/kWh)', 'Sale price above (SEK/kWh)'), '0.01')}
      </>;
    }
    if (rule.key === 'missed_cheap_quarter') return <>
      <p>{t(`En kvart ger avdrag när inköpspriset är under ${rule.threshold} SEK/kWh och ett flexibelt lager är under sitt mål, men ingen last under målet drar minst ${FLEXIBLE_W} W. Bilens räckvidd och poolens temperatur jämförs med komfortmålen; hembatteriets mål är ${CHEAP_CHARGE_BATTERY_SOC}% laddning.`,
        `A quarter loses a point when the purchase price is below ${rule.threshold} SEK/kWh and a flexible store is below its target, but no below-target device draws at least ${FLEXIBLE_W} W. EV range and pool temperature use their comfort targets; the home battery target is ${CHEAP_CHARGE_BATTERY_SOC}% charge.`)}</p>
      <p className="text-xs text-muted-foreground">{t('Högst ett avdrag per kvart. Även en ensam billig kvart räknas, från planens början och vid verkliga priser, även opublicerade. Lagernivåer mäts vid kvartens slut. En enda last under målet med tillräcklig effekt undviker avdraget.',
        'At most one deduction per quarter. Isolated cheap quarters count from the start of the plan, at actual prices including unpublished prices. Store levels are measured at the end of the quarter. One below-target device drawing enough power avoids the deduction.')}</p>
      {settings(rule, t('Inköpspris under (SEK/kWh)', 'Purchase price below (SEK/kWh)'), '0.01')}
    </>;
    const gapDevice = rule.key === 'ev_short_gap' ? 'ev' : rule.key === 'pool_short_gap' ? 'pool' : null;
    if (gapDevice) return <>
      <p>{t(`Ett avdrag per avbrott på 1–4 kvartar i ${gapDevice === 'ev' ? 'billaddning' : 'poolvärme'}. Lasten måste vara igång direkt före och efter avbrottet. Varje avbrottskvart jämförs med båda angränsande driftkvartarna. Tillåten prisskillnad är det större av ${Math.round(rule.threshold * 100)} öre/kWh eller ${SHORT_GAP_PRICE_FRACTION * 100}% av avbrottskvartens absoluta pris. Nollpris använder öresgränsen; vid negativa priser används prisets storlek utan minustecknet.`,
        `One deduction per 1–4-quarter interruption in ${gapDevice === 'ev' ? 'EV charging' : 'pool heating'}. The device must run immediately before and after the gap. Each gap quarter is compared with both bordering running quarters. The allowed price difference is the larger of ${Math.round(rule.threshold * 100)} öre/kWh or ${SHORT_GAP_PRICE_FRACTION * 100}% of that gap quarter's absolute price. Zero prices use the öre threshold; negative prices use their magnitude without the minus sign.`)}</p>
      <p>{t('Avdrag ges bara när befintlig energi kan flyttas inom de två angränsande driftperioderna och avbrottet till en sammanhängande period, med tillåtna effektnivåer, oförsämrad service och oförminskade slutlager. Detta är en preferens för sammanhängande drift, inte ett påstående om lägre elkostnad. Alternativen prövas var för sig mot originalplanen vid verkliga priser.',
        'A penalty requires an alternative that rearranges existing energy within the two adjacent runs and their gap into one continuous run, with legal power levels, unchanged or better service and no reduction in final stores. This is a preference for continuous operation, not a claim of bill savings. Alternatives are tested independently against the original plan at actual prices.')}</p>
      {sides.map(s => auditOf(s)?.shortGaps.gaps.filter(g => g.device === gapDevice && inRange(g.from)).map(g => <div key={`${s.side}-${g.from}`} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>{s.label} · {g.to - g.from} {t('kvartar', 'quarters')}</span>
          <Button size="sm" variant="outline" onClick={() => onSelect(s.side, g.from)}>{stamp(s, g.from)}</Button>
          <span>→</span>
          <Button size="sm" variant="outline" onClick={() => onSelect(s.side, g.to)}>{stamp(s, g.to)}</Button>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer">{t('Möjlig sammanhängande drift', 'Feasible continuous run')}</summary>
          <ul className="mt-1 space-y-1 font-mono">{g.changes.map(change => <li key={change.quarter}>
            {stamp(s, change.quarter)}: {(change.beforeW / 1000).toFixed(2)} → {(change.afterW / 1000).toFixed(2)} kW
          </li>)}</ul>
        </details>
      </div>))}
      {settings(rule, t('Minsta pristolerans (SEK/kWh)', 'Minimum price tolerance (SEK/kWh)'), '0.01')}
    </>;
    if (rule.key === 'ev_from_home_battery') return <>
      <p>{t(`En kvart ger avdrag när mer än ${rule.threshold} W från hembatteriet tillskrivs billaddning. Batteriet får försörja baslast, pool och andra laster samtidigt som bilen laddas. Vi räknar först bort samtidig batteriladdning och export, och tilldelar sedan batteriets effekt till alla andra hushållslaster före bilen. Bara det som återstår för bilen ger avdrag.`,
        `A quarter loses a point when more than ${rule.threshold} W from the home battery is attributed to EV charging. The battery may supply base load, pool and other loads while the car charges. We first subtract simultaneous battery charging and exports, then assign battery power to all other household loads before the car. Only the remainder supplying the car triggers the rule.`)}</p>
      <p className="text-xs text-muted-foreground">{t('Ett avdrag per kvart, oavsett energimängd, pris eller om en billigare flytt finns. Detta är en fördelningsregel för hushållets gemensamma elanslutning.',
        'One deduction per quarter, regardless of energy amount, price or whether a cheaper move exists. This is an allocation convention for the shared house connection.')}</p>
      {settings(rule, t('Batterieffekt till bilen över (W)', 'Battery power to EV above (W)'), '100')}
    </>;
    if (rule.key === 'large_load_overlap') return <>
      <p>{t(`Minst två av poolvärme, billaddning och hembatteriladdning överstiger vardera ${rule.threshold} W i samma kvart. Avdrag ges bara när en av lasterna kan flyttas till en strikt billigare kvart inom 72 timmar utan sämre komfort, mindre slutlager eller överskridna utrustningsgränser. Billigare kvartar prövas i prisordning; en fylld kvart ger inget avdrag.`,
        `At least two of pool heating, EV charging and home battery charging each exceed ${rule.threshold} W in the same quarter. A point is deducted only when one can move to a strictly cheaper quarter within 72 hours without worsening comfort, final stores or equipment limits. Cheaper quarters are tested in price order; a filled quarter causes no penalty.`)}</p>
      <p className="text-xs text-muted-foreground">{t('Högst ett avdrag per överlappande kvart, även med tre laster. Bedöms vid verkliga priser, även när de inte var publicerade. Flyttarna prövas var för sig mot originalplanen och bevisar inte en gemensam omplanering.',
        'At most one deduction per overlapping quarter, even with three loads. Judged at actual prices, including unpublished prices. Moves are tested separately against the original plan and do not prove a joint reschedule.')}</p>
      {sides.map(s => s.score && !s.score.auditPending && s.score.audit?.overlap.moves.filter(m => inRange(m.from)).map(m => <div key={`${s.side}-${m.from}`} className="flex flex-wrap items-center gap-2 text-xs">
        <span>{s.label} · {m.device} · {(m.movedW / 1000).toFixed(2)} kW</span>
        <Button size="sm" variant="outline" onClick={() => onSelect(s.side, m.from)}>{stamp(s, m.from)}</Button>
        <span>→</span>
        <Button size="sm" variant="outline" onClick={() => onSelect(s.side, m.to)}>{stamp(s, m.to)}</Button>
      </div>))}
      {settings(rule, t('Effekt per stor last (W)', 'Power per large workload (W)'), '100')}
    </>;
    const share = Math.round(rule.threshold * 100);
    const other = rule.unless && resolveRules(draft).find(r => r.key === rule.unless && r.enabled);
    const dear = DEAR_RULE_KEYS.includes(rule.key);
    return <>
      <p>
        {dear
          ? t(`Flexibla laster drar tillsammans minst ${FLEXIBLE_W} W från nätet i en kvart vars pris hör till planens dyraste ${share} %. Det som solen eller batteriet står för räknas inte.`,
            `Flexible loads together draw at least ${FLEXIBLE_W} W from the grid in a quarter whose price is among the dearest ${share} % of the plan's. What the sun or the battery supplies is not counted.`)
          : t(`Flexibla laster drar tillsammans minst ${FLEXIBLE_W} W i en kvart vars pris hör till planens billigaste ${share} %.`,
            `Flexible loads together draw at least ${FLEXIBLE_W} W in a quarter whose price is among the cheapest ${share} % of the plan's.`)}
        {other && ` ${t(`Räknas inte där ”${other.label}” slår till.`, `Not counted where “${other.label}” fires.`)}`}
      </p>
      {settings(rule, dear ? t('Andel dyraste kvartar (0–1)', 'Share of dearest quarters (0–1)') : t('Andel billigaste kvartar (0–1)', 'Share of cheapest quarters (0–1)'), '0.05')}
    </>;
  };

  const comfortDetail = (rule: ResolvedRule) => {
    if (rule.about === 'price') return priceDetail(rule);
    const pool = rule.about === 'pool', above = rule.key === 'pool_hot' || rule.key === 'pool_buffer';
    const comfort = test?.comfort ?? current?.comfort;
    const target = pool ? comfort?.pool_target_c : comfort?.ev_target_km;
    const unit = pool ? '°C' : 'km';
    const margin = Math.round(AHEAD_MARGIN * 100);
    const level = target === undefined ? null : Number((target + (above ? rule.threshold : -rule.threshold)).toFixed(2));
    return <>
      {level !== null && <p>
        {pool
          ? above ? t(`Poolen är varmare än ${level} ${unit}.`, `The pool is warmer than ${level} ${unit}.`) : t(`Poolen är kallare än ${level} ${unit}.`, `The pool is colder than ${level} ${unit}.`)
          : t(`Bilens räckvidd är under ${level} ${unit}.`, `The car has less than ${level} ${unit} of range.`)}
        {' '}{t(`Målet är ${target} ${unit}.`, `The target is ${target} ${unit}.`)}
        {above && ` ${rule.key === 'pool_buffer'
          ? t(`Nästa dygn är minst ${margin} % dyrare eller har minst ${margin} % mindre sol, så värmen sparas till det.`, `The next 24 h are at least ${margin} % dearer or have at least ${margin} % less sun, so the heat is stored for them.`)
          : t(`Nästa dygn är varken ${margin} % dyrare eller ${margin} % solfattigare, så värmen sparas inte till något.`, `The next 24 h are neither ${margin} % dearer nor ${margin} % less sunny, so the heat is stored for nothing.`)}
          ${t('Planens sista dygn bedöms inte: det har inget nästa dygn.', 'The plan\'s last 24 h are not judged: they have no next day.')}`}
        {rule.required && ` ${t('En enda kvart underkänner fallet.', 'A single quarter fails the case.')}`}
        {!above && ` ${t('Räknas först ett dygn efter att nivån gick att nå.', 'Counts only from a day after the level could be reached.')}`}
      </p>}
      {sides.map(s => {
        const application = s.score?.applicability[rule.key];
        return application && !application.applicable && <p key={s.side} className="text-muted-foreground">{s.label}: {application.reason}</p>;
      })}
      {settings(rule, `${t('Avstånd från mål', 'Distance from target')} (${unit})`, '0.1')}
    </>;
  };

  const ruleLabel = (key: string) => OPPORTUNITY_RULES.find(r => r.key === key)?.label ?? key;
  const energyDetail = (rule: OpportunityRuleMeta) => {
    const shown = witness?.rule === rule.key ? sides.find(s => s.side === witness.side) : undefined;
    const finding = shown && findingsOf(shown, rule.key).find(f => f.id === witness?.id);
    return <>
      <p>{rule.description} {t('−1 poäng för varje kvart som en billigare flytt hade ändrat, när priserna redan var publicerade.', '−1 point for each quarter a cheaper move would have changed, where prices were already published.')}</p>
      <p className="text-xs text-muted-foreground">{t('Efterklokhet: flytten krävde priser som inte var publicerade när planen gjordes, så den visas men kostar inga poäng. En flytt som passar flera regler ger avdrag under en enda.', 'Hindsight: the move needed prices that were not published when the plan was made, so it is shown but costs no points. A move that fits several rules is scored under one only.')}</p>
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
              : f.rule === rule.key ? t('känt i förväg · ger poängavdrag här', 'known in advance · scored here')
                : t(`känt i förväg · räknas under ”${ruleLabel(f.rule)}”`, `known in advance · scored under “${ruleLabel(f.rule)}”`)}</span>
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
