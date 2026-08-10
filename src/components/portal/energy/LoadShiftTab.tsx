import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  isOptimisationPlan,
  type ActualEnergySlot,
  type GeneratedPlan,
  type OptimisationPlanV3,
  type PlanKey,
} from '@/lib/energy-shift/contracts';
import { createWebsiteDemoActuals, createWebsiteDemoPlan } from '@/lib/energy-shift/demo';

interface LoadShiftTabProps {
  customerId?: string;
  homeId: string | null;
}

interface CurrentRow {
  plan: OptimisationPlanV3;
  captured_at: string;
  updated_at: string;
}

const COLORS = {
  base: '#64748b',
  boiler: '#38bdf8',
  pool: '#14b8a6',
  ev: '#a78bfa',
  evCurrent: '#6d28d9',
  pv: '#f59e0b',
  pvRaw: '#fbbf24',
  soc: '#f43f5e',
  import: '#dc2626',
  export: '#0f766e',
  actual: '#111827',
  batteryCharge: '#2563eb',
  batteryDischarge: '#7c3aed',
};

const PLAN_KEYS: PlanKey[] = ['baseline', 'priority', 'cost'];

const scenarioFingerprint = (plan: GeneratedPlan) => JSON.stringify({
  status: plan.status,
  validationErrors: plan.validation_errors,
  serviceSlots: plan.service_slots,
  serviceCurrents: plan.service_currents_a,
  slots: plan.slots.map(slot => [
    slot.boiler_w,
    slot.pool_w,
    slot.ev_w,
    slot.ev_target_current_a,
    slot.battery_soc,
    slot.grid_import_w,
    slot.grid_export_w,
  ]),
});

const LoadShiftTab: React.FC<LoadShiftTabProps> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const [current, setCurrent] = useState<CurrentRow | null>(null);
  const [actuals, setActuals] = useState<ActualEnergySlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'live' | 'demo'>('live');
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  const load = useCallback(async (background = false) => {
    if (!customerId || !homeId) {
      setCurrent(null);
      setActuals([]);
      return;
    }
    if (!background) setLoading(true);
    setError(null);
    try {
      const toMs = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
      const from = new Date(toMs - 24 * 60 * 60_000).toISOString();
      const to = new Date(toMs).toISOString();
      const [planResult, actualResult] = await Promise.all([
        supabase
          .from('energy_optimisation_current')
          .select('plan, captured_at, updated_at')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .maybeSingle(),
        supabase
          .from('energy_optimisation_actual_slots')
          .select('start_ts, total_load_kwh, solar_production_kwh, grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .gte('start_ts', from)
          .lt('start_ts', to)
          .order('start_ts'),
      ]);
      const { data, error: planError } = planResult;
      if (planError) throw planError;
      const { data: actualRows, error: actualError } = actualResult;
      if (actualError) throw actualError;
      setActuals(actualRows ?? []);
      if (!data) {
        setCurrent(null);
        return;
      }
      if (!isOptimisationPlan(data.plan)) {
        throw new Error(t('Planformatet stöds inte.', 'The stored plan format is not supported.'));
      }
      setCurrent({ plan: data.plan, captured_at: data.captured_at, updated_at: data.updated_at });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLastCheckedAt(Date.now());
      if (!background) setLoading(false);
    }
  }, [customerId, homeId, t]);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const demoBucket = Math.floor(clock / (15 * 60_000));
  const demoReferenceTime = demoBucket * 15 * 60_000 + 1;
  const demoCurrent = useMemo<CurrentRow>(() => {
    const plan = createWebsiteDemoPlan(demoReferenceTime);
    return { plan, captured_at: plan.issued_at, updated_at: plan.issued_at };
  }, [demoReferenceTime]);
  const demoActuals = useMemo(
    () => createWebsiteDemoActuals(demoReferenceTime),
    [demoReferenceTime],
  );

  let content: React.ReactNode;
  if (view === 'demo') {
    content = (
      <PlanView
        current={demoCurrent}
        actuals={demoActuals}
        stale={false}
        isDemo
      />
    );
  } else if (!homeId) {
    content = <EmptyState text={t('Välj ett hem för att visa energiplanen.', 'Select a home to view its energy plan.')} />;
  } else if (loading && !current) {
    content = <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar energiplan…', 'Loading energy plan…')}</div>;
  } else if (error && !current) {
    content = (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('Kunde inte läsa energiplanen', 'Could not load the energy plan')}</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  } else if (!current) {
    content = (
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 py-8">
            <div>
              <p className="font-medium">{t('Väntar på den första liveplanen', 'Waiting for the first live plan')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(
                  'Home Assistant skickar nästa verifierade 15-minutersplan automatiskt. Den här sidan kontrollerar nu efter ny data var 30:e sekund.',
                  'Home Assistant will send the next verified 15-minute plan automatically. This page now checks for new data every 30 seconds.',
                )}
              </p>
              {lastCheckedAt && <p className="mt-2 text-xs text-muted-foreground">{t('Senast kontrollerad', 'Last checked')} {new Date(lastCheckedAt).toLocaleTimeString()}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setView('demo')}>
                <Sparkles className="mr-2 h-4 w-4" />
                {t('Visa exempelhemmet', 'View example home')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                'Exempelhemmet byggs enbart av fasta tal i webbläsaren och sparas aldrig i databasen.',
                'The example home is built only from fixed numbers in your browser and is never stored in the database.',
              )}
            </p>
          </CardContent>
        </Card>
        <ActualPerformance actuals={actuals} />
      </div>
    );
  } else {
    content = (
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('Den senaste uppdateringen misslyckades', 'The latest refresh failed')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <PlanView
          current={current}
          actuals={actuals}
          stale={clock > Date.parse(current.plan.valid_until)}
          isDemo={false}
          lastCheckedAt={lastCheckedAt}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant={view === 'live' ? 'default' : 'outline'} onClick={() => setView('live')}>
          {t('Mitt hem', 'My home')}
        </Button>
        <Button size="sm" variant={view === 'demo' ? 'default' : 'outline'} onClick={() => setView('demo')}>
          <Sparkles className="mr-2 h-4 w-4" />
          {t('Exempel', 'Example')}
        </Button>
      </div>
      {content}
    </div>
  );
};

const PlanView: React.FC<{
  current: CurrentRow;
  actuals: ActualEnergySlot[];
  stale: boolean;
  isDemo: boolean;
  lastCheckedAt?: number | null;
}> = ({ current, actuals, stale, isDemo, lastCheckedAt }) => {
  const { t } = useLanguage();
  const { plan } = current;
  // Home Assistant deliberately executes the priority scenario. Baseline and
  // cost-led remain read-only comparisons, never website control choices.
  const active = plan.plans.priority;
  const scenariosDiffer = useMemo(
    () => new Set(PLAN_KEYS.map(key => scenarioFingerprint(plan.plans[key]))).size > 1,
    [plan],
  );
  const chartData = useMemo(() => active.slots.map((slot, index) => {
    return {
      i: index,
      start: slot.start,
      label: new Date(slot.start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      pv: slot.pv_w,
      pvRaw: slot.pv_raw_w,
      base: slot.base_w,
      baseP10: slot.base_p10_w,
      baseP90: slot.base_p90_w,
      boiler: slot.boiler_w,
      pool: slot.pool_w,
      ev: slot.ev_w,
      evCurrent: slot.ev_target_current_a,
      soc: slot.battery_soc * 100,
      gridImport: slot.grid_import_w,
      gridExport: slot.grid_export_w,
      importPrice: slot.import_price_sek_per_kwh,
      exportPrice: slot.export_price_sek_per_kwh,
    };
  }), [active]);
  const firstAdvisory = active.slots.findIndex(slot => !slot.binding);
  const bindingIndex = firstAdvisory < 0 ? active.slots.length : firstAdvisory;
  const ticks = active.slots.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => new Date(slot.start).getMinutes() === 0 && new Date(slot.start).getHours() % 6 === 0)
    .map(({ index }) => index);
  const hasBattery = plan.capabilities.battery && plan.battery !== null;
  const hasPv = plan.capabilities.pv;
  const hasVariableEv = plan.services.some(service => service.control.type === 'discrete_current');
  const solarDays = hasBattery ? Object.keys(active.summary.battery_end_of_solar_soc) : [];
  const sourceStale = Object.entries(plan.sources)
    .filter(([, source]) => source !== null && Date.parse(source.valid_until) < Date.now())
    .map(([name]) => name);
  const bindingExpired = Date.now() >= Date.parse(plan.binding_until);
  const ready = !stale && !bindingExpired && plan.status === 'ready' && active.status === 'ready' && sourceStale.length === 0;
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  const batterySocLabel = t('Batteri SOC', 'Battery SOC');
  const evCurrentLabel = t('Bilens målström', 'EV target current');

  return (
    <div className="space-y-6">
      {isDemo && (
        <Alert>
          <AlertTitle>{t('Demoplan', 'Demo plan')}</AlertTitle>
          <AlertDescription>
            {t('Den här planen använder syntetiska exempeldata och kan aldrig styra enheter i Home Assistant.', 'This plan uses synthetic example data and can never control devices in Home Assistant.')}
          </AlertDescription>
        </Alert>
      )}
      {(!ready || plan.validation_errors.length > 0 || active.validation_errors.length > 0) && (
        <Alert variant={stale || bindingExpired || sourceStale.length > 0 ? 'destructive' : 'default'}>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {stale
              ? t('Planen har gått ut', 'Plan expired')
              : bindingExpired
                ? t('Den prissatta perioden har gått ut', 'The priced interval has ended')
              : sourceStale.length > 0
                ? t('En prognoskälla är gammal', 'A forecast source is stale')
                : t('Planen är inte genomförbar', 'Plan is not feasible')}
          </AlertTitle>
          <AlertDescription>
            {[
              ...(stale && !isDemo ? [t(
                'Nya planer skapas av Home Assistant; portalen visar bara resultatet och kontrollerar automatiskt var 30:e sekund.',
                'New plans are generated by Home Assistant; the portal only displays the result and checks automatically every 30 seconds.',
              )] : []),
              ...(bindingExpired ? [t('Home Assistant utför inte rådgivande, oprissatta pass.', 'Home Assistant does not execute advisory, unpriced slots.')] : []),
              ...sourceStale.map(source => `${source}: valid_until passed`),
              ...plan.validation_errors,
              ...active.validation_errors,
            ].slice(0, 8).join(' · ') || t('Home Assistant använder baskontrollerna tills en giltig plan finns.', 'Home Assistant uses its baseline controllers until a valid plan is available.')}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">{isDemo ? t('Demoplan med 15-minutersupplösning', '15-minute demo energy plan') : t('Liveplan för 15-minutersstyrning', 'Live 15-minute energy plan')}</CardTitle>
                <Badge variant={ready ? 'secondary' : 'destructive'}>
                  {isDemo ? t('Demo', 'Demo') : ready ? t('Giltig', 'Ready') : stale ? t('Utgången', 'Expired') : bindingExpired ? t('Endast rådgivande', 'Advisory only') : plan.status}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Utfärdad', 'Issued')} {new Date(plan.issued_at).toLocaleString()} · {plan.model_version} · {actuals.length} {t('faktiska kvartar', 'actual quarters')}
              </p>
              {!isDemo && lastCheckedAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Portalen kontrollerade senast', 'Portal last checked')} {new Date(lastCheckedAt).toLocaleTimeString()} · {t('Home Assistant använder B · Prioritetsordning för styrning', 'Home Assistant uses B · Priority stack for control')}
                </p>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Kpi label={t('Samma arbetsmängd', 'Equal workload')} value={`${active.summary.flexible_load_kwh.toFixed(1)} kWh`} detail={`${active.summary.service_delivered_kwh.toFixed(1)} / ${active.summary.service_required_kwh.toFixed(1)} kWh`} tone={active.summary.service_delivered_kwh >= active.summary.service_required_kwh ? 'good' : 'bad'} />
            {hasBattery
              ? <Kpi label={t('Lägsta batteri', 'Battery low')} value={pct(active.summary.battery_soc_low)} detail={`${pct(active.summary.battery_soc_start)} → ${pct(active.summary.battery_soc_end)}`} />
              : <Kpi label={t('Batteri', 'Battery')} value={t('Saknas', 'Not installed')} detail={t('ingen batterimodell används', 'no battery model used')} />}
            <Kpi label={t('Nätimport', 'Grid import')} value={`${active.summary.grid_import_kwh.toFixed(1)} kWh`} detail={`${active.summary.priced_import_kwh.toFixed(1)} ${t('prissatt', 'priced')}`} />
            <Kpi label={t('Nätexport', 'Grid export')} value={`${active.summary.grid_export_kwh.toFixed(1)} kWh`} detail={`${active.summary.priced_export_kwh.toFixed(1)} ${t('prissatt', 'priced')}`} />
            <Kpi label={t('Nettokostnad', 'Net cost')} value={`${active.summary.net_cost_sek.toFixed(2)} SEK`} detail={t('endast publicerade priser', 'published prices only')} />
            <Kpi label={t('Terminaljusterad', 'Terminal-adjusted')} value={`${active.summary.terminal_adjusted_cost_sek.toFixed(2)} SEK`} detail={t('värderar kvarvarande batteri', 'values remaining battery')} />
          </div>

          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
              <YAxis yAxisId="power" tick={{ fontSize: 11 }} tickFormatter={watts => `${(watts / 1_000).toFixed(0)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={value => `${value}%`} />
              <YAxis yAxisId="current" hide domain={[0, 'dataMax + 1']} />
              {bindingIndex < chartData.length && <ReferenceArea yAxisId="power" x1={bindingIndex} x2={chartData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
              {hasBattery && <ReferenceLine yAxisId="soc" y={plan.policy.battery_end_of_solar_target_soc * 100} stroke={COLORS.soc} strokeDasharray="3 3" strokeOpacity={0.45} />}
              {hasPv && <Area yAxisId="power" type="monotone" dataKey="pv" name={t('Kalibrerad solprognos', 'Calibrated PV')} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} />}
              {hasPv && <Line yAxisId="power" type="monotone" dataKey="pvRaw" name={t('Rå solprognos', 'Raw PV')} stroke={COLORS.pvRaw} strokeDasharray="4 3" dot={false} />}
              <Area yAxisId="power" type="step" dataKey="base" stackId="load" name={t('Baslast', 'Base load')} fill={COLORS.base} strokeWidth={0} />
              <Line yAxisId="power" type="step" dataKey="baseP10" name={t('Baslast p10', 'Base load p10')} stroke={COLORS.base} strokeOpacity={0.45} strokeDasharray="2 3" dot={false} />
              <Line yAxisId="power" type="step" dataKey="baseP90" name={t('Baslast p90', 'Base load p90')} stroke={COLORS.base} strokeOpacity={0.65} strokeDasharray="5 3" dot={false} />
              <Area yAxisId="power" type="step" dataKey="boiler" stackId="load" name={t('Varmvatten', 'Hot water')} fill={COLORS.boiler} strokeWidth={0} />
              <Area yAxisId="power" type="step" dataKey="pool" stackId="load" name={t('Pool', 'Pool')} fill={COLORS.pool} strokeWidth={0} />
              <Area yAxisId="power" type="step" dataKey="ev" stackId="load" name={t('Bil', 'EV')} fill={COLORS.ev} strokeWidth={0} />
              {hasVariableEv && <Line yAxisId="current" type="stepAfter" dataKey="evCurrent" name={evCurrentLabel} stroke={COLORS.evCurrent} strokeWidth={2} dot={false} />}
              <Line yAxisId="power" type="step" dataKey="gridImport" name={t('Importeffekt', 'Grid import')} stroke={COLORS.import} dot={false} />
              <Line yAxisId="power" type="step" dataKey="gridExport" name={t('Exporteffekt', 'Grid export')} stroke={COLORS.export} dot={false} />
              {hasBattery && <Line yAxisId="soc" type="monotone" dataKey="soc" name={batterySocLabel} stroke={COLORS.soc} strokeWidth={2} dot={false} />}
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={(value, name) => [name === evCurrentLabel ? `${Number(value).toFixed(0)} A` : name === batterySocLabel ? `${Number(value).toFixed(1)}%` : `${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('Skuggat område är rådgivande eftersom båda prisserierna inte längre är publicerade.', 'The shaded interval is advisory because both price series are no longer published.')}
          </p>
        </CardContent>
      </Card>

      <ActualPerformance actuals={actuals} />

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">{t('Import- och exportpris', 'Import and export prices')}</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={value => `${Number(value).toFixed(2)}`} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <Line type="stepAfter" dataKey="importPrice" name={t('Köpa', 'Import')} stroke={COLORS.import} dot={false} connectNulls={false} />
              <Line type="stepAfter" dataKey="exportPrice" name={t('Sälja', 'Export')} stroke={COLORS.export} dot={false} connectNulls={false} />
              <Tooltip labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={value => [`${Number(value).toFixed(3)} SEK/kWh`, '']} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {scenariosDiffer && <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">{t('Jämförbara scenarier', 'Comparable scenarios')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 text-left font-medium">{t('Plan', 'Plan')}</th>
                <th className="py-2 text-right font-medium">{t('Flexibel last', 'Flexible load')}</th>
                <th className="py-2 text-right font-medium">{t('Import', 'Import')}</th>
                <th className="py-2 text-right font-medium">{t('Export', 'Export')}</th>
                <th className="py-2 text-right font-medium">{t('Terminaljusterad', 'Terminal-adjusted')}</th>
                {solarDays.map(day => <th key={day} className="py-2 text-right font-medium">SOC {day.slice(5)}</th>)}
              </tr></thead>
              <tbody>{PLAN_KEYS.map(key => <PlanRow key={key} plan={plan.plans[key]} selected={key === 'priority'} solarDays={solarDays} />)}</tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('Scenarierna är endast en analysjämförelse. Home Assistant styr alltid enligt B · Prioritetsordning. Alla alternativ levererar samma flexibla energimängd med hela 15-minuterspass och giltiga laddströmssteg.', 'The scenarios are a read-only analysis comparison. Home Assistant always controls according to B · Priority stack. Every alternative delivers the same flexible energy using whole 15-minute slots and valid charger-current steps.')}
          </p>
        </CardContent>
      </Card>}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">{t('Datakällor och kvalitet', 'Data sources and quality')}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {Object.entries(plan.sources).map(([key, source]) => source ? (
            <SourceRow key={key} name={key.replace('_', ' ')} source={source} />
          ) : (
            <div key={key} className="grid grid-cols-1 gap-x-4 md:grid-cols-[140px_180px_1fr]">
              <div className="font-medium capitalize">{key.replace('_', ' ')}</div>
              <div>{t('Inte installerad', 'Not installed')}</div>
            </div>
          ))}
          <div className="border-t pt-3">
            <div className="font-medium">{t('Verifierade modellindata', 'Verified model inputs')}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {plan.battery ? <>{t('Batteri', 'Battery')} {plan.battery.capacity_kwh.toFixed(2)} kWh · SOC {pct(plan.battery.soc)} · {t('ladda/urladda', 'charge/discharge')} {(plan.battery.charge_max_w / 1_000).toFixed(1)}/{(plan.battery.discharge_max_w / 1_000).toFixed(1)} kW · η {(plan.battery.charge_efficiency * 100).toFixed(0)}/{(plan.battery.discharge_efficiency * 100).toFixed(0)}% · </> : null}
              {t('Nätgräns in/ut', 'Grid limit in/out')} {(plan.grid.import_limit_w / 1_000).toFixed(1)}/{(plan.grid.export_limit_w / 1_000).toFixed(1)} kW
            </div>
            {plan.services.length > 0 && (
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {plan.services.map(service => {
                  const sampleKey = service.device === 'boiler' ? 'hot_water' : service.device === 'pool' ? 'pool_heating' : 'ev_charging';
                  const samples = plan.service_requirement_sample_days[sampleKey];
                  return (
                    <div key={service.id}>
                      {service.id}: {service.required_kwh.toFixed(2)} kWh · {service.control.type === 'fixed_power'
                        ? `${(service.control.power_w / 1_000).toFixed(1)} kW`
                        : `${service.control.min_current_a}–${service.control.max_current_a} A (${service.control.current_step_a} A ${t('steg', 'steps')}, ${service.control.phase_count}×${service.control.voltage_v} V)`} · {t('minsta körning', 'minimum run')} {service.min_run_slots * 15} min · {t('deadline', 'deadline')} {new Date(service.deadline).toLocaleString()}{samples != null ? ` · n=${samples} active days` : ''}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="border-t pt-3 text-xs text-muted-foreground">
            {t('Home Assistant behåller rådata. Webbplatsen får högst 96 aggregerade rader per dygn och hem, en aktuell plan som skrivs över varje timme och små körsammanfattningar. Kvartsdata rensas efter 120 dagar och körhistorik efter 30 dagar.', 'Home Assistant retains raw samples. The website receives at most 96 aggregated rows per day and home, one current plan overwritten hourly, and small run summaries. Quarter-hour data is pruned after 120 days and run history after 30 days.')}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

const ActualPerformance: React.FC<{ actuals: ActualEnergySlot[] }> = ({ actuals }) => {
  const { t } = useLanguage();
  const data = useMemo(() => actuals.map((slot, index) => ({
    i: index,
    label: new Date(slot.start_ts).toLocaleString([], { hour: '2-digit', minute: '2-digit' }),
    load: slot.total_load_kwh == null ? null : slot.total_load_kwh * 4_000,
    pv: slot.solar_production_kwh == null ? null : slot.solar_production_kwh * 4_000,
    gridImport: slot.grid_import_kwh == null ? null : slot.grid_import_kwh * 4_000,
    gridExport: slot.grid_export_kwh == null ? null : slot.grid_export_kwh * 4_000,
    batteryCharge: slot.battery_charge_kwh == null ? null : slot.battery_charge_kwh * 4_000,
    batteryDischarge: slot.battery_discharge_kwh == null ? null : slot.battery_discharge_kwh * 4_000,
  })), [actuals]);
  const ticks = data.filter((_, index) => index % 12 === 0).map(value => value.i);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('Uppmätt prestanda — senaste 24 timmarna', 'Measured performance — last 24 hours')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('Inga kompletta 15-minutersvärden har tagits emot ännu.', 'No complete 15-minute actuals have been received yet.')}
          </p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={230}>
              <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="i" type="number" domain={[0, data.length - 1]} ticks={ticks} tickFormatter={index => data[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={watts => `${(Number(watts) / 1_000).toFixed(0)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                <Line type="stepAfter" dataKey="load" name={t('Faktisk last', 'Actual load')} stroke={COLORS.actual} strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="stepAfter" dataKey="pv" name={t('Faktisk sol', 'Actual PV')} stroke={COLORS.pv} strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="stepAfter" dataKey="gridImport" name={t('Faktisk import', 'Actual import')} stroke={COLORS.import} dot={false} connectNulls={false} />
                <Line type="stepAfter" dataKey="gridExport" name={t('Faktisk export', 'Actual export')} stroke={COLORS.export} dot={false} connectNulls={false} />
                <Line type="stepAfter" dataKey="batteryCharge" name={t('Faktisk batteriladdning', 'Actual battery charge')} stroke={COLORS.batteryCharge} dot={false} connectNulls={false} />
                <Line type="stepAfter" dataKey="batteryDischarge" name={t('Faktisk batteriurladdning', 'Actual battery discharge')} stroke={COLORS.batteryDischarge} dot={false} connectNulls={false} />
                <Tooltip labelFormatter={index => data[index as number]?.label ?? ''} formatter={(value, name) => [`${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Varje punkt är energi från Home Assistants recorder summerad i en komplett kvart och visad som medeleffekt; råa sekundvärden lagras inte på webbplatsen.', 'Each point is Home Assistant recorder energy summed into one complete quarter and shown as average power; raw per-second values are not stored by the website.')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
};

const PlanRow: React.FC<{ plan: GeneratedPlan; selected: boolean; solarDays: string[] }> = ({ plan, selected, solarDays }) => (
  <tr className={`border-t ${selected ? 'bg-muted/40' : ''}`}>
    <td className="py-2">{plan.label} {plan.status !== 'ready' && <Badge variant="destructive" className="ml-1">{plan.status}</Badge>}</td>
    <td className="text-right tabular-nums">{plan.summary.flexible_load_kwh.toFixed(1)} kWh</td>
    <td className="text-right tabular-nums">{plan.summary.grid_import_kwh.toFixed(1)}</td>
    <td className="text-right tabular-nums">{plan.summary.grid_export_kwh.toFixed(1)}</td>
    <td className="text-right tabular-nums">{plan.summary.terminal_adjusted_cost_sek.toFixed(2)} SEK</td>
    {solarDays.map(day => <td key={day} className="text-right tabular-nums">{plan.summary.battery_end_of_solar_soc[day] == null ? '—' : `${(plan.summary.battery_end_of_solar_soc[day] * 100).toFixed(0)}%`}</td>)}
  </tr>
);

const SourceRow: React.FC<{
  name: string;
  source: NonNullable<OptimisationPlanV3['sources'][keyof OptimisationPlanV3['sources']]>;
}> = ({ name, source }) => (
  <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 md:grid-cols-[140px_180px_1fr]">
    <div className="font-medium capitalize">{name}</div>
    <div>{source.provider} · {source.quality}</div>
    <div className="text-xs text-muted-foreground">
      {source.entity_ids.join(', ')} · valid {new Date(source.valid_until).toLocaleString()}
      {source.sample_count != null ? ` · n=${source.sample_count}` : ''}
      {source.mape_percent != null ? ` · MAPE ${source.mape_percent.toFixed(1)}%` : ''}
      {source.bias_percent != null ? ` · bias ${source.bias_percent.toFixed(1)}%` : ''}
      {source.location?.market_area ? ` · ${source.location.market_area}` : ''}
      {source.location?.latitude != null && source.location?.longitude != null
        ? ` · ${source.location.latitude.toFixed(3)}, ${source.location.longitude.toFixed(3)}`
        : ''}
    </div>
  </div>
);

const Kpi: React.FC<{ label: string; value: string; detail: string; tone?: 'good' | 'bad' }> = ({ label, value, detail, tone }) => (
  <div className="rounded-lg border p-3">
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className={`mt-1 text-xl font-medium tabular-nums ${tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : ''}`}>{value}</div>
    <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
  </div>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <Card><CardContent className="py-10 text-sm text-muted-foreground">{text}</CardContent></Card>
);

export default LoadShiftTab;
