import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  CartesianGrid,
  ComposedChart,
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
  effectiveControlType,
  effectivePlanningRole,
  isOptimisationPlan,
  type ActualEnergySlot,
  type OptimisationPlanV5,
} from '@/lib/energy-shift/contracts';
import { createWebsiteDemoActuals, createWebsiteDemoPlan } from '@/lib/energy-shift/demo';
import { comparePlans, formatSigned } from '@/lib/energy-shift/plan-comparison';
import EmpiricalDeviceModelsCard, {
  type EmpiricalEnergyDevice,
} from './EmpiricalDeviceModelsCard';

interface LoadShiftTabProps {
  customerId?: string;
  homeId: string | null;
  accountPath: string;
}

interface CurrentRow {
  plan: OptimisationPlanV5;
  captured_at: string;
  updated_at: string;
}

interface EmpiricalDeviceSlotMatrix {
  start_ts: string;
  device_energy_kwh: Record<string, number>;
}

interface HomeAssistantConnection {
  device_name: string;
  home_id: string;
  last_seen_at: string | null;
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

type PlanViewMode = 'planned' | 'unplanned';
type PlanChartSeriesKey =
  | 'pv'
  | 'pvRaw'
  | 'base'
  | 'boiler'
  | 'pool'
  | 'ev'
  | 'evCurrent'
  | 'gridImport'
  | 'gridExport'
  | 'soc'
  | `device:${string}`;

interface PlanChartSeries {
  key: PlanChartSeriesKey;
  label: string;
  color: string;
  dataKey?: string;
}

const DEVICE_COLORS = ['#0ea5e9', '#8b5cf6', '#22c55e', '#eab308', '#f97316', '#ec4899', '#06b6d4', '#84cc16'];

const LoadShiftTab: React.FC<LoadShiftTabProps> = ({ customerId, homeId, accountPath }) => {
  const { t } = useLanguage();
  const [current, setCurrent] = useState<CurrentRow | null>(null);
  const [actuals, setActuals] = useState<ActualEnergySlot[]>([]);
  const [empiricalDevices, setEmpiricalDevices] = useState<EmpiricalEnergyDevice[]>([]);
  const [deviceActuals, setDeviceActuals] = useState<EmpiricalDeviceSlotMatrix[]>([]);
  const [connections, setConnections] = useState<HomeAssistantConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'live' | 'demo'>('live');
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  const load = useCallback(async (background = false) => {
    if (!customerId || !homeId) {
      setCurrent(null);
      setActuals([]);
      setEmpiricalDevices([]);
      setDeviceActuals([]);
      setConnections([]);
      return;
    }
    if (!background) setLoading(true);
    setError(null);
    try {
      const toMs = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
      const from = new Date(toMs - 72 * 60 * 60_000).toISOString();
      const to = new Date(toMs).toISOString();
      const [planResult, actualResult, connectionResult, deviceResult, deviceActualResult] = await Promise.all([
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
        supabase
          .from('ha_device_tokens')
          .select('device_name, home_id, last_seen_at')
          .eq('customer_id', customerId)
          .is('revoked_at', null)
          .order('created_at', { ascending: false }),
        supabase
          .from('energy_optimisation_devices')
          .select('id, device_key, statistic_id, name, category, suggested_load_type, load_type_override, suggested_planning_role, planning_role_override, suggested_control_type, control_type_override, active_power_w, profile_sample_count, last_seen_at')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .order('name'),
        supabase.rpc('get_energy_optimisation_device_slots', {
          p_customer_id: customerId,
          p_home_id: homeId,
          p_from: from,
          p_to: to,
        }),
      ]);
      const { data, error: planError } = planResult;
      if (planError) throw planError;
      const { data: actualRows, error: actualError } = actualResult;
      if (actualError) throw actualError;
      const { data: connectionRows, error: connectionError } = connectionResult;
      if (connectionError) throw connectionError;
      const { data: deviceRows, error: deviceError } = deviceResult;
      if (deviceError) throw deviceError;
      const { data: deviceActualRows, error: deviceActualError } = deviceActualResult;
      if (deviceActualError) throw deviceActualError;
      setActuals(actualRows ?? []);
      setEmpiricalDevices((deviceRows ?? []) as EmpiricalEnergyDevice[]);
      setDeviceActuals((deviceActualRows ?? []) as EmpiricalDeviceSlotMatrix[]);
      setConnections((connectionRows ?? []) as HomeAssistantConnection[]);
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
  const activeConnection = connections.find(connection => connection.home_id === homeId);

  let content: React.ReactNode;
  if (view === 'demo') {
    content = (
      <PlanView
        current={demoCurrent}
        actuals={demoActuals}
        empiricalDevices={[]}
        deviceActuals={[]}
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
    const hasConnectionForAnotherHome = connections.length > 0 && !activeConnection;
    content = (
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 py-8">
            <div>
              <p className="font-medium">
                {activeConnection
                  ? t('Home Assistant är ansluten — väntar på den första godkända planen', 'Home Assistant is connected — waiting for the first accepted plan')
                  : hasConnectionForAnotherHome
                    ? t('Home Assistant är ansluten till ett annat hem', 'Home Assistant is connected to another home')
                    : t('Det här hemmet har ingen aktiv Home Assistant-anslutning', 'This home has no active Home Assistant connection')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeConnection
                  ? t(
                    `Anslutningen ${activeConnection.device_name} sågs senast ${activeConnection.last_seen_at ? new Date(activeConnection.last_seen_at).toLocaleString() : 'aldrig'}. Portalen kontrollerar efter en plan var 30:e sekund.`,
                    `The ${activeConnection.device_name} connection was last seen ${activeConnection.last_seen_at ? new Date(activeConnection.last_seen_at).toLocaleString() : 'never'}. The portal checks for a plan every 30 seconds.`,
                  )
                  : hasConnectionForAnotherHome
                    ? t(
                      'Den aktiva anslutningen är bunden till ett annat hem. Välj det hemmet ovan eller skapa en anslutning för det valda hemmet.',
                      'The active connection is bound to another home. Select that home above or create a connection for the selected home.',
                    )
                    : t(
                      'Skapa en parningskod på kontosidan och anslut Smart Home Solutions Energy i Home Assistant.',
                      'Create a pairing code on the Account page and connect Smart Home Solutions Energy in Home Assistant.',
                    )}
              </p>
              {lastCheckedAt && <p className="mt-2 text-xs text-muted-foreground">{t('Senast kontrollerad', 'Last checked')} {new Date(lastCheckedAt).toLocaleTimeString()}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {!activeConnection && (
                <Button size="sm" variant="outline" asChild>
                  <Link to={accountPath}>{t('Öppna Home Assistant-anslutningar', 'Open Home Assistant connections')}</Link>
                </Button>
              )}
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
        <ActualPerformance actuals={actuals} devices={empiricalDevices} deviceActuals={deviceActuals} />
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
          empiricalDevices={empiricalDevices}
          deviceActuals={deviceActuals}
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
      {view === 'live' && customerId && homeId && (
        <EmpiricalDeviceModelsCard
          devices={empiricalDevices}
          onChanged={() => load(true)}
        />
      )}
    </div>
  );
};

const PlanView: React.FC<{
  current: CurrentRow;
  actuals: ActualEnergySlot[];
  empiricalDevices: EmpiricalEnergyDevice[];
  deviceActuals: EmpiricalDeviceSlotMatrix[];
  stale: boolean;
  isDemo: boolean;
  lastCheckedAt?: number | null;
}> = ({ current, actuals, empiricalDevices, deviceActuals, stale, isDemo, lastCheckedAt }) => {
  const { t } = useLanguage();
  const { plan } = current;
  const [planView, setPlanView] = useState<PlanViewMode>('planned');
  const [hiddenSeries, setHiddenSeries] = useState<Set<PlanChartSeriesKey>>(
    () => new Set(),
  );
  const [hiddenPriceSeries, setHiddenPriceSeries] = useState<Set<'importPrice' | 'exportPrice'>>(
    () => new Set(),
  );
  // Home Assistant executes the priority scenario. Baseline is exposed only
  // as a counterfactual chart and cannot change local control.
  const executed = plan.plans.priority;
  const active = planView === 'planned' ? plan.plans.priority : plan.plans.baseline;
  const comparison = useMemo(
    () => comparePlans(plan.plans.priority, plan.plans.baseline),
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
      boiler: slot.boiler_expected_w,
      pool: slot.pool_w,
      ev: slot.ev_w,
      evCurrent: slot.ev_target_current_a,
      soc: slot.battery_soc * 100,
      gridImport: slot.grid_import_w,
      gridExport: slot.grid_export_w,
      importPrice: slot.import_price_sek_per_kwh,
      exportPrice: slot.export_price_sek_per_kwh,
      ...Object.fromEntries(plan.device_models.map((model, modelIndex) => [
        `device${modelIndex}`,
        slot.device_loads_w[model.key] ?? 0,
      ])),
    };
  }), [active, plan.device_models]);
  const firstAdvisory = active.slots.findIndex(slot => !slot.binding);
  const bindingIndex = firstAdvisory < 0 ? active.slots.length : firstAdvisory;
  const ticks = active.slots.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => new Date(slot.start).getMinutes() === 0 && new Date(slot.start).getHours() % 6 === 0)
    .map(({ index }) => index);
  const hasBattery = plan.capabilities.battery && plan.battery !== null;
  const hasPv = plan.capabilities.pv;
  const hasVariableEv = plan.services.some(service => service.control.type === 'discrete_current');
  const sourceStale = Object.entries(plan.sources)
    .filter(([, source]) => source !== null && Date.parse(source.valid_until) < Date.now())
    .map(([name]) => name);
  const bindingExpired = Date.now() >= Date.parse(plan.binding_until);
  const ready = !stale && !bindingExpired && plan.status === 'ready' && executed.status === 'ready' && sourceStale.length === 0;
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  const batterySocLabel = t('Batteri SOC', 'Battery SOC');
  const evCurrentLabel = t('Bilens målström', 'EV target current');
  const seriesByKey: Record<Exclude<PlanChartSeriesKey, `device:${string}`>, PlanChartSeries> = {
    pv: { key: 'pv', label: t('Kalibrerad solprognos', 'Calibrated PV'), color: COLORS.pv },
    pvRaw: { key: 'pvRaw', label: t('Rå solprognos', 'Raw PV'), color: COLORS.pvRaw },
    base: { key: 'base', label: t('Baslast', 'Base load'), color: COLORS.base },
    boiler: { key: 'boiler', label: t('Förväntat varmvatten', 'Expected hot water'), color: COLORS.boiler },
    pool: { key: 'pool', label: t('Pool', 'Pool'), color: COLORS.pool },
    ev: { key: 'ev', label: t('Bil', 'EV'), color: COLORS.ev },
    evCurrent: { key: 'evCurrent', label: evCurrentLabel, color: COLORS.evCurrent },
    gridImport: { key: 'gridImport', label: t('Importeffekt', 'Grid import'), color: COLORS.import },
    gridExport: { key: 'gridExport', label: t('Exporteffekt', 'Grid export'), color: COLORS.export },
    soc: { key: 'soc', label: batterySocLabel, color: COLORS.soc },
  };
  const deviceSeries: PlanChartSeries[] = plan.device_models.map((model, index) => ({
    key: `device:${model.key}`,
    dataKey: `device${index}`,
    label: `${model.name} · ${model.control_type.replace(/_/g, ' ')}`,
    color: DEVICE_COLORS[index % DEVICE_COLORS.length],
  }));
  const representedCategories = new Set(plan.device_models.map(model => model.category));
  const showBoilerAggregate = plan.capabilities.boiler && !representedCategories.has('hot_water');
  const showPoolAggregate = plan.capabilities.pool && !representedCategories.has('pool_heating');
  const showEvAggregate = plan.capabilities.ev && !representedCategories.has('ev_charging');
  const planChartSeries: PlanChartSeries[] = [
    ...(hasPv ? [seriesByKey.pv, seriesByKey.pvRaw] : []),
    seriesByKey.base,
    ...(showBoilerAggregate ? [seriesByKey.boiler] : []),
    ...(showPoolAggregate ? [seriesByKey.pool] : []),
    ...(showEvAggregate ? [seriesByKey.ev] : []),
    ...deviceSeries,
    ...(hasVariableEv ? [seriesByKey.evCurrent] : []),
    seriesByKey.gridImport,
    seriesByKey.gridExport,
    ...(hasBattery ? [seriesByKey.soc] : []),
  ];
  const seriesVisible = (key: PlanChartSeriesKey) => !hiddenSeries.has(key);
  const toggleSeries = (key: PlanChartSeriesKey) => {
    setHiddenSeries(currentHidden => {
      const next = new Set(currentHidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const priceSeries = [
    { key: 'importPrice' as const, label: t('Köpa', 'Import'), color: COLORS.import },
    { key: 'exportPrice' as const, label: t('Sälja', 'Export'), color: COLORS.export },
  ];
  const togglePriceSeries = (key: 'importPrice' | 'exportPrice') => {
    setHiddenPriceSeries(currentHidden => {
      const next = new Set(currentHidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const costDelta = comparison.terminalAdjustedCostSekDelta;
  const costTone = costDelta < -0.005 ? 'good' : costDelta > 0.005 ? 'bad' : undefined;
  const costMeaning = costDelta < -0.005
    ? t('uppskattad besparing', 'estimated saving')
    : costDelta > 0.005
      ? t('uppskattad merkostnad', 'estimated added cost')
      : t('ingen uppskattad förändring', 'no estimated change');

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
      {(!ready || plan.validation_errors.length > 0 || executed.validation_errors.length > 0) && (
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
              ...executed.validation_errors,
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
                  {t('Portalen kontrollerade senast', 'Portal last checked')} {new Date(lastCheckedAt).toLocaleTimeString()} · {t('Home Assistant använder vyn Med plan för styrning', 'Home Assistant executes the With plan schedule')}
                </p>
              )}
            </div>
            <div className="space-y-1.5 text-right">
              <div className="flex gap-1" role="group" aria-label={t('Jämför planvyer', 'Compare plan views')}>
                <Button
                  size="sm"
                  variant={planView === 'planned' ? 'default' : 'outline'}
                  aria-pressed={planView === 'planned'}
                  onClick={() => setPlanView('planned')}
                >
                  {t('Med plan', 'With plan')}
                </Button>
                <Button
                  size="sm"
                  variant={planView === 'unplanned' ? 'default' : 'outline'}
                  aria-pressed={planView === 'unplanned'}
                  onClick={() => setPlanView('unplanned')}
                >
                  {t('Utan plan', 'Without plan')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('Ändrar bara jämförelsevyn', 'Changes only the comparison view')}
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-6 grid gap-3 md:grid-cols-3">
            <DeltaKpi
              label={t('Förbrukningsskillnad', 'Consumption difference')}
              value={`${formatSigned(comparison.loadKwhDelta, 1)} kWh`}
              detail={`${t('Med plan', 'With plan')} ${plan.plans.priority.summary.load_kwh.toFixed(1)} · ${t('utan plan', 'without plan')} ${plan.plans.baseline.summary.load_kwh.toFixed(1)} kWh`}
            />
            <DeltaKpi
              label={t('Skillnad i nätenergi', 'Grid energy difference')}
              value={`${formatSigned(comparison.gridImportKwhDelta, 1)} kWh`}
              detail={t('import med plan minus utan plan', 'import with plan minus without plan')}
              tone={comparison.gridImportKwhDelta < -0.05 ? 'good' : comparison.gridImportKwhDelta > 0.05 ? 'bad' : undefined}
            />
            <DeltaKpi
              label={t('Uppskattad kostnadsskillnad', 'Estimated cost difference')}
              value={`${formatSigned(costDelta, 2)} SEK`}
              detail={`${costMeaning} · ${t('inklusive värdet på kvarvarande batteri', 'including remaining battery value')}`}
              tone={costTone}
              emphasized
            />
          </div>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Kpi label={t('Modellerad flexibel energi', 'Modeled flexible energy')} value={`${active.summary.flexible_load_kwh.toFixed(1)} kWh`} detail={active.summary.duty_cycle_deferred_kwh > 0.005 ? `${active.summary.duty_cycle_deferred_kwh.toFixed(2)} kWh ${t('förskjuts utanför perioden', 'deferred beyond the period')}` : `${active.summary.service_delivered_kwh.toFixed(1)} / ${active.summary.service_required_kwh.toFixed(1)} kWh`} />
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
              {hasBattery && seriesVisible('soc') && <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={value => `${value}%`} />}
              <YAxis yAxisId="current" hide domain={[0, 'dataMax + 1']} />
              {bindingIndex < chartData.length && <ReferenceArea yAxisId="power" x1={bindingIndex} x2={chartData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
              {hasBattery && seriesVisible('soc') && <ReferenceLine yAxisId="soc" y={plan.policy.battery_end_of_solar_target_soc * 100} stroke={COLORS.soc} strokeDasharray="3 3" strokeOpacity={0.45} />}
              {hasPv && seriesVisible('pv') && <Area yAxisId="power" type="monotone" dataKey="pv" name={seriesByKey.pv.label} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} />}
              {hasPv && seriesVisible('pvRaw') && <Line yAxisId="power" type="monotone" dataKey="pvRaw" name={seriesByKey.pvRaw.label} stroke={COLORS.pvRaw} strokeDasharray="4 3" dot={false} />}
              {seriesVisible('base') && <Area yAxisId="power" type="step" dataKey="base" stackId="load" name={seriesByKey.base.label} fill={COLORS.base} strokeWidth={0} />}
              {showBoilerAggregate && seriesVisible('boiler') && <Area yAxisId="power" type="step" dataKey="boiler" stackId="load" name={seriesByKey.boiler.label} fill={COLORS.boiler} strokeWidth={0} />}
              {showPoolAggregate && seriesVisible('pool') && <Area yAxisId="power" type="step" dataKey="pool" stackId="load" name={seriesByKey.pool.label} fill={COLORS.pool} strokeWidth={0} />}
              {showEvAggregate && seriesVisible('ev') && <Area yAxisId="power" type="step" dataKey="ev" stackId="load" name={seriesByKey.ev.label} fill={COLORS.ev} strokeWidth={0} />}
              {deviceSeries.map(series => seriesVisible(series.key) && (
                <Area key={series.key} yAxisId="power" type="step" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
              ))}
              {hasVariableEv && seriesVisible('evCurrent') && <Line yAxisId="current" type="stepAfter" dataKey="evCurrent" name={seriesByKey.evCurrent.label} stroke={COLORS.evCurrent} strokeWidth={2} dot={false} />}
              {seriesVisible('gridImport') && <Line yAxisId="power" type="step" dataKey="gridImport" name={seriesByKey.gridImport.label} stroke={COLORS.import} dot={false} />}
              {seriesVisible('gridExport') && <Line yAxisId="power" type="step" dataKey="gridExport" name={seriesByKey.gridExport.label} stroke={COLORS.export} dot={false} />}
              {hasBattery && seriesVisible('soc') && <Line yAxisId="soc" type="monotone" dataKey="soc" name={seriesByKey.soc.label} stroke={COLORS.soc} strokeWidth={2} dot={false} />}
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={(value, name) => [name === evCurrentLabel ? `${Number(value).toFixed(0)} A` : name === batterySocLabel ? `${Number(value).toFixed(1)}%` : `${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
            </ComposedChart>
          </ResponsiveContainer>
          <SeriesToggleLegend
            series={planChartSeries}
            hidden={hiddenSeries}
            onToggle={toggleSeries}
            ariaLabel={t('Diagramserier', 'Chart series')}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t('Välj en serie i teckenförklaringen för att visa eller dölja den. Baslasten innehåller alla enheter som inte är markerade som styrbara. Styrbara enheter visas separat och räknas inte en gång till i baslasten. Skuggat område är rådgivande eftersom båda prisserierna inte längre är publicerade.', 'Select any legend series to show or hide it. Base load contains every device not marked controllable. Controllable devices are shown separately and are not counted again in base load. The shaded interval is advisory because both price series are no longer published.')}
          </p>
        </CardContent>
      </Card>

      <ActualPerformance actuals={actuals} devices={empiricalDevices} deviceActuals={deviceActuals} />

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">{t('Import- och exportpris', 'Import and export prices')}</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={value => `${Number(value).toFixed(2)}`} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              {!hiddenPriceSeries.has('importPrice') && <Line type="stepAfter" dataKey="importPrice" name={priceSeries[0].label} stroke={COLORS.import} dot={false} connectNulls={false} />}
              {!hiddenPriceSeries.has('exportPrice') && <Line type="stepAfter" dataKey="exportPrice" name={priceSeries[1].label} stroke={COLORS.export} dot={false} connectNulls={false} />}
              <Tooltip labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={value => [`${Number(value).toFixed(3)} SEK/kWh`, '']} />
            </ComposedChart>
          </ResponsiveContainer>
          <SeriesToggleLegend
            series={priceSeries}
            hidden={hiddenPriceSeries}
            onToggle={togglePriceSeries}
            ariaLabel={t('Prisserier', 'Price series')}
          />
        </CardContent>
      </Card>

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
                  const minimumRunMinutes = 'min_run_slots' in service ? service.min_run_slots * 15 : 0;
                  return (
                    <div key={service.id}>
                      {service.id}: {service.required_kwh.toFixed(2)} kWh · {service.control.type === 'fixed_power'
                        ? `${(service.control.power_w / 1_000).toFixed(1)} kW · ${t('minsta körning', 'minimum run')} ${minimumRunMinutes} min`
                        : service.control.type === 'discrete_current'
                          ? `${service.control.min_current_a}–${service.control.max_current_a} A (${service.control.current_step_a} A ${t('steg', 'steps')}, ${service.control.phase_count}×${service.control.voltage_v} V) · ${t('minsta körning', 'minimum run')} ${minimumRunMinutes} min`
                          : `${t('empirisk förväntan', 'empirical expectation')} · ${(service.control.rated_power_w / 1_000).toFixed(1)} kW ${t('märkeffekt', 'rated')} · ${t('högst avstängd', 'maximum inhibit')} ${service.control.max_consecutive_inhibit_slots * 15} min`} · {t('fönster slutar', 'window ends')} {new Date(service.deadline).toLocaleString()}{samples != null ? ` · n=${samples} ${service.control.type === 'duty_cycle' ? t('kvartsvärden', 'quarter samples') : t('aktiva dagar', 'active days')}` : ''}
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

type ActualSeriesKey =
  | 'load'
  | 'pv'
  | 'gridImport'
  | 'gridExport'
  | 'batteryCharge'
  | 'batteryDischarge'
  | `device:${string}`;

const ActualPerformance: React.FC<{
  actuals: ActualEnergySlot[];
  devices: EmpiricalEnergyDevice[];
  deviceActuals: EmpiricalDeviceSlotMatrix[];
}> = ({ actuals, devices, deviceActuals }) => {
  const { t } = useLanguage();
  const [hidden, setHidden] = useState<Set<ActualSeriesKey>>(() => new Set());
  const controllableDevices = useMemo(
    () => devices.filter(device => effectivePlanningRole(device) === 'controllable'),
    [devices],
  );
  const actualByDeviceAndStart = useMemo(() => {
    const rows = new Map<string, number>();
    for (const slot of deviceActuals) {
      for (const [deviceId, energyKwh] of Object.entries(slot.device_energy_kwh)) {
        rows.set(`${deviceId}:${slot.start_ts}`, energyKwh * 4_000);
      }
    }
    return rows;
  }, [deviceActuals]);
  const data = useMemo(() => actuals.map((slot, index) => ({
    i: index,
    label: new Date(slot.start_ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    load: slot.total_load_kwh == null ? null : slot.total_load_kwh * 4_000,
    pv: slot.solar_production_kwh == null ? null : slot.solar_production_kwh * 4_000,
    gridImport: slot.grid_import_kwh == null ? null : slot.grid_import_kwh * 4_000,
    gridExport: slot.grid_export_kwh == null ? null : slot.grid_export_kwh * 4_000,
    batteryCharge: slot.battery_charge_kwh == null ? null : slot.battery_charge_kwh * 4_000,
    batteryDischarge: slot.battery_discharge_kwh == null ? null : slot.battery_discharge_kwh * 4_000,
    ...Object.fromEntries(controllableDevices.map((device, deviceIndex) => [
      `device${deviceIndex}`,
      actualByDeviceAndStart.get(`${device.id}:${slot.start_ts}`) ?? null,
    ])),
  })), [actualByDeviceAndStart, actuals, controllableDevices]);
  const ticks = data.filter((_, index) => index % 12 === 0).map(value => value.i);
  const series = [
    { key: 'load' as const, label: t('Faktisk last', 'Actual load'), color: COLORS.actual },
    { key: 'pv' as const, label: t('Faktisk sol', 'Actual PV'), color: COLORS.pv },
    { key: 'gridImport' as const, label: t('Faktisk import', 'Actual import'), color: COLORS.import },
    { key: 'gridExport' as const, label: t('Faktisk export', 'Actual export'), color: COLORS.export },
    { key: 'batteryCharge' as const, label: t('Faktisk batteriladdning', 'Actual battery charge'), color: COLORS.batteryCharge },
    { key: 'batteryDischarge' as const, label: t('Faktisk batteriurladdning', 'Actual battery discharge'), color: COLORS.batteryDischarge },
    ...controllableDevices.map((device, index) => ({
      key: `device:${device.id}` as const,
      dataKey: `device${index}`,
      label: `${device.name} · ${effectiveControlType(device)?.replace(/_/g, ' ')}`,
      color: DEVICE_COLORS[index % DEVICE_COLORS.length],
    })),
  ];
  const toggle = (key: ActualSeriesKey) => setHidden(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('Uppmätt prestanda — senaste 72 timmarna', 'Measured performance — last 72 hours')}</CardTitle>
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
                {series.map(item => !hidden.has(item.key) && (
                  <Line
                    key={item.key}
                    type="stepAfter"
                    dataKey={'dataKey' in item ? item.dataKey : item.key}
                    name={item.label}
                    stroke={item.color}
                    strokeWidth={item.key === 'load' || item.key === 'pv' ? 2 : 1.5}
                    dot={false}
                    connectNulls={false}
                  />
                ))}
                <Tooltip labelFormatter={index => data[index as number]?.label ?? ''} formatter={(value, name) => [`${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
              </ComposedChart>
            </ResponsiveContainer>
            <SeriesToggleLegend
              series={series}
              hidden={hidden}
              onToggle={toggle}
              ariaLabel={t('Uppmätta serier', 'Measured series')}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Varje punkt är energi från Home Assistants recorder summerad i en komplett kvart och visad som medeleffekt; råa sekundvärden lagras inte på webbplatsen.', 'Each point is Home Assistant recorder energy summed into one complete quarter and shown as average power; raw per-second values are not stored by the website.')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
};

const SourceRow: React.FC<{
  name: string;
  source: NonNullable<OptimisationPlanV5['sources'][keyof OptimisationPlanV5['sources']]>;
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

const DeltaKpi: React.FC<{
  label: string;
  value: string;
  detail: string;
  tone?: 'good' | 'bad';
  emphasized?: boolean;
}> = ({ label, value, detail, tone, emphasized = false }) => (
  <div className={`rounded-lg border p-3 ${
    tone === 'good'
      ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/25'
      : tone === 'bad'
        ? 'border-rose-300 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/25'
        : 'bg-muted/20'
  } ${emphasized ? 'md:ring-1 md:ring-current/10' : ''}`}>
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className={`mt-1 font-semibold tabular-nums ${emphasized ? 'text-2xl' : 'text-xl'} ${
      tone === 'good'
        ? 'text-emerald-700 dark:text-emerald-400'
        : tone === 'bad'
          ? 'text-rose-700 dark:text-rose-400'
          : ''
    }`}>{value}</div>
    <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
  </div>
);

const SeriesToggleLegend = <Key extends string,>({ series, hidden, onToggle, ariaLabel }: {
  series: Array<{ key: Key; label: string; color: string }>;
  hidden: Set<Key>;
  onToggle: (key: Key) => void;
  ariaLabel: string;
}) => (
  <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-2" role="group" aria-label={ariaLabel}>
    {series.map(item => {
      const visible = !hidden.has(item.key);
      return (
        <button
          key={item.key}
          type="button"
          aria-pressed={visible}
          onClick={() => onToggle(item.key)}
          className={`inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-xs transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${visible ? '' : 'opacity-40'}`}
        >
          <span
            className="h-0.5 w-4 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          <span className={visible ? '' : 'line-through'}>{item.label}</span>
        </button>
      );
    })}
  </div>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <Card><CardContent className="py-10 text-sm text-muted-foreground">{text}</CardContent></Card>
);

export default LoadShiftTab;
