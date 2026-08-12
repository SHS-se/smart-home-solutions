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
import { AlertTriangle, CheckCircle2, Clock3, Loader2, Sparkles } from 'lucide-react';
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
  type PortalOptimisationPlan,
  type ThermalFixtureSeason,
} from '@/lib/energy-shift/contracts';
import { createWebsiteDemoActuals, createWebsiteDemoPlan } from '@/lib/energy-shift/demo';
import { comparePlans, formatSigned } from '@/lib/energy-shift/plan-comparison';
import {
  foldDevicePowerIntoBase,
  reconcilePlanDeviceRoles,
} from '@/lib/energy-shift/plan-device-roles';
import {
  assessThermalReadiness,
  THERMAL_TRAINING_SLOTS,
  type ThermalObservationSummary,
  type ThermalReadinessState,
} from '@/lib/energy-shift/thermal-readiness';
import EmpiricalDeviceModelsCard, {
  type EmpiricalEnergyDevice,
} from './EmpiricalDeviceModelsCard';

interface LoadShiftTabProps {
  customerId?: string;
  homeId: string | null;
  accountPath: string;
}

interface CurrentRow {
  plan: PortalOptimisationPlan;
  captured_at: string;
  updated_at: string;
}

const EMPTY_THERMAL_OBSERVATIONS: ThermalObservationSummary = {
  slotCount: 0,
  outdoorSlotCount: 0,
  observedDeviceKeys: [],
  firstObservedAt: null,
  lastObservedAt: null,
};

interface ThermalSlotRow {
  start_ts: string;
  outdoor_temperature_c: number | null;
  zone_observations: Record<string, unknown> | null;
}

/**
 * Reduce the stored thermal rows to the counts the readiness panel needs.
 * Rows are already one per quarter, so this stays cheap over a 30-day window.
 */
const summariseThermalSlots = (
  rows: ThermalSlotRow[] | null,
): ThermalObservationSummary => {
  if (!rows || rows.length === 0) return EMPTY_THERMAL_OBSERVATIONS;
  const observedDeviceKeys = new Set<string>();
  let outdoorSlotCount = 0;
  for (const row of rows) {
    if (row.outdoor_temperature_c !== null) outdoorSlotCount += 1;
    for (const key of Object.keys(row.zone_observations ?? {})) {
      observedDeviceKeys.add(key);
    }
  }
  return {
    slotCount: rows.length,
    outdoorSlotCount,
    observedDeviceKeys: [...observedDeviceKeys],
    firstObservedAt: rows[0]?.start_ts ?? null,
    lastObservedAt: rows[rows.length - 1]?.start_ts ?? null,
  };
};

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
  pv: '#f59e0b',
  soc: '#f43f5e',
  import: '#dc2626',
  export: '#0f766e',
  actual: '#111827',
  batteryCharge: '#2563eb',
  batteryDischarge: '#7c3aed',
  batteryExport: '#059669',
};

type PlanViewMode = 'planned' | 'unplanned';
type PlanningDimension = 'power' | 'thermal' | 'economics' | 'storage';
type PlanChartSeriesKey =
  | 'pv'
  | 'base'
  | 'boiler'
  | 'pool'
  | 'ev'
  | 'gridImport'
  | 'gridExport'
  | `device:${string}`;
type ThermalSeriesKey =
  | 'outdoor'
  | 'thermalPower'
  | `zoneTemperature:${string}`
  | `zoneTarget:${string}`;
type EconomicsSeriesKey =
  | 'importPrice'
  | 'exportPrice'
  | 'plannedCost'
  | 'unplannedCost'
  | 'costDifference';
type StorageSeriesKey =
  | 'homeSoc'
  | 'homeTarget'
  | 'homeCharge'
  | 'homeDischarge'
  | 'homeExport'
  | 'evSoc'
  | 'evTarget'
  | 'evCharge';

interface PlanChartSeries {
  key: PlanChartSeriesKey;
  label: string;
  color: string;
  dataKey?: string;
}

const DEVICE_COLORS = ['#0ea5e9', '#8b5cf6', '#22c55e', '#eab308', '#f97316', '#ec4899', '#06b6d4', '#84cc16'];

const useSeriesVisibility = <T extends string>() => {
  const [hidden, setHidden] = useState<Set<T>>(() => new Set());
  const toggle = useCallback((key: T) => {
    setHidden(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return { hidden, toggle, visible: (key: T) => !hidden.has(key) };
};

const LoadShiftTab: React.FC<LoadShiftTabProps> = ({ customerId, homeId, accountPath }) => {
  const { t } = useLanguage();
  const [current, setCurrent] = useState<CurrentRow | null>(null);
  const [actuals, setActuals] = useState<ActualEnergySlot[]>([]);
  const [empiricalDevices, setEmpiricalDevices] = useState<EmpiricalEnergyDevice[]>([]);
  const [deviceActuals, setDeviceActuals] = useState<EmpiricalDeviceSlotMatrix[]>([]);
  const [thermalObservations, setThermalObservations] = useState<ThermalObservationSummary>(
    EMPTY_THERMAL_OBSERVATIONS,
  );
  const [connections, setConnections] = useState<HomeAssistantConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'live' | 'demo'>('live');
  const [demoSeason, setDemoSeason] = useState<ThermalFixtureSeason>('winter');
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  const load = useCallback(async (background = false) => {
    if (!customerId || !homeId) {
      setCurrent(null);
      setActuals([]);
      setEmpiricalDevices([]);
      setDeviceActuals([]);
      setThermalObservations(EMPTY_THERMAL_OBSERVATIONS);
      setConnections([]);
      return;
    }
    if (!background) setLoading(true);
    setError(null);
    try {
      const toMs = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
      const from = new Date(toMs - 72 * 60 * 60_000).toISOString();
      const to = new Date(toMs).toISOString();
      const [
        planResult,
        actualResult,
        connectionResult,
        deviceResult,
        deviceActualResult,
        thermalResult,
      ] = await Promise.all([
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
          .select('id, device_key, statistic_id, name, category, load_type_override, planning_role_override, control_type_override, mapping_status, mapped_control_type, mapping_error, mapping_reported_at, active_power_w, profile_sample_count, last_seen_at')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .order('name'),
        supabase.rpc('get_energy_optimisation_device_slots', {
          p_customer_id: customerId,
          p_home_id: homeId,
          p_from: from,
          p_to: to,
        }),
        // The readiness panel reports on the whole training window, not the
        // 72 hours the charts draw, so a zone that stopped reporting
        // yesterday still shows the history it did deliver.
        supabase.rpc('get_energy_optimisation_thermal_slots', {
          p_customer_id: customerId,
          p_home_id: homeId,
          p_from: new Date(toMs - 30 * 24 * 60 * 60_000).toISOString(),
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
      // A thermal read failure must not blank the electrical plan; the panel
      // simply reports nothing received.
      setThermalObservations(
        thermalResult.error
          ? EMPTY_THERMAL_OBSERVATIONS
          : summariseThermalSlots(
            thermalResult.data as unknown as ThermalSlotRow[] | null,
          ),
      );
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
    const plan = createWebsiteDemoPlan(demoReferenceTime, demoSeason);
    return { plan, captured_at: plan.issued_at, updated_at: plan.issued_at };
  }, [demoReferenceTime, demoSeason]);
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
        thermalObservations={EMPTY_THERMAL_OBSERVATIONS}
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
          thermalObservations={thermalObservations}
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
      {view === 'demo' && (
        <div className="flex flex-wrap justify-end gap-1" role="group" aria-label={t('Demoperiod', 'Demo season')}>
          {([
            ['winter', t('Vinter', 'Winter')],
            ['spring', t('Vår', 'Spring')],
            ['summer', t('Sommar', 'Summer')],
            ['autumn', t('Höst', 'Autumn')],
            ['ev_only', t('Enkel EV-kund', 'Simple EV customer')],
          ] as const).map(([season, label]) => (
            <Button
              key={season}
              size="sm"
              variant={demoSeason === season ? 'secondary' : 'ghost'}
              aria-pressed={demoSeason === season}
              onClick={() => setDemoSeason(season)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
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
  thermalObservations: ThermalObservationSummary;
  deviceActuals: EmpiricalDeviceSlotMatrix[];
  stale: boolean;
  isDemo: boolean;
  lastCheckedAt?: number | null;
}> = ({
  current,
  actuals,
  empiricalDevices,
  deviceActuals,
  thermalObservations,
  stale,
  isDemo,
  lastCheckedAt,
}) => {
  const { t } = useLanguage();
  const { plan } = current;
  const [planView, setPlanView] = useState<PlanViewMode>('planned');
  const [dimension, setDimension] = useState<PlanningDimension>('power');
  const powerVisibility = useSeriesVisibility<PlanChartSeriesKey>();
  const thermalVisibility = useSeriesVisibility<ThermalSeriesKey>();
  const economicsVisibility = useSeriesVisibility<EconomicsSeriesKey>();
  const storageVisibility = useSeriesVisibility<StorageSeriesKey>();
  // Home Assistant executes the priority scenario. Baseline is exposed only
  // as a counterfactual chart and cannot change local control.
  const executed = plan.plans.priority;
  const active = planView === 'planned' ? plan.plans.priority : plan.plans.baseline;
  const comparison = useMemo(
    () => comparePlans(plan.plans.priority, plan.plans.baseline),
    [plan],
  );
  const deviceRoleView = useMemo(
    () => reconcilePlanDeviceRoles(plan.device_models, empiricalDevices),
    [empiricalDevices, plan.device_models],
  );
  const chartData = useMemo(() => active.slots.map((slot, index) => {
    return {
      i: index,
      start: slot.start,
      label: new Date(slot.start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      pv: slot.pv_w,
      base: foldDevicePowerIntoBase(
        slot.base_w,
        slot.device_loads_w,
        deviceRoleView.baseLoadModels,
      ),
      boiler: slot.boiler_expected_w,
      pool: slot.pool_w,
      ev: slot.ev_w,
      homeSoc: slot.battery_soc * 100,
      homeTarget: plan.policy.battery_end_of_solar_target_soc * 100,
      evSoc: slot.ev_soc === null ? null : slot.ev_soc * 100,
      evTarget: plan.ev_battery?.departure_target_soc == null
        ? null
        : plan.ev_battery.departure_target_soc * 100,
      evConnected: slot.ev_connected,
      homeCharge: slot.battery_charge_w,
      homeDischarge: slot.battery_discharge_w,
      homeExport: slot.battery_export_w,
      evCharge: slot.ev_w,
      gridImport: slot.grid_import_w,
      gridExport: slot.grid_export_w,
      importPrice: slot.import_price_sek_per_kwh,
      exportPrice: slot.export_price_sek_per_kwh,
      ...Object.fromEntries(deviceRoleView.visibleModels.map((model, modelIndex) => [
        `device${modelIndex}`,
        slot.device_loads_w[model.key] ?? 0,
      ])),
    };
  }), [active, deviceRoleView, plan.ev_battery, plan.policy.battery_end_of_solar_target_soc]);
  const economicsData = useMemo(() => {
    let plannedCost = 0;
    let unplannedCost = 0;
    let plannedPriced = true;
    let unplannedPriced = true;
    return plan.plans.priority.slots.map((slot, index) => {
      const baseline = plan.plans.baseline.slots[index];
      if (slot.import_cost_sek === null || slot.export_revenue_sek === null) {
        plannedPriced = false;
      } else if (plannedPriced) {
        plannedCost += slot.import_cost_sek - slot.export_revenue_sek;
      }
      if (baseline.import_cost_sek === null || baseline.export_revenue_sek === null) {
        unplannedPriced = false;
      } else if (unplannedPriced) {
        unplannedCost += baseline.import_cost_sek - baseline.export_revenue_sek;
      }
      return {
        i: index,
        label: new Date(slot.start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        importPrice: slot.import_price_sek_per_kwh,
        exportPrice: slot.export_price_sek_per_kwh,
        plannedCost: plannedPriced ? plannedCost : null,
        unplannedCost: unplannedPriced ? unplannedCost : null,
        costDifference: plannedPriced && unplannedPriced
          ? plannedCost - unplannedCost
          : null,
      };
    });
  }, [plan]);
  const thermalProjection = plan.thermal_projection;
  const thermalData = useMemo(() => thermalProjection?.starts.map((start, index) => ({
    i: index,
    label: new Date(start).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    outdoor: thermalProjection.outdoor_temperature_c[index],
    thermalPower: planView === 'planned'
      ? thermalProjection.planned_total_power_w[index]
      : thermalProjection.unplanned_total_power_w[index],
    ...Object.fromEntries(thermalProjection.zones.flatMap((zone, zoneIndex) => [
      [
        `zoneTemperature${zoneIndex}`,
        planView === 'planned'
          ? zone.planned_temperature_c[index]
          : zone.unplanned_temperature_c[index],
      ],
      [`zoneTarget${zoneIndex}`, zone.target_c[index]],
    ])),
  })) ?? [], [planView, thermalProjection]);
  const firstAdvisory = active.slots.findIndex(slot => !slot.binding);
  const bindingIndex = firstAdvisory < 0 ? active.slots.length : firstAdvisory;
  const ticks = active.slots.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => new Date(slot.start).getMinutes() === 0 && new Date(slot.start).getHours() % 6 === 0)
    .map(({ index }) => index);
  const hasBattery = plan.capabilities.battery && plan.battery !== null;
  const hasEvBattery = plan.capabilities.ev && plan.ev_battery != null;
  const hasPv = plan.capabilities.pv;
  const sourceStale = Object.entries(plan.sources)
    .filter(([, source]) => source !== null && Date.parse(source.valid_until) < Date.now())
    .map(([name]) => name);
  const bindingExpired = Date.now() >= Date.parse(plan.binding_until);
  const ready = !stale && !bindingExpired && plan.status === 'ready' && executed.status === 'ready' && sourceStale.length === 0;
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  const seriesByKey: Record<Exclude<PlanChartSeriesKey, `device:${string}`>, PlanChartSeries> = {
    pv: { key: 'pv', label: t('Solprognos', 'Solar forecast'), color: COLORS.pv },
    base: { key: 'base', label: t('Baslast', 'Base load'), color: COLORS.base },
    boiler: { key: 'boiler', label: t('Förväntat varmvatten', 'Expected hot water'), color: COLORS.boiler },
    pool: { key: 'pool', label: t('Pool', 'Pool'), color: COLORS.pool },
    ev: { key: 'ev', label: t('Bil', 'EV'), color: COLORS.ev },
    gridImport: { key: 'gridImport', label: t('Importeffekt', 'Grid import'), color: COLORS.import },
    gridExport: { key: 'gridExport', label: t('Exporteffekt', 'Grid export'), color: COLORS.export },
  };
  const deviceSeries: PlanChartSeries[] = deviceRoleView.visibleModels.map((model, index) => ({
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
    ...(hasPv ? [seriesByKey.pv] : []),
    seriesByKey.base,
    ...(showBoilerAggregate ? [seriesByKey.boiler] : []),
    ...(showPoolAggregate ? [seriesByKey.pool] : []),
    ...(showEvAggregate ? [seriesByKey.ev] : []),
    ...deviceSeries,
    seriesByKey.gridImport,
    seriesByKey.gridExport,
  ];
  const thermalSeries = [
    { key: 'outdoor' as const, label: t('Utomhus', 'Outdoor'), color: '#475569' },
    { key: 'thermalPower' as const, label: t('Samordnad värmeeffekt', 'Coordinated heat power'), color: '#f97316' },
    ...(thermalProjection?.zones.flatMap((zone, index) => [
      {
        key: `zoneTemperature:${zone.key}` as const,
        dataKey: `zoneTemperature${index}`,
        label: `${zone.name} · ${t('temperatur', 'temperature')}`,
        color: DEVICE_COLORS[index % DEVICE_COLORS.length],
      },
      {
        key: `zoneTarget:${zone.key}` as const,
        dataKey: `zoneTarget${index}`,
        label: `${zone.name} · ${t('börvärde', 'target')}`,
        color: DEVICE_COLORS[index % DEVICE_COLORS.length],
      },
    ]) ?? []),
  ];
  const economicsSeries = [
    { key: 'importPrice' as const, label: t('Köppris', 'Import price'), color: COLORS.import },
    { key: 'exportPrice' as const, label: t('Säljpris', 'Export price'), color: COLORS.export },
    { key: 'plannedCost' as const, label: t('Kumulativ kostnad med plan', 'Cumulative cost with plan'), color: '#2563eb' },
    { key: 'unplannedCost' as const, label: t('Kumulativ kostnad utan plan', 'Cumulative cost without plan'), color: '#64748b' },
    { key: 'costDifference' as const, label: t('Kostnadsskillnad', 'Cost difference'), color: '#a855f7' },
  ];
  const storageSeries = [
    ...(hasBattery ? [
      { key: 'homeSoc' as const, label: t('Hembatteri SOC', 'Home battery SOC'), color: COLORS.soc },
      { key: 'homeTarget' as const, label: t('Hembatteriets mål', 'Home battery target'), color: '#fb7185' },
      { key: 'homeCharge' as const, label: t('Batteriladdning', 'Battery charge'), color: COLORS.batteryCharge },
      { key: 'homeDischarge' as const, label: t('Total batteriurladdning', 'Total battery discharge'), color: COLORS.batteryDischarge },
      { key: 'homeExport' as const, label: t('Batteriexport till nätet', 'Battery-to-grid export'), color: COLORS.batteryExport },
    ] : []),
    ...(hasEvBattery ? [
      { key: 'evSoc' as const, label: t('Bilbatteri SOC', 'EV battery SOC'), color: COLORS.ev },
      { key: 'evTarget' as const, label: t('Bilens avgångsmål', 'EV departure target'), color: '#c084fc' },
      { key: 'evCharge' as const, label: t('Billaddning', 'EV charge'), color: '#7c3aed' },
    ] : []),
  ];
  const dimensionLabels: Array<{ key: PlanningDimension; label: string }> = [
    { key: 'power', label: t('Effekt', 'Power') },
    { key: 'thermal', label: t('Termik', 'Thermal') },
    { key: 'economics', label: t('Ekonomi', 'Economics') },
    { key: 'storage', label: t('Lagring', 'Storage') },
  ];
  const connectedIndices = chartData
    .filter(row => row.evConnected)
    .map(row => row.i);
  const evConnectedStart = connectedIndices.at(0);
  const evConnectedEnd = connectedIndices.at(-1);
  const costDelta = comparison.terminalAdjustedCostSekDelta;
  const costTone = costDelta < -0.005 ? 'good' : costDelta > 0.005 ? 'bad' : undefined;
  const costMeaning = costDelta < -0.005
    ? t('uppskattad besparing', 'estimated saving')
    : costDelta > 0.005
      ? t('uppskattad merkostnad', 'estimated added cost')
      : t('ingen uppskattad förändring', 'no estimated change');
  const validationMessages = [...new Set(
    plan.validation_errors.length > 0
      ? plan.validation_errors
      : executed.validation_errors,
  )];

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
      {(!ready || validationMessages.length > 0) && (
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
              ...validationMessages,
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

          <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label={t('Planens dimension', 'Plan dimension')}>
            {dimensionLabels.map(item => (
              <Button
                key={item.key}
                size="sm"
                variant={dimension === item.key ? 'secondary' : 'ghost'}
                aria-pressed={dimension === item.key}
                onClick={() => setDimension(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </div>

          {dimension === 'power' && (
            <>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                  <YAxis yAxisId="power" tick={{ fontSize: 11 }} tickFormatter={watts => `${(Number(watts) / 1_000).toFixed(0)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  {bindingIndex < chartData.length && <ReferenceArea yAxisId="power" x1={bindingIndex} x2={chartData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
                  {hasPv && powerVisibility.visible('pv') && <Area yAxisId="power" type="monotone" dataKey="pv" name={seriesByKey.pv.label} stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.14} dot={false} />}
                  {powerVisibility.visible('base') && <Area yAxisId="power" type="step" dataKey="base" stackId="load" name={seriesByKey.base.label} fill={COLORS.base} strokeWidth={0} />}
                  {showBoilerAggregate && powerVisibility.visible('boiler') && <Area yAxisId="power" type="step" dataKey="boiler" stackId="load" name={seriesByKey.boiler.label} fill={COLORS.boiler} strokeWidth={0} />}
                  {showPoolAggregate && powerVisibility.visible('pool') && <Area yAxisId="power" type="step" dataKey="pool" stackId="load" name={seriesByKey.pool.label} fill={COLORS.pool} strokeWidth={0} />}
                  {showEvAggregate && powerVisibility.visible('ev') && <Area yAxisId="power" type="step" dataKey="ev" stackId="load" name={seriesByKey.ev.label} fill={COLORS.ev} strokeWidth={0} />}
                  {deviceSeries.map(series => powerVisibility.visible(series.key) && (
                    <Area key={series.key} yAxisId="power" type="step" dataKey={series.dataKey} stackId="load" name={series.label} fill={series.color} stroke={series.color} fillOpacity={0.65} strokeWidth={1} />
                  ))}
                  {powerVisibility.visible('gridImport') && <Line yAxisId="power" type="step" dataKey="gridImport" name={seriesByKey.gridImport.label} stroke={COLORS.import} dot={false} />}
                  {powerVisibility.visible('gridExport') && <Line yAxisId="power" type="step" dataKey="gridExport" name={seriesByKey.gridExport.label} stroke={COLORS.export} dot={false} />}
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={(value, name) => [`${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
                </ComposedChart>
              </ResponsiveContainer>
              <SeriesToggleLegend
                series={planChartSeries}
                hidden={powerVisibility.hidden}
                onToggle={powerVisibility.toggle}
                ariaLabel={t('Effektserier', 'Power series')}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t('Baslasten innehåller varje enhet som inte är markerad som styrbar. Styrbara enheter visas separat och räknas inte dubbelt.', 'Base load contains every device not marked controllable. Controllable devices are shown separately and are not double-counted.')}
                {deviceRoleView.requiresPlanRefresh && ` ${t(
                  'Den ändrade enhetsrollen visas direkt; schema- och kostnadsberäkningarna uppdateras vid nästa Home Assistant-plan.',
                  'The changed device role is shown immediately; schedule and cost calculations update with the next Home Assistant plan.',
                )}`}
              </p>
            </>
          )}

          {dimension === 'thermal' && (thermalProjection && thermalProjection.zones.length > 0 && thermalData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={thermalData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="i" type="number" domain={[0, thermalData.length - 1]} ticks={ticks} tickFormatter={index => thermalData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                  <YAxis yAxisId="temperature" tick={{ fontSize: 11 }} tickFormatter={value => `${Number(value).toFixed(0)}°`} label={{ value: '°C', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <YAxis yAxisId="power" orientation="right" tick={{ fontSize: 11 }} tickFormatter={value => `${(Number(value) / 1_000).toFixed(1)}`} label={{ value: 'kW', angle: 90, position: 'insideRight', fontSize: 11 }} />
                  {thermalVisibility.visible('thermalPower') && <Area yAxisId="power" type="step" dataKey="thermalPower" name={thermalSeries[1].label} stroke="#f97316" fill="#f97316" fillOpacity={0.16} dot={false} />}
                  {thermalVisibility.visible('outdoor') && <Line yAxisId="temperature" type="monotone" dataKey="outdoor" name={thermalSeries[0].label} stroke="#475569" strokeWidth={2} dot={false} />}
                  {thermalProjection.zones.map((zone, index) => (
                    <React.Fragment key={zone.key}>
                      {thermalVisibility.visible(`zoneTemperature:${zone.key}`) && <Line yAxisId="temperature" type="monotone" dataKey={`zoneTemperature${index}`} name={thermalSeries[2 + index * 2].label} stroke={DEVICE_COLORS[index % DEVICE_COLORS.length]} strokeWidth={2} dot={false} />}
                      {thermalVisibility.visible(`zoneTarget:${zone.key}`) && <Line yAxisId="temperature" type="stepAfter" dataKey={`zoneTarget${index}`} name={thermalSeries[3 + index * 2].label} stroke={DEVICE_COLORS[index % DEVICE_COLORS.length]} strokeDasharray="4 3" strokeOpacity={0.65} dot={false} />}
                    </React.Fragment>
                  ))}
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => thermalData[index as number]?.label ?? ''} formatter={(value, name) => [name === thermalSeries[1].label ? `${(Number(value) / 1_000).toFixed(2)} kW` : `${Number(value).toFixed(1)} °C`, name]} />
                </ComposedChart>
              </ResponsiveContainer>
              <SeriesToggleLegend
                series={thermalSeries}
                hidden={thermalVisibility.hidden}
                onToggle={thermalVisibility.toggle}
                ariaLabel={t('Termiska serier', 'Thermal series')}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {thermalProjection.source === 'synthetic_season_fixture'
                  ? t('Detta är en 72-timmars skuggprojektion för säsongstest. Den visar samordning och komfort men ingår ännu inte i den körbara planen.', 'This is a 72-hour shadow projection for seasonal testing. It shows coordination and comfort but is not yet part of the executable plan.')
                  : t('Temperaturprojektionen bygger på bekräftade Home Assistant-bindningar och historik.', 'The temperature projection uses confirmed Home Assistant bindings and history.')}
              </p>
            </>
          ) : (
            <ThermalReadinessPanel
              devices={empiricalDevices}
              planDevices={plan.device_models}
              observations={thermalObservations}
            />
          ))}

          {dimension === 'economics' && (
            <>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={economicsData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="i" type="number" domain={[0, economicsData.length - 1]} ticks={ticks} tickFormatter={index => economicsData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                  <YAxis yAxisId="price" tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(2)} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 11 }} tickFormatter={value => Number(value).toFixed(0)} label={{ value: 'SEK', angle: 90, position: 'insideRight', fontSize: 11 }} />
                  {bindingIndex < economicsData.length && <ReferenceArea yAxisId="price" x1={bindingIndex} x2={economicsData.length - 1} fill="currentColor" className="text-muted" fillOpacity={0.24} />}
                  {economicsVisibility.visible('importPrice') && <Line yAxisId="price" type="stepAfter" dataKey="importPrice" name={economicsSeries[0].label} stroke={COLORS.import} dot={false} connectNulls={false} />}
                  {economicsVisibility.visible('exportPrice') && <Line yAxisId="price" type="stepAfter" dataKey="exportPrice" name={economicsSeries[1].label} stroke={COLORS.export} dot={false} connectNulls={false} />}
                  {economicsVisibility.visible('plannedCost') && <Line yAxisId="cost" type="monotone" dataKey="plannedCost" name={economicsSeries[2].label} stroke="#2563eb" strokeWidth={2} dot={false} connectNulls={false} />}
                  {economicsVisibility.visible('unplannedCost') && <Line yAxisId="cost" type="monotone" dataKey="unplannedCost" name={economicsSeries[3].label} stroke="#64748b" strokeWidth={2} dot={false} connectNulls={false} />}
                  {economicsVisibility.visible('costDifference') && <Line yAxisId="cost" type="monotone" dataKey="costDifference" name={economicsSeries[4].label} stroke="#a855f7" strokeDasharray="4 3" dot={false} connectNulls={false} />}
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => economicsData[index as number]?.label ?? ''} formatter={(value, name) => [name === economicsSeries[0].label || name === economicsSeries[1].label ? `${Number(value).toFixed(3)} SEK/kWh` : `${Number(value).toFixed(2)} SEK`, name]} />
                </ComposedChart>
              </ResponsiveContainer>
              <SeriesToggleLegend
                series={economicsSeries}
                hidden={economicsVisibility.hidden}
                onToggle={economicsVisibility.toggle}
                ariaLabel={t('Ekonomiserier', 'Economics series')}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {t('Priset visas tillsammans med den kostnad det faktiskt skapar i planen. Positiv kostnadsskillnad betyder merkostnad; negativ betyder uppskattad besparing.', 'Price is shown with the cost it actually creates in the plan. A positive cost difference means added cost; a negative value means estimated savings.')}
              </p>
            </>
          )}

          {dimension === 'storage' && (hasBattery || hasEvBattery ? (
            <>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                  <XAxis dataKey="i" type="number" domain={[0, chartData.length - 1]} ticks={ticks} tickFormatter={index => chartData[index]?.label ?? ''} tick={{ fontSize: 11 }} interval={0} />
                  <YAxis yAxisId="power" tick={{ fontSize: 11 }} tickFormatter={value => `${(Number(value) / 1_000).toFixed(1)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                  <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={value => `${value}%`} />
                  {evConnectedStart !== undefined && evConnectedEnd !== undefined && <ReferenceArea yAxisId="soc" x1={evConnectedStart} x2={evConnectedEnd + 1} y1={0} y2={100} fill={COLORS.ev} fillOpacity={0.06} />}
                  {storageVisibility.visible('homeCharge') && <Area yAxisId="power" type="step" dataKey="homeCharge" name={storageSeries.find(item => item.key === 'homeCharge')?.label} fill={COLORS.batteryCharge} stroke={COLORS.batteryCharge} fillOpacity={0.18} dot={false} />}
                  {storageVisibility.visible('homeDischarge') && <Area yAxisId="power" type="step" dataKey="homeDischarge" name={storageSeries.find(item => item.key === 'homeDischarge')?.label} fill={COLORS.batteryDischarge} stroke={COLORS.batteryDischarge} fillOpacity={0.18} dot={false} />}
                  {storageVisibility.visible('homeExport') && <Line yAxisId="power" type="step" dataKey="homeExport" name={storageSeries.find(item => item.key === 'homeExport')?.label} stroke={COLORS.batteryExport} strokeWidth={2} strokeDasharray="5 3" dot={false} />}
                  {storageVisibility.visible('evCharge') && <Area yAxisId="power" type="step" dataKey="evCharge" name={storageSeries.find(item => item.key === 'evCharge')?.label} fill="#7c3aed" stroke="#7c3aed" fillOpacity={0.12} dot={false} />}
                  {storageVisibility.visible('homeSoc') && <Line yAxisId="soc" type="monotone" dataKey="homeSoc" name={storageSeries.find(item => item.key === 'homeSoc')?.label} stroke={COLORS.soc} strokeWidth={2} dot={false} />}
                  {storageVisibility.visible('homeTarget') && <Line yAxisId="soc" type="stepAfter" dataKey="homeTarget" name={storageSeries.find(item => item.key === 'homeTarget')?.label} stroke="#fb7185" strokeDasharray="4 3" dot={false} />}
                  {storageVisibility.visible('evSoc') && <Line yAxisId="soc" type="monotone" dataKey="evSoc" name={storageSeries.find(item => item.key === 'evSoc')?.label} stroke={COLORS.ev} strokeWidth={2} dot={false} connectNulls={false} />}
                  {storageVisibility.visible('evTarget') && <Line yAxisId="soc" type="stepAfter" dataKey="evTarget" name={storageSeries.find(item => item.key === 'evTarget')?.label} stroke="#c084fc" strokeDasharray="4 3" dot={false} connectNulls={false} />}
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={index => chartData[index as number]?.label ?? ''} formatter={(value, name) => [String(name).includes('SOC') || String(name).includes(t('mål', 'target')) ? `${Number(value).toFixed(1)}%` : `${(Number(value) / 1_000).toFixed(2)} kW`, name]} />
                </ComposedChart>
              </ResponsiveContainer>
              <SeriesToggleLegend
                series={storageSeries}
                hidden={storageVisibility.hidden}
                onToggle={storageVisibility.toggle}
                ariaLabel={t('Lagringsserier', 'Storage series')}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {plan.ev_battery
                  ? `${plan.ev_battery.name}: ${pct(plan.ev_battery.soc)} → ${pct(plan.ev_battery.departure_target_soc)} · ${plan.ev_battery.capacity_kwh.toFixed(1)} kWh · ${t('prioritet', 'priority')} ${plan.ev_battery.priority} (${t('1 är högst', '1 is highest')})${plan.ev_battery.departure ? ` · ${t('avgång', 'departure')} ${new Date(plan.ev_battery.departure).toLocaleString()}` : ''}. `
                  : ''}
                {hasBattery
                  ? plan.policy.battery_export_enabled
                    ? `${t('Planerad batteriexport vid minst', 'Planned battery export at or above')} ${plan.policy.battery_export_min_price_sek_per_kwh.toFixed(2)} SEK/kWh · ${t('exportreserv', 'export reserve')} ${pct(plan.policy.battery_export_reserve_soc)}. ${t('Detta visualiserar en rådgivande preferens; batteriutförande är ännu inte aktiverat.', 'This visualizes an advisory preference; battery execution is not enabled yet.')} `
                    : `${t('Planerad batteriexport är avstängd.', 'Planned battery export is disabled.')} `
                  : ''}
                {t('Det skuggade intervallet visar när bilen är ansluten och tillgänglig för planerad laddning.', 'The shaded interval shows when the EV is connected and available for planned charging.')}
              </p>
            </>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {t('Detta hem har ingen publicerad batteri- eller EV-modell.', 'This home has no published battery or EV model.')}
            </p>
          ))}
        </CardContent>
      </Card>

      <ActualPerformance actuals={actuals} devices={empiricalDevices} deviceActuals={deviceActuals} />

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
            {plan.ev_battery && (
              <div className="mt-1 text-xs text-muted-foreground">
                {plan.ev_battery.name} · SOC {pct(plan.ev_battery.soc)} → {pct(plan.ev_battery.departure_target_soc)} · {plan.ev_battery.capacity_kwh.toFixed(2)} kWh · η {(plan.ev_battery.charge_efficiency * 100).toFixed(0)}% · {t('prioritet', 'priority')} {plan.ev_battery.priority} ({t('1 är högst', '1 is highest')}) · {plan.ev_battery.connected ? t('ansluten', 'connected') : t('inte ansluten', 'not connected')}
              </div>
            )}
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
                          : `${t('empirisk förväntan', 'empirical expectation')} · ${(service.control.rated_power_w / 1_000).toFixed(1)} kW ${t('märkeffekt', 'rated')} · ${t('högst avstängd', 'maximum inhibit')} ${service.control.max_consecutive_inhibit_slots * 15} min`} · {t('prioritet', 'priority')} {service.priority} · {t('fönster slutar', 'window ends')} {new Date(service.deadline).toLocaleString()}{samples != null ? ` · n=${samples} ${service.control.type === 'duty_cycle' ? t('kvartsvärden', 'quarter samples') : t('aktiva dagar', 'active days')}` : ''}
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

type ReadinessState = 'ready' | 'blocked' | 'waiting';

const ThermalReadinessRow: React.FC<{
  label: string;
  detail: string;
  state: ReadinessState;
  stateLabel: string;
}> = ({ label, detail, state, stateLabel }) => {
  const Icon = state === 'ready' ? CheckCircle2 : state === 'blocked' ? AlertTriangle : Clock3;
  const tone = state === 'ready'
    ? 'text-emerald-700 dark:text-emerald-400'
    : state === 'blocked'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-muted-foreground';
  return (
    <div className="flex items-start justify-between gap-4 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      <Badge variant="outline" className={`shrink-0 ${tone}`}>{stateLabel}</Badge>
    </div>
  );
};

const ThermalReadinessPanel: React.FC<{
  devices: EmpiricalEnergyDevice[];
  planDevices: OptimisationPlanV5['device_models'];
  observations: ThermalObservationSummary;
}> = ({ devices, planDevices, observations }) => {
  const { t } = useLanguage();
  const readiness = useMemo(
    () => assessThermalReadiness(devices, planDevices, observations),
    [devices, planDevices, observations],
  );
  const selectedCount = readiness.selectedDevices.length;
  const allMappingsReady = selectedCount > 0
    && readiness.mappingReadyCount === selectedCount;
  const allHistoryReady = selectedCount > 0
    && readiness.electricalHistoryReadyCount === selectedCount;
  const allForecastsReady = selectedCount > 0
    && readiness.electricalForecastReadyCount === selectedCount;
  const readyLabel = t('Klar', 'Ready');
  const blockedLabel = t('Blockerad', 'Blocked');
  const waitingLabel = t('Väntar', 'Waiting');
  const stateLabels: Record<ThermalReadinessState, string> = {
    ready: readyLabel,
    blocked: blockedLabel,
    waiting: waitingLabel,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 py-5 text-left">
      {!readiness.pipelineComplete && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">
                {t(
                  'Den termiska modellen väntar på observationer',
                  'The thermal model is waiting on observations',
                )}
              </p>
              <p className="mt-1 text-sm opacity-90">
                {t(
                  'Rumstemperatur, aktuatorstatus och utomhustemperatur samlas in per kvart av integrationen. Raderna nedan visar vad som redan tas emot och vad som saknas.',
                  'Room temperature, actuator state, and outdoor temperature are collected per quarter by the integration. The rows below show what is already arriving and what is still missing.',
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border px-4">
        <ThermalReadinessRow
          label={t('Värmeenheter valda för börvärdesstyrning', 'Heaters selected for setpoint control')}
          detail={selectedCount > 0
            ? t(`${selectedCount} enheter är valda på webbplatsen.`, `${selectedCount} devices are selected on the website.`)
            : t('Välj Styrbar · Börvärde för minst en värmeenhet.', 'Select Controllable · Setpoint for at least one heater.')}
          state={selectedCount > 0 ? 'ready' : 'blocked'}
          stateLabel={selectedCount > 0 ? readyLabel : blockedLabel}
        />
        <ThermalReadinessRow
          label={t('Lokala Home Assistant-mappningar', 'Local Home Assistant mappings')}
          detail={t(
            `${readiness.mappingReadyCount} av ${selectedCount} valda enheter har en bekräftad mappning.`,
            `${readiness.mappingReadyCount} of ${selectedCount} selected devices have a confirmed mapping.`,
          )}
          state={allMappingsReady ? 'ready' : 'blocked'}
          stateLabel={allMappingsReady ? readyLabel : blockedLabel}
        />
        <ThermalReadinessRow
          label={t('Elektrisk energihistorik', 'Electrical energy history')}
          detail={t(
            `${readiness.electricalHistoryReadyCount} av ${selectedCount} enheter har ${readiness.electricalHistorySampleCount.toLocaleString()} kompletta 15-minutersprover totalt. Detta driver serierna i effektgrafen men beskriver inte rumstemperaturen.`,
            `${readiness.electricalHistoryReadyCount} of ${selectedCount} devices have ${readiness.electricalHistorySampleCount.toLocaleString()} complete 15-minute samples in total. This drives the Power-series forecasts but does not describe room temperature.`,
          )}
          state={allHistoryReady ? 'ready' : 'waiting'}
          stateLabel={allHistoryReady ? readyLabel : waitingLabel}
        />
        <ThermalReadinessRow
          label={t('Elektrisk enhetsprognos i aktuell plan', 'Electrical device forecast in current plan')}
          detail={t(
            `${readiness.electricalForecastReadyCount} av ${selectedCount} värmeenheter finns i den aktuella effektplanen.`,
            `${readiness.electricalForecastReadyCount} of ${selectedCount} heaters are present in the current power plan.`,
          )}
          state={allForecastsReady ? 'ready' : 'waiting'}
          stateLabel={allForecastsReady ? readyLabel : waitingLabel}
        />
        <ThermalReadinessRow
          label={t('Termiska historikvärden', 'Thermal history observations')}
          detail={readiness.thermalState === 'blocked'
            ? t(
              'Rumstemperatur och aktuatorstatus har inte tagits emot från Home Assistant. Uppdatera integrationen och kontrollera att varje zon har en rumsgivare.',
              'No room temperature or actuator state has been received from Home Assistant. Update the integration and check that every zone has a room sensor.',
            )
            : t(
              `${readiness.thermalObservedCount} av ${selectedCount} zoner rapporterar, ${readiness.thermalSlotCount.toLocaleString()} kvartar lagrade.`,
              `${readiness.thermalObservedCount} of ${selectedCount} zones are reporting, ${readiness.thermalSlotCount.toLocaleString()} quarters stored.`,
            )}
          state={readiness.thermalState}
          stateLabel={stateLabels[readiness.thermalState]}
        />
        <ThermalReadinessRow
          label={t('Utomhustemperatur och prognos', 'Outdoor temperature and forecast')}
          detail={readiness.outdoorState === 'blocked'
            ? t(
              'Ingen utomhusgivare är vald i integrationen. Välj en under Prognoser.',
              'No outdoor sensor is selected in the integration. Choose one under Forecasts.',
            )
            : t(
              `${readiness.outdoorSlotCount.toLocaleString()} kvartar med uppmätt utomhustemperatur.`,
              `${readiness.outdoorSlotCount.toLocaleString()} quarters carry a measured outdoor temperature.`,
            )}
          state={readiness.outdoorState}
          stateLabel={stateLabels[readiness.outdoorState]}
        />
        <ThermalReadinessRow
          label={t('Inlärd termisk zonmodell', 'Learned thermal zone model')}
          detail={readiness.trainedZoneCount > 0
            ? t(
              `${readiness.trainedZoneCount} av ${selectedCount} zoner har en anpassad värmemodell.`,
              `${readiness.trainedZoneCount} of ${selectedCount} zones have a fitted thermal model.`,
            )
            : t(
              `Träning startar när en zon har ${THERMAL_TRAINING_SLOTS.toLocaleString()} kvartar med både rums- och utomhustemperatur.`,
              `Training starts once a zone has ${THERMAL_TRAINING_SLOTS.toLocaleString()} quarters of both room and outdoor temperature.`,
            )}
          state={readiness.modelState}
          stateLabel={stateLabels[readiness.modelState]}
        />
      </div>

      {readiness.mappingBlockers.length > 0 && (
        <div className="rounded-lg border p-4 text-sm">
          <p className="font-medium">
            {t('Enheter som fortfarande behöver mappas', 'Devices that still need mapping')}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {readiness.mappingBlockers.map(device => (
              <li key={device.device_key}>
                {device.name}{device.mapping_error ? ` — ${device.mapping_error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
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
