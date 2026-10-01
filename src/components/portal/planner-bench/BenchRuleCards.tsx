import React, { useEffect, useState } from 'react';
import { ShieldCheck, Thermometer, ArrowLeftRight, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { resolveRules, ECONOMIC_FULL_LOSS_SHARE, type CaseScore } from '@/lib/planner-bench/score';
import { OPPORTUNITY_RULES, ruleState, type OpportunityRuleKey } from '@/lib/planner-bench/opportunities';
import type { BenchSeries, CriteriaOverrides } from '@/lib/planner-bench/types';

const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
type Side = 'current' | 'test';
interface Props {
  current: BenchSeries | null; test: BenchSeries | null;
  currentScore: CaseScore | null; testScore: CaseScore | null;
  draft: CriteriaOverrides; onDraft: (draft: CriteriaOverrides) => void; onSave: () => void;
  timeZone: string; onSelect: (side: Side, quarter: number) => void;
}

/** A pair of aligned strips preserves timing; the number gives the exact exposure. */
function EventStrip({ label, events, length, value, onSelect, diagnostic = false }: {
  label: string; events: number[]; length: number; value: string; diagnostic?: boolean; onSelect: (quarter: number) => void;
}) {
  const { t } = useLanguage();
  return <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 items-center text-xs">
    <span className="text-muted-foreground">{label}</span>
    <span className="justify-self-end font-mono tabular-nums">{value}</span>
    <button type="button" disabled={!events.length} onClick={() => onSelect(events[0])}
      aria-label={`${label}: ${value}. ${t('Visa första händelsen', 'Show first event')}`}
      className={`col-span-2 min-h-8 w-full ${diagnostic ? 'text-primary' : 'text-destructive'} ${focus} disabled:cursor-default`}>
      <svg viewBox="0 0 288 12" preserveAspectRatio="none" className="w-full h-3" aria-hidden="true">
        <rect width="288" height="12" rx="2" className="fill-muted" />
        {[1, 2].map(day => <line key={day} x1={96 * day} x2={96 * day} y1="0" y2="12" className="stroke-muted-foreground" strokeDasharray="2 2" />)}
        {events.map(i => <rect key={i} x={i / Math.max(1, length) * 288} y="1" width={Math.max(1, 288 / Math.max(1, length))} height="10" fill="currentColor" />)}
      </svg>
    </button>
  </div>;
}

function TimelineKey() {
  return <div className="flex justify-between text-xs text-muted-foreground font-mono" aria-hidden="true"><span>0 h</span><span>24 h</span><span>48 h</span><span>72 h</span></div>;
}

/** Short flow diagrams show the alternative being tested; policy remains in the catalogue. */
const FLOW: Record<OpportunityRuleKey, readonly [string, string, string]> = {
  export_before_import: ['Surplus sun', 'Store', 'Later import'],
  battery_headroom_solar: ['Use battery', 'Make room', 'Incoming sun'],
  pool_solar_preheat: ['Sun today', 'Warm pool', 'Less sun later'],
  pool_wait_for_sun: ['Cool safely', 'Wait', 'Sun later'],
  import_avoidable_by_storage: ['Store earlier', 'Battery', 'Dear import'],
  battery_price_spread: ['Cheap charge', 'Battery', 'Dear use'],
  battery_preserve: ['Hold charge', 'Battery', 'Dearer later'],
  high_value_export: ['Cheaper energy', 'Battery', 'Dear export'],
  pool_cheaper_heating: ['Cheaper heat', 'Pool', 'Same comfort'],
  ev_timing: ['Cheaper charge', 'Car', 'Same range'],
  uneconomic_cycling: ['Skip cycle', 'Less wear', 'Same stores'],
};
function RuleFlow({ rule }: { rule: OpportunityRuleKey }) {
  return <div className="flex items-stretch gap-1 text-xs" aria-label={FLOW[rule].join(' → ')}>
    {FLOW[rule].map((label, i) => <React.Fragment key={label}>
      {i > 0 && <span className="self-center text-muted-foreground" aria-hidden="true">→</span>}
      <span className="flex-1 min-w-0 min-h-11 flex items-center justify-center rounded bg-muted/60 px-1 py-2 text-center">{label}</span>
    </React.Fragment>)}
  </div>;
}

/** Label the actual values: thresholds in storage units, not the editable target offsets. */
function ThresholdBand({ target, offset, unit, above }: { target: number; offset: number; unit: string; above: boolean }) {
  const { t } = useLanguage();
  const threshold = target + (above ? offset : -offset);
  return <div className="my-3 text-xs">
    <div className="flex justify-between gap-2 mb-1.5 font-mono">
      <span>{above ? `${t('Mål', 'Target')} ${target}` : `< ${Number(threshold.toFixed(2))}`} {unit}</span>
      <span>{above ? `> ${Number(threshold.toFixed(2))}` : `${t('Mål', 'Target')} ${target}`} {unit}</span>
    </div>
    <div className="relative flex h-2 rounded overflow-hidden" aria-hidden="true">
      <span className={`w-1/3 ${above ? 'bg-muted' : 'bg-destructive/70'}`} />
      <span className="w-2/3 bg-primary/25" />
      <span className="absolute left-1/3 h-2 border-l-2 border-foreground" />
      <span className="absolute right-2 h-2 border-l-2 border-foreground border-dashed" />
    </div>
  </div>;
}

/** The same plot compares a battery, pool or car witness. Solid and dashed work without colour. */
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
    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
      <span>{t('I källkvarten', 'At source quarter')}: {before[from]?.toFixed(2)} → {after[from]?.toFixed(2)} {unit}</span>
      <span>{t('Vid slutet', 'At horizon end')}: {before[before.length - 1]?.toFixed(2)} → {after[after.length - 1]?.toFixed(2)} {unit}</span>
    </div>
  </div>;
}

export default function BenchRuleCards({ current, test, currentScore, testScore, draft, onDraft, onSave, timeZone, onSelect }: Props) {
  const { t } = useLanguage();
  const sides = [
    { side: 'current' as const, label: t('Nuvarande', 'Current'), series: current, score: currentScore },
    { side: 'test' as const, label: 'Test', series: test, score: testScore },
  ];
  const rules = resolveRules(draft);
  const [witness, setWitness] = useState<{ side: Side; id: string } | null>(null);
  useEffect(() => {
    if (witness) document.getElementById('bench-witness')?.focus();
  }, [witness]);
  const chosen = sides.find(s => s.side === witness?.side);
  const finding = chosen?.score?.audit?.findings.find(f => f.id === witness?.id);
  const choose = (side: Side, id: string, quarter: number) => { setWitness({ side, id }); onSelect(side, quarter); };
  const patch = (key: string, field: 'enabled' | 'threshold' | 'points', value: number | boolean) =>
    onDraft({ ...draft, [key]: { ...draft[key], [field]: value } });

  return <section id="bench-rule-cards" className="space-y-5 min-w-0" aria-label={t('Poängregler', 'Scoring rules')}>
    <div className="flex flex-wrap justify-between items-baseline gap-2">
      <h3 className="font-medium">{t('Poängregler', 'Scoring rules')}</h3>
      <span className="text-xs text-muted-foreground">{t('Komfort 70 % + energitid 30 %', 'Comfort 70% + energy timing 30%')}</span>
    </div>

    <div className="rounded-lg border p-4 space-y-3">
      <h4 className="flex items-center gap-2 font-medium"><ShieldCheck aria-hidden="true" className="h-4 w-4" />{t('Kan utföras', 'Can execute')}</h4>
      <div className="grid sm:grid-cols-2 gap-4">
        {sides.map(s => {
          const audit = s.score?.audit;
          const violations = audit?.violations ?? [];
          return <div key={s.side} className="min-w-0">
            <EventStrip label={s.label} length={s.series?.start.length ?? 0} events={[...new Set(violations.map(v => v.quarter))]}
              value={!audit ? t('Saknar underlag', 'Missing evidence') : violations.length ? t(`${violations.length} överträdelser · underkänt`, `${violations.length} violations · fail`) : t('Inom bänkens gränser', 'Within bench limits')}
              onSelect={q => onSelect(s.side, q)} />
            {violations.length > 0 && <div className="flex flex-wrap gap-1 text-xs">{[...new Set(violations.map(v => v.kind))].map(kind => <span key={kind} className="rounded bg-destructive/10 px-2 py-1">{kind.replace(/_/g, ' ')}</span>)}</div>}
          </div>;
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('Effektgränser · lagringsgränser · giltiga beslut. Överträdelse ger alltid underkänt.', 'Power limits · storage limits · valid decisions. Any violation always fails.')}</p>
    </div>

    <div className="space-y-3">
      <h4 className="flex items-center gap-2 font-medium"><Thermometer aria-hidden="true" className="h-4 w-4" />{t('Komfort', 'Comfort')} <span className="text-xs font-normal text-muted-foreground">70%</span></h4>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rules.map(rule => {
          const pool = rule.key.startsWith('pool');
          const comfort = test?.comfort ?? current?.comfort;
          const target = pool ? comfort?.pool_target_c : comfort?.ev_target_km;
          const diagnostic = rule.key === 'pool_hot';
          return <article key={rule.key} id={`bench-rule-${rule.key}`} className="rounded-lg border p-3 min-w-0 space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-1">
              <h5 className="text-sm font-medium">{rule.label}</h5>
              <span className="text-xs text-muted-foreground">{!rule.enabled ? t('Av', 'Off') : diagnostic ? t('Buffert · 0 p', 'Buffer · 0 pts') : rule.required ? t('Krav', 'Required') : `${rule.points} ${t('p/kvart', 'pts/quarter')}`}</span>
            </div>
            {target !== undefined && <ThresholdBand target={target} offset={rule.threshold} unit={pool ? '°C' : 'km'} above={diagnostic} />}
            <TimelineKey />
            {sides.map(s => {
              const events = s.score?.quarters.flatMap((q, i) => q.fired.includes(rule.key) ? [i] : []) ?? [];
              const hours = events.reduce((total, i) => total + (s.series?.hours[i] ?? 0), 0);
              const application = s.score?.applicability[rule.key];
              const eligible = application ? application.eligibleQuarters * .25 : undefined;
              const value = !s.series?.comfort ? t('Saknar underlag', 'Missing evidence') : !rule.enabled ? t('Av', 'Off')
                : application && !application.applicable ? t('N/A · ingen bedömd tid', 'N/A · no eligible hours') : `${hours.toFixed(1)} h${diagnostic ? '' : ` / ${eligible?.toFixed(1) ?? '—'} h`}`;
              return <EventStrip key={s.side} diagnostic={diagnostic} label={s.label} value={value} length={s.series?.start.length ?? 0} events={events} onSelect={q => onSelect(s.side, q)} />;
            })}
            {sides.some(s => s.score?.applicability[rule.key]?.applicable === false) && <details className="text-xs text-muted-foreground">
              <summary className={`cursor-pointer py-1 ${focus}`}>{t('När gäller regeln?', 'When does this apply?')}</summary>
              {sides.map(s => <p key={s.side} className="py-1">{s.label}: {s.score?.applicability[rule.key]?.reason}</p>)}
            </details>}
          </article>;
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('Markerat = förlusttid / bedömd tid. Kalla starter får 24 h efter att nivån blivit nåbar. Varm pool kan lagra morgondagens värme.', 'Marked = loss hours / eligible hours. Cold starts get 24 h after the level becomes reachable. A warm pool can store tomorrow’s heat.')}</p>
    </div>

    <div className="space-y-3">
      <h4 className="flex items-center gap-2 font-medium"><ArrowLeftRight aria-hidden="true" className="h-4 w-4" />{t('Energitid', 'Energy timing')} <span className="text-xs font-normal text-muted-foreground">30%</span></h4>
      <div className="grid gap-3 sm:grid-cols-2">
        {sides.map(s => {
          const audit = s.score?.audit;
          return <div key={s.side} className="rounded-lg border p-3 min-w-0 space-y-2">
            <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{s.label}</span><span className="font-mono">{s.score?.complete && !s.score.auditPending && audit?.status === 'complete' ? `${audit.knownSek.toFixed(2)} SEK` : '—'}</span></div>
            {!audit || s.score?.auditPending ? <p className="text-sm text-muted-foreground">{t('Saknar underlag · räkna om poängen', 'Missing evidence · recompute scores')}</p>
              : audit.status !== 'complete' ? <p className="text-sm text-destructive">{audit.reason}</p>
              : <>
                <div className="flex h-2 rounded overflow-hidden bg-muted" aria-hidden="true"><span className="bg-destructive/70" style={{ width: `${Math.min(100, -(s.score?.economicPoints ?? 0) * 10)}%` }} /></div>
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{t('Full förlust vid', 'Full loss at')}: {(audit.scaleSek * ECONOMIC_FULL_LOSS_SHARE).toFixed(1)} SEK</span><span>{t('Efterklokhet', 'Hindsight')}: {audit.hindsightSek.toFixed(2)} SEK</span></div>
                <p className="text-xs text-muted-foreground">{audit.trials} {t('alternativ prövade', 'alternatives tested')} · {audit.limitReached ? t('sökgräns nådd', 'search limit reached') : t('begränsad sökning', 'bounded search')}</p>
              </>}
          </div>;
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('Flytta energi → samma komfort och slutlager → lägre kostnad efter slitage. Varje besparing räknas en gång.', 'Move energy → preserve comfort and end stores → lower cost after wear. Each saving counts once.')}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {OPPORTUNITY_RULES.map(rule => <article key={rule.key} id={`bench-opportunity-${rule.key}`} className="rounded-lg border p-3 space-y-2 min-w-0">
          <h5 className="text-sm font-medium">{rule.label}</h5>
          <RuleFlow rule={rule.key} />
          <details className="text-xs text-muted-foreground"><summary className={`cursor-pointer py-1 ${focus}`}>{t('Så mäts det', 'How measured')}</summary><p className="py-1">{rule.description}</p>{sides.map(s => <p key={s.side} className="py-1">{s.label}: {s.score?.audit?.applicability[rule.key]?.reason ?? t('Saknar underlag', 'Missing evidence')}</p>)}</details>
          <TimelineKey />
          {sides.map(s => {
            const audit = s.score?.audit;
            const state = audit ? ruleState(audit, rule.key) : 'unverified';
            const findings = !s.score?.auditPending ? audit?.findings.filter(f => f.tags.includes(rule.key)) ?? [] : [];
            return <div key={s.side} className="space-y-1">
              <EventStrip label={s.label} length={s.series?.start.length ?? 0} events={[...new Set(findings.flatMap(f => [f.from, f.to]))]}
                value={!audit || s.score?.auditPending ? t('Väntar på omräkning', 'Awaiting rescore') : audit.status !== 'complete' ? t('Ej bedömd', 'Not assessed')
                  : state === 'not_applicable' && !findings.length ? t('N/A · inte i detta fall', 'N/A · not in this case') : findings.length ? `${findings.length} ${t('belägg', 'witnesses')}` : t('Ingen förlust hittad', 'No loss found')}
                onSelect={q => { if (findings[0]) choose(s.side, findings[0].id, q); }} />
              {findings.slice(0, 1).map(f => <button type="button" key={f.id} aria-pressed={witness?.side === s.side && witness.id === f.id}
                onClick={() => choose(s.side, f.id, f.from)}
                className={`w-full min-h-11 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10 ${focus}`}>
                <span className="flex flex-wrap justify-between gap-1"><span>{f.kwh.toFixed(2)} kWh → <strong>{f.savingSek.toFixed(2)} SEK</strong></span><span>{f.basis === 'known' ? t('Känt', 'Known') : t('Efterklokhet', 'Hindsight')}</span></span>
                <span className="text-muted-foreground">{s.label} · {s.series && formatHomeDayMonthTime(s.series.start[f.from], timeZone)} → {s.series && formatHomeDayMonthTime(s.series.start[f.to], timeZone)}</span>
              </button>)}
              {findings.length > 1 && <label className="block text-xs text-muted-foreground">{t('Fler belägg', 'More witnesses')}
                <select aria-label={`${s.label}: ${rule.label} ${t('fler belägg', 'more witnesses')}`} value="" className={`mt-1 min-h-9 w-full min-w-0 rounded border bg-background px-2 ${focus}`}
                  onChange={e => { const f = findings.find(v => v.id === e.target.value); if (f) choose(s.side, f.id, f.from); }}>
                  <option value="">{t('Välj belägg', 'Choose witness')} ({findings.length})</option>
                  {findings.map(f => <option key={f.id} value={f.id}>{f.id}: {f.kwh.toFixed(2)} kWh · {f.savingSek.toFixed(2)} SEK</option>)}
                </select>
              </label>}
            </div>;
          })}
        </article>)}
      </div>
      {finding && chosen?.series && !chosen.score?.auditPending && <div id="bench-witness" tabIndex={-1} className={`rounded-lg border border-primary p-4 space-y-3 min-w-0 ${focus}`} aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-medium">{chosen.label} · {finding.kwh.toFixed(2)} kWh → {finding.savingSek.toFixed(2)} SEK {t('sparat', 'saved')}</h5><span className="text-xs">{finding.basis === 'known' ? t('Känd möjlighet', 'Known opportunity') : t('Endast efterklokhet', 'Hindsight only')}</span></div>
        <p className="text-sm font-medium">{OPPORTUNITY_RULES.find(rule => rule.key === finding.rule)?.label}</p>
        <WitnessPlot before={finding.device === 'pool' ? finding.before.poolC : finding.device === 'ev' ? finding.before.carKm : finding.before.homeSoc}
          after={finding.device === 'pool' ? finding.after.poolC : finding.device === 'ev' ? finding.after.carKm : finding.after.homeSoc}
          from={finding.from} to={finding.to} unit={finding.device === 'pool' ? '°C' : finding.device === 'ev' ? 'km' : '%'} label={finding.device === 'pool' ? 'Pool' : finding.device === 'ev' ? t('Bil', 'Car') : t('Batteri', 'Battery')} />
        <div className="text-xs text-muted-foreground">{t('Nätbesparing', 'Grid saving')}: {finding.gridSavingSek.toFixed(2)} SEK {finding.wearSek < 0 ? `+ ${t('sparat slitage', 'avoided wear')}` : `− ${t('slitage', 'wear')}`}: {Math.abs(finding.wearSek).toFixed(2)} SEK</div>
        <div className="flex flex-wrap gap-2">
          {([['from', t('Från', 'From')], ['to', t('Till', 'To')]] as const).map(([key, label]) => <Button key={key} variant="outline" size="sm" onClick={() => onSelect(chosen.side, finding[key])}>{label}: {formatHomeDayMonthTime(chosen.series!.start[finding[key]], timeZone)}</Button>)}
        </div>
        <p className="text-xs text-muted-foreground">{t('Alternativet fortsätter från tidigare accepterade flyttar. Diagrammet visar denna flytt, inte en optimal plan.', 'The alternative continues from previously accepted moves. This chart shows this transfer, not an optimal plan.')}</p>
      </div>}
      <details className="rounded-md border px-3 py-2 text-xs text-muted-foreground"><summary className={`cursor-pointer py-2 ${focus}`}>{t('Omfattning och begränsningar', 'Scope and limits')}</summary>
        <p className="py-2">{t('Bilen antas alltid ansluten. Avgångar, frånvaro, rumsvärme, varmvattenstyrning, korta moln, prognosrisk och effekttariffer, bilens strömsteg, startkostnader och körskydd ingår inte. Ingen hittad förlust betyder inte optimal plan. Bevarade slutlager kan dölja vissa möjligheter.', 'The car is always considered plugged in. Departures, absence, room heating, hot water control, brief clouds, forecast risk and peak tariffs, EV current steps, equipment start costs and native run protection are not modelled. No loss found does not mean optimal. Preserving end stores may hide some opportunities.')}</p>
      </details>
    </div>

    <details id="bench-advanced-rules" className="rounded-lg border p-3">
      <summary className={`cursor-pointer min-h-8 font-medium text-sm ${focus}`}><ChevronDown className="inline h-4 w-4 mr-2" aria-hidden="true" />{t('Avancerade komfortregler', 'Advanced comfort rules')}</summary>
      <div className="grid gap-3 sm:grid-cols-2 mt-3">
        {rules.filter(rule => rule.key !== 'pool_hot').map(rule => <div key={rule.key} className="rounded-md bg-muted/40 p-3 space-y-3 min-w-0">
          <div className="flex justify-between gap-2"><label htmlFor={`bench-${rule.key}-on`} className="text-sm">{rule.label}</label><Switch id={`bench-${rule.key}-on`} checked={rule.enabled} onCheckedChange={v => patch(rule.key, 'enabled', v)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-threshold`}><span>{t('Avstånd från mål', 'Distance from target')} ({rule.key.startsWith('pool') ? '°C' : 'km'})</span><Input id={`bench-${rule.key}-threshold`} type="number" min="0" step="0.1" value={rule.threshold} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber >= 0) patch(rule.key, 'threshold', e.target.valueAsNumber); }} /></label>
            <label className="text-xs space-y-1" htmlFor={`bench-${rule.key}-points`}><span>{t('Poäng per kvart', 'Points per quarter')}</span><Input id={`bench-${rule.key}-points`} type="number" min="-2" max="0" step="1" value={rule.points} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber <= 0) patch(rule.key, 'points', Math.max(-2, Math.round(e.target.valueAsNumber))); }} /></label>
          </div>
        </div>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Button size="sm" onClick={onSave}>{t('Spara regler för fallet', 'Save rules for this case')}</Button><span className="text-xs text-muted-foreground">{t('Räknar om alla planerare. Energi granskas igen vid ändrad komfort.', 'Rescores every planner. Changed comfort requires a new energy audit.')}</span></div>
    </details>
  </section>;
}
