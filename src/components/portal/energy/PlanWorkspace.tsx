import { haRuntimeStatus } from '@/lib/energy-shift/ha-runtime';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  effectivePlanningRole,
  isOptimisationPlan,
  type ActualEnergySlot,
  type ThermalFixtureSeason,
} from '@/lib/energy-shift/contracts';
import { createWebsiteDemoActuals, createWebsiteDemoPlan } from '@/lib/energy-shift/demo';
import {
  type ThermalObservationSummary,
  type ThermalZoneModelSummary,
} from '@/lib/energy-shift/thermal-readiness';
import {
  EMPTY_THERMAL_OBSERVATIONS,
  type CurrentRow,
  type EmpiricalDeviceSlotMatrix,
  type HomeAssistantConnection,
  type PriceSlotRow,
  type ZoneModelRow,
  type ThermalSlotRow,
  summariseThermalSlots,
} from './plan/types';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import {
  formatHomeDayMonth,
  formatHomeStamp,
  formatHomeTime,
  formatHomeTimeWithSeconds,
} from '@/lib/energy-shift/home-time';
import {
  availableDayWindows,
  buildEnergyTimeline,
  dayWindowRange,
  summariseTimeline,
  unpricedMeasuredQuarters,
  type DayWindow,
} from '@/lib/energy-shift/energy-timeline';
export type { PlanSection } from './plan/types';
import type { PlanSection } from './plan/types';
import {
  EmptyState,
  Kpi,
} from './plan/ui';
import { usePlanModel } from './plan/usePlanModel';
import PowerSection from './plan/sections/PowerSection';
import ThermalSection from './plan/sections/ThermalSection';
import ValueCurvesTab from './ValueCurvesTab';

import EmpiricalDeviceModelsCard, {
  type EmpiricalEnergyDevice,
} from './EmpiricalDeviceModelsCard';

interface PlanWorkspaceProps {
  section: PlanSection;
  customerId?: string;
  homeId: string | null;
  accountPath: string;
}

// wording that says whether anything needs doing.

/** The portal draws three days of history; there is nothing older to price. */
const LOADED_HISTORY_DAYS = 3;

const PlanWorkspace: React.FC<PlanWorkspaceProps> = ({ section, customerId, homeId, accountPath }) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const [current, setCurrent] = useState<CurrentRow | null>(null);
  const [actuals, setActuals] = useState<ActualEnergySlot[]>([]);
  const [prices, setPrices] = useState<PriceSlotRow[]>([]);
  const [empiricalDevices, setEmpiricalDevices] = useState<EmpiricalEnergyDevice[]>([]);
  const [deviceActuals, setDeviceActuals] = useState<EmpiricalDeviceSlotMatrix[]>([]);
  const [thermalObservations, setThermalObservations] = useState<ThermalObservationSummary>(
    EMPTY_THERMAL_OBSERVATIONS,
  );
  const [zoneModels, setZoneModels] = useState<ThermalZoneModelSummary[]>([]);
  const [connections, setConnections] = useState<HomeAssistantConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'live' | 'demo'>('live');
  // The chart always loads the full window and slices locally, so this is
  // presentation state and never triggers a refetch.
  const [dayWindow, setDayWindow] = useState<DayWindow>(0);
  const [demoSeason, setDemoSeason] = useState<ThermalFixtureSeason>('winter');
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  const load = useCallback(async (background = false) => {
    if (!customerId || !homeId) {
      setCurrent(null);
      setActuals([]);
      setPrices([]);
      setEmpiricalDevices([]);
      setDeviceActuals([]);
      setThermalObservations(EMPTY_THERMAL_OBSERVATIONS);
      setZoneModels([]);
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
        priceResult,
        connectionResult,
        deviceResult,
        deviceActualResult,
        thermalResult,
        zoneModelResult,
      ] = await Promise.all([
        supabase
          .from('energy_optimisation_current')
          .select('home_id, plan, captured_at, updated_at, plan_id, generation_request_id, plan_schema_version, ha_runtime, ha_runtime_received_at, ha_ack_status, ha_acknowledged_at, ha_integration_version, ha_ack_request_id, ha_ack_error, replan_request_id, replan_requested_at, replan_completed_request_id, replan_error')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .maybeSingle(),
        supabase
          .from('energy_optimisation_actual_slots')
          .select('start_ts, total_load_kwh, solar_production_kwh, grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, battery_soc, ev_soc')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .gte('start_ts', from)
          .lt('start_ts', to)
          .order('start_ts'),
        // The only historical price the portal has: Home Assistant sends the
        // all-in figure the planner used, because reproducing the grid transfer
        // and energy tax here would be a second pricing implementation free to
        // drift (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.1).
        supabase
          .from('energy_optimisation_price_slots')
          .select('start_ts, import_price_sek_per_kwh, export_price_sek_per_kwh')
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
          .select('id, device_key, statistic_id, name, category, load_type_override, planning_role_override, planning_choice_at, control_type_override, mapping_status, mapped_control_type, mapping_error, mapping_summary, mapping_reported_at, active_power_w, profile_sample_count, last_seen_at')
          .eq('customer_id', customerId)
          .eq('home_id', homeId)
          .is('retired_at', null)
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
        supabase
          .from('energy_optimisation_zone_models')
          .select('room_key, trained, rejection_reason, sample_count')
          .eq('customer_id', customerId)
          .eq('home_id', homeId),
      ]);
      const { data, error: planError } = planResult;
      if (planError) throw planError;
      const { data: actualRows, error: actualError } = actualResult;
      if (actualError) throw actualError;
      // A price gap must not blank the measured chart: the history tab still
      // reports energy and marks the unpriced quarters.
      const { data: priceRows, error: priceError } = priceResult;
      if (priceError) console.warn('[ENERGY] price slots unavailable', priceError);
      const { data: connectionRows, error: connectionError } = connectionResult;
      if (connectionError) throw connectionError;
      const { data: deviceRows, error: deviceError } = deviceResult;
      if (deviceError) throw deviceError;
      const { data: deviceActualRows, error: deviceActualError } = deviceActualResult;
      if (deviceActualError) throw deviceActualError;
      setActuals(actualRows ?? []);
      setPrices(priceError ? [] : ((priceRows ?? []) as PriceSlotRow[]));
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
      setZoneModels(
        zoneModelResult.error
          ? []
          : ((zoneModelResult.data ?? []) as ZoneModelRow[]).map(row => ({
            room_key: row.room_key,
            trained: row.trained,
            rejection_reason: row.rejection_reason,
            sample_count: row.sample_count,
          })),
      );
      setConnections((connectionRows ?? []) as HomeAssistantConnection[]);
      if (!data) {
        setCurrent(null);
        return;
      }
      if (!isOptimisationPlan(data.plan)) {
        throw new Error(t('Planformatet stöds inte.', 'The stored plan format is not supported.'));
      }
      setCurrent({
        ...data,
        plan: data.plan,
        ha_runtime: data.ha_runtime as unknown as CurrentRow['ha_runtime'],
        ha_ack_status: data.ha_ack_status as CurrentRow['ha_ack_status'],
        ha_ack_error: data.ha_ack_error as CurrentRow['ha_ack_error'],
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLastCheckedAt(Date.now());
      if (!background) setLoading(false);
    }
  }, [customerId, homeId, t]);

  // Pricing gaps close themselves. Prices only accumulate forward from the day
  // the integration was installed, so a fresh home shows measured kWh with no
  // cost against exactly the history a planner is judged on. Filling that in is
  // never the reader's decision — the fix is always the same, and the missing
  // spot day is the same one for every home in that price area. Attempted once
  // per home per mount so a day the market never published cannot become a
  // request on every poll.
  const backfilledHomes = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!homeId || loading || actuals.length === 0) return;
    if (backfilledHomes.current.has(homeId)) return;
    if (unpricedMeasuredQuarters(actuals, prices) === 0) return;
    backfilledHomes.current.add(homeId);
    void (async () => {
      const { error: backfillError } = await supabase.functions.invoke(
        'backfill-energy-prices',
        { body: { home_id: homeId, days: LOADED_HISTORY_DAYS } },
      );
      // A failure is left silent on purpose: the cost figures already say
      // "priced quarters only", and nothing the reader can do would help.
      if (!backfillError) await load(true);
    })();
  }, [actuals, homeId, load, loading, prices]);

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
    return {
      plan,
      home_id: null,
      captured_at: plan.issued_at,
      updated_at: plan.issued_at,
      plan_id: plan.plan_id,
      generation_request_id: null,
      plan_schema_version: plan.schema_version,
      ha_runtime: null,
      ha_runtime_received_at: null,
      ha_ack_status: 'accepted',
      ha_acknowledged_at: plan.issued_at,
      ha_integration_version: null,
      ha_ack_request_id: null,
      ha_ack_error: null,
      replan_request_id: null,
      replan_requested_at: null,
      replan_completed_request_id: null,
      replan_error: null,
    };
  }, [demoReferenceTime, demoSeason]);
  const demoActuals = useMemo(
    () => createWebsiteDemoActuals(demoReferenceTime),
    [demoReferenceTime],
  );
  const activeConnection = connections.find(connection => connection.home_id === homeId);

  let content: React.ReactNode;
  if (section === 'devices') {
    if (!homeId) {
      content = <EmptyState text={t('Välj ett hem för att visa enhetsmodeller.', 'Select a home to view its device models.')} />;
    } else if (loading && empiricalDevices.length === 0) {
      content = <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar enhetsmodeller…', 'Loading device models…')}</div>;
    } else if (error && empiricalDevices.length === 0) {
      content = (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('Kunde inte läsa enhetsmodellerna', 'Could not load device models')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      );
    } else {
      content = (
        <EmpiricalDeviceModelsCard
          devices={empiricalDevices}
          homeId={homeId}
          onChanged={() => load(true)}
        />
      );
    }
  } else if (view === 'demo') {
    content = (
      <PlanView
        section={section}
        customerId={null}
        homeId={null}
        current={demoCurrent}
        actuals={demoActuals}
        empiricalDevices={[]}
        thermalObservations={EMPTY_THERMAL_OBSERVATIONS}
        zoneModels={[]}
        stale={false}
        isDemo
        deviceActuals={[]}
        prices={[]}
        now={clock}
        dayWindow={dayWindow}
        onDayWindowChange={setDayWindow}
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
                    `Anslutningen ${activeConnection.device_name} sågs senast ${activeConnection.last_seen_at ? formatHomeStamp(activeConnection.last_seen_at, homeTimeZone) : 'aldrig'}. Portalen kontrollerar efter en plan var 30:e sekund.`,
                    `The ${activeConnection.device_name} connection was last seen ${activeConnection.last_seen_at ? formatHomeStamp(activeConnection.last_seen_at, homeTimeZone) : 'never'}. The portal checks for a plan every 30 seconds.`,
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
              {lastCheckedAt && <p className="mt-2 text-xs text-muted-foreground">{t('Senast kontrollerad', 'Last checked')} {formatHomeTimeWithSeconds(lastCheckedAt, homeTimeZone)}</p>}
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
          section={section}
          customerId={customerId}
          homeId={homeId}
          current={current}
          actuals={actuals}
          empiricalDevices={empiricalDevices}
          thermalObservations={thermalObservations}
          zoneModels={zoneModels}
          stale={clock > Date.parse(current.plan.valid_until)}
          isDemo={false}
          lastCheckedAt={lastCheckedAt}
          connectionLastSeenAt={activeConnection?.last_seen_at ?? null}
          deviceActuals={deviceActuals}
          prices={prices}
          now={clock}
          dayWindow={dayWindow}
          onDayWindowChange={setDayWindow}
          onReplanChanged={() => void load(true)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {section !== 'devices' && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant={view === 'live' ? 'default' : 'outline'} onClick={() => setView('live')}>
            {t('Mitt hem', 'My home')}
          </Button>
          <Button size="sm" variant={view === 'demo' ? 'default' : 'outline'} onClick={() => setView('demo')}>
            <Sparkles className="mr-2 h-4 w-4" />
            {t('Exempel', 'Example')}
          </Button>
        </div>
      )}
      {section !== 'devices' && view === 'demo' && (
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
    </div>
  );
};

const PlanView: React.FC<{
  section: PlanSection;
  customerId: string | null;
  homeId: string | null;
  current: CurrentRow;
  actuals: ActualEnergySlot[];
  empiricalDevices: EmpiricalEnergyDevice[];
  thermalObservations: ThermalObservationSummary;
  zoneModels: ThermalZoneModelSummary[];
  stale: boolean;
  isDemo: boolean;
  lastCheckedAt?: number | null;
  /**
   * When Home Assistant last authenticated with us. Stamped before any
   * planning work, so it still moves when a push is rejected — which is what
   * separates "your home stopped talking to us" from "we could not build a
   * plan for it".
   */
  connectionLastSeenAt?: string | null;
  deviceActuals: EmpiricalDeviceSlotMatrix[];
  prices: PriceSlotRow[];
  now: number;
  dayWindow: DayWindow;
  onDayWindowChange: (value: DayWindow) => void;
  /** Re-read the row, so a queued replan shows without waiting for a poll. */
  onReplanChanged?: () => void;
}> = ({
  section,
  customerId,
  homeId,
  current,
  actuals,
  empiricalDevices,
  thermalObservations,
  zoneModels,
  stale,
  isDemo,
  lastCheckedAt,
  connectionLastSeenAt,
  dayWindow,
  onDayWindowChange,
  deviceActuals,
  prices,
  now,
  onReplanChanged,
}) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const model = usePlanModel(current, empiricalDevices, stale);
  const {
    plan, planView, setPlanView, executed, active, comparison, hasBattery, hasEvBattery,
    sourceStale, bindingExpired, ready, pct, costDelta, costTone, costMeaning,
    validationMessages,
  } = model;
  const runtimeStatus = haRuntimeStatus(current, now);
  const runtimeReady = ready && (isDemo || runtimeStatus.ready);
  const runtimeLabel = runtimeStatus.state === 'unconfirmed' ? t('HA-status obekräftad', 'HA status unconfirmed')
    : runtimeStatus.state === 'different_plan' ? t('Annan plan i HA', 'Different plan in HA')
    : runtimeStatus.state === 'ready' ? t('Tillgänglig i HA', 'Available in HA')
    : runtimeStatus.state === 'disabled' ? t('Avstängd i HA', 'Disabled in HA')
    : runtimeStatus.state === 'expired' ? t('Utgången', 'Expired')
    : runtimeStatus.state === 'advisory_only' ? t('Endast rådgivande', 'Advisory only')
    : runtimeStatus.state === 'not_configured' ? t('Konfiguration krävs i HA', 'HA configuration required')
    : runtimeStatus.state === 'invalid' ? t('Ogiltig plan i HA', 'Invalid plan in HA')
    : t('Plan otillgänglig i HA', 'Plan unavailable in HA');
  const runtimeDetail = runtimeStatus.state === 'unconfirmed'
    ? t('Ingen aktuell status har mottagits från Home Assistant. Tidigare acceptans bekräftar inte att planen fortfarande är tillgänglig.', 'No recent status received from Home Assistant. Earlier acceptance does not confirm that the plan is still available.')
    : runtimeStatus.state === 'different_plan'
      ? t('Home Assistant rapporterar en annan plan än den som visas här.', 'Home Assistant reports a different plan from the one shown here.')
      : runtimeStatus.state === 'expired'
        ? t('Den senaste planen har gått ut.', 'The last plan has expired.')
        : runtimeStatus.state === 'advisory_only'
          ? t('Inga bindande instruktioner återstår i planen.', 'No binding instructions remain in this plan.')
          : runtimeStatus.runtime?.reason ?? runtimeLabel;

  // When Home Assistant will next ask for a plan. It refreshes 30 minutes
  // before expiry, and only ever on a quarter boundary, so the honest answer is
  // the first quarter at or after that threshold rather than the threshold
  // itself. Shown because "is this plan stale or is the planner ignoring me?"
  // was previously unanswerable from the page.
  // The price the planner is comparing against right now, and where each store
  // actually sits, so the curve chart marks real positions rather than a
  // textbook example.
  const livePrices = useMemo(() => {
    const slot = plan?.plans?.priority?.slots?.find(
      entry => Date.parse(entry.start) <= now &&
        now < Date.parse(entry.start) + 15 * 60_000,
    ) ?? plan?.plans?.priority?.slots?.[0];
    return {
      import: typeof slot?.import_price_sek_per_kwh === 'number'
        ? slot.import_price_sek_per_kwh
        : null,
      export: typeof slot?.export_price_sek_per_kwh === 'number'
        ? slot.export_price_sek_per_kwh
        : null,
    };
  }, [plan, now]);

  const vehicleRangeKm = useMemo(() => {
    const vehicle = plan?.ev_battery;
    if (!vehicle?.capacity_kwh || typeof vehicle.soc !== 'number') return null;
    // The same seeded 0.16 kWh/km the planner uses, so the marker and the
    // decision agree.
    return (vehicle.soc * vehicle.capacity_kwh) / 0.16;
  }, [plan]);

  /** The range the customer's own charge limit asks for, which anchors the curve. */
  const vehicleTargetRangeKm = useMemo(() => {
    const vehicle = plan?.ev_battery;
    if (!vehicle?.capacity_kwh || typeof vehicle.departure_target_soc !== 'number') {
      return null;
    }
    return (vehicle.departure_target_soc * vehicle.capacity_kwh) / 0.16;
  }, [plan]);

  /**
   * Range at a full battery, so a threshold in kilometres can be read as SOC.
   *
   * The hardware limit is a state of charge and the curve is stated in
   * kilometres; without this the household cannot tell whether a threshold they
   * typed is even reachable under their own charge limit.
   */
  const vehicleFullRangeKm = useMemo(() => {
    const vehicle = plan?.ev_battery;
    if (!vehicle?.capacity_kwh) return null;
    return vehicle.capacity_kwh / 0.16;
  }, [plan]);

  const vehicleChargeLimitSoc = useMemo(() => {
    const target = plan?.ev_battery?.departure_target_soc;
    return typeof target === 'number' ? target : null;
  }, [plan]);

  const nextReplanAt = useMemo(() => {
    if (!plan?.valid_until) return null;
    const validUntil = Date.parse(plan.valid_until);
    if (!Number.isFinite(validUntil)) return null;
    const threshold = validUntil - 30 * 60_000;
    const quarter = 15 * 60_000;
    return new Date(Math.ceil(threshold / quarter) * quarter);
  }, [plan?.valid_until]);
  // One timeline: measured quarters up to now, planned quarters after it.
  // Every headline number describes the day on screen, so a total can be
  // checked against the chart under it.
  const nowMs = now;
  const deviceNameByKey = useMemo(
    () => new Map(empiricalDevices.map(device => [device.device_key, device.name])),
    [empiricalDevices],
  );
  const deviceKeyById = useMemo(
    () => new Map(empiricalDevices.map(device => [device.id, device.device_key])),
    [empiricalDevices],
  );
  // Which meters the plan is allowed to move. Only these earn a band of their
  // own in the consumption panel; the rest are background whatever they draw.
  const schedulableKeys = useMemo(
    () => new Set(
      empiricalDevices
        .filter(device => effectivePlanningRole(device) === 'controllable')
        .map(device => device.device_key),
    ),
    [empiricalDevices],
  );
  const timeline = useMemo(() => buildEnergyTimeline({
    actuals,
    deviceActuals,
    prices,
    planSlots: active.slots,
    deviceKeyById,
    nowMs,
  }), [actuals, active.slots, deviceActuals, deviceKeyById, nowMs, prices]);
  const dayWindowOptions = availableDayWindows(timeline, nowMs, homeTimeZone);
  const timelineRange = dayWindowRange(timeline, dayWindow, nowMs, homeTimeZone);
  const windowSummary = summariseTimeline(timeline, timelineRange);
  const windowLabel = dayWindow === 'all'
    ? t('hela perioden', 'the whole period')
    : dayWindow === 0
      ? t('idag', 'today')
      : formatHomeDayMonth(
        timeline[timelineRange.from]?.start ?? nowMs,
        homeTimeZone,
      );
  // "Today" is part measured and part forecast. Saying which is which is the
  // difference between a number and a claim.
  const provenance = windowSummary.measuredSlotCount > 0 && windowSummary.plannedSlotCount > 0
    ? t(
      `${windowSummary.measuredSlotCount} uppmätta · ${windowSummary.plannedSlotCount} planerade kvartar`,
      `${windowSummary.measuredSlotCount} measured · ${windowSummary.plannedSlotCount} planned quarters`,
    )
    : windowSummary.plannedSlotCount > 0
      ? t('planerat', 'planned')
      : t('uppmätt', 'measured');

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
      {(!runtimeReady || validationMessages.length > 0) && (() => {
        // Explain expiry separately from the reason a replacement failed.
        const lastSeenMs = connectionLastSeenAt
          ? Date.parse(connectionLastSeenAt)
          : Number.NaN;
        const minutesSinceSeen = Number.isFinite(lastSeenMs)
          ? Math.max(0, Math.round((now - lastSeenMs) / 60_000))
          : null;
        // Pushes arrive every quarter hour, so twenty minutes of silence is
        // the first missed one rather than a blip.
        const connectionLive = minutesSinceSeen !== null && minutesSinceSeen <= 20;
        const clockTime = (value: string | number) =>
          formatHomeTime(value, homeTimeZone);
        const ago = minutesSinceSeen === null
          ? null
          : minutesSinceSeen < 1
            ? t('för mindre än en minut sedan', 'less than a minute ago')
            : minutesSinceSeen === 1
              ? t('för en minut sedan', 'a minute ago')
            : minutesSinceSeen < 60
              ? t(`för ${minutesSinceSeen} minuter sedan`, `${minutesSinceSeen} minutes ago`)
              : t(`kl. ${clockTime(lastSeenMs)}`, `at ${clockTime(lastSeenMs)}`);

        // Source keys are internal. Only these names ever reach a household.
        const SOURCE_NAMES: Record<string, [string, string]> = {
          pv: ['solprognosen', 'the solar forecast'],
          battery: ['batteriets mätvärden', 'the battery readings'],
          base_load: ['hemmets normalförbrukning', "your home's usual consumption"],
          import_price: ['elpriserna', 'electricity prices'],
          export_price: ['elpriserna', 'electricity prices'],
          outdoor_temperature: ['väderprognosen', 'the weather forecast'],
        };
        const staleNames = [...new Set(sourceStale.map(source =>
          SOURCE_NAMES[source] ? t(...SOURCE_NAMES[source]) : t('en av prognoserna', 'one of the forecasts')))];

        const runningNormally = t(
          'Den här planen kan inte längre användas för att styra hemmet efter elpriset. Home Assistant visar vilka inställningar varje enhet använder under tiden.',
          'This plan can no longer be used to control your home according to electricity prices. Home Assistant shows which settings each device is using meanwhile.',
        );
        const notYours = t(
          'Det här är något vi behöver rätta till, inte något du behöver göra.',
          'This is something for us to put right, not something you need to do.',
        );

        const title = !isDemo && !runtimeStatus.ready
          ? runtimeLabel
          : stale
              ? connectionLive
                ? t('Planen är inaktuell', 'Your plan is out of date')
                : t('Hemmet har slutat skicka data', 'Your home has stopped sending data')
              : bindingExpired
                ? t('Planen sträcker sig längre än elpriserna', 'The plan reaches further than the prices do')
                : sourceStale.length > 0
                  ? t('En del av prognosen är inaktuell', 'Part of the forecast is out of date')
                  : t('Planen går inte att genomföra', 'This plan cannot be carried out');

        const body = !isDemo && !runtimeStatus.ready
          ? [runtimeDetail]
          : stale
              ? connectionLive
                ? [
                  t(
                    `Den senaste planen skapades kl. ${clockTime(plan.issued_at)} och slutade gälla kl. ${clockTime(current.plan.valid_until)}. Ingen ny plan har ersatt den.`,
                    `The latest plan was created at ${clockTime(plan.issued_at)} and expired at ${clockTime(current.plan.valid_until)}. No replacement has arrived.`,
                  ),
                  runningNormally,
                  ago ? t(
                    `Home Assistant hörde av sig ${ago}, så uppkopplingen fungerar.`,
                    `Home Assistant checked in ${ago}, so the connection is working.`,
                  ) : '',
                  notYours,
                ]
                : [
                  ago ? t(
                    `Home Assistant hörde senast av sig ${ago}.`,
                    `Home Assistant last checked in ${ago}.`,
                  ) : t(
                    'Home Assistant har aldrig hört av sig.',
                    'Home Assistant has never checked in.',
                  ),
                  runningNormally,
                  t(
                    'Kontrollera att Home Assistant är igång och att Smart Home Solutions-integrationen är aktiverad.',
                    'Check that Home Assistant is running and that the Smart Home Solutions integration is enabled.',
                  ),
                ]
              : bindingExpired
                ? [t(
                  'Elpriserna publiceras bara ungefär ett dygn i förväg. Längre fram är planen en gissning, så Home Assistant följer dina vanliga inställningar tills morgondagens priser kommer.',
                  'Electricity prices are only published about a day ahead. Beyond that the plan is a best guess, so Home Assistant follows your usual settings until tomorrow\'s prices arrive.',
                ), t('Inget behöver göras.', 'Nothing needs doing.')]
                : sourceStale.length > 0
                  ? [t(
                    `Planen bygger delvis på ${staleNames.join(', ')}, som nu är inaktuell.`,
                    `This plan was partly built on ${staleNames.join(', ')}, which is now out of date.`,
                  ), t(
                    'En ny plan ersätter den normalt inom en timme.',
                    'A fresh plan normally replaces it within the hour.',
                  )]
                  : [t(
                    'Home Assistant använder sina vanliga inställningar tills en giltig plan finns.',
                    'Home Assistant uses its usual settings until a valid plan is available.',
                  )];

        const details = [
          ...(stale ? [t(
            `Planen behövde ersättas senast ${formatHomeStamp(current.plan.valid_until, homeTimeZone)}.`,
            `The plan needed replacing by ${formatHomeStamp(current.plan.valid_until, homeTimeZone)}.`,
          )] : []),
          ...(bindingExpired ? [t(
            `Tillgängliga elpriser täcker bara tiden fram till ${formatHomeStamp(plan.binding_until, homeTimeZone)}.`,
            `Available electricity prices only cover the period up to ${formatHomeStamp(plan.binding_until, homeTimeZone)}.`,
          )] : []),
          ...(sourceStale.length > 0 ? [t(
            `Underlaget för ${staleNames.join(', ')} behöver uppdateras innan en ny plan kan användas.`,
            `The information for ${staleNames.join(', ')} needs updating before a new plan can be used.`,
          )] : []),
          ...(stale ? [t(
            'Detta visar när planen slutade gälla, inte varför nästa plan saknas. Det senaste planeringsfelet finns i Home Assistants diagnostik.',
            'This explains when the plan expired, not why the next plan is missing. Home Assistant diagnostics contain the latest planning error.',
          )] : []),
          ...(validationMessages.length > 0 ? [t(
            'Planen klarade inte alla kontroller och behöver räknas om med aktuella uppgifter.',
            'The plan did not pass all checks and needs to be recalculated with current information.',
          )] : []),
        ];

        return (
          <Alert variant={stale || bindingExpired || sourceStale.length > 0 ? 'destructive' : 'default'}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
              <p>{body.filter(Boolean).join(' ')}</p>
              {details.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs opacity-70">
                    {t('Vad det betyder', 'What this means')}
                  </summary>
                  <p className="mt-1 text-xs opacity-70">{details.slice(0, 8).join(' · ')}</p>
                </details>
              )}
            </AlertDescription>
          </Alert>
        );
      })()}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">{isDemo ? t('Demoplan med 15-minutersupplösning', '15-minute demo energy plan') : t('Liveplan för 15-minutersstyrning', 'Live 15-minute energy plan')}</CardTitle>
                <Badge variant={runtimeReady ? 'secondary' : 'destructive'}>
                  {isDemo ? t('Demo', 'Demo') : stale ? t('Utgången', 'Expired')
                    : bindingExpired ? t('Endast rådgivande', 'Advisory only')
                    : runtimeLabel}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Utfärdad', 'Issued')} {formatHomeStamp(plan.issued_at, homeTimeZone)} · {plan.model_version} · {actuals.length} {t('faktiska kvartar', 'actual quarters')}
              </p>
              {!isDemo && lastCheckedAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Portalen kontrollerade senast', 'Portal last checked')} {formatHomeTimeWithSeconds(lastCheckedAt, homeTimeZone)} · {runtimeDetail}
                </p>
              )}
              {!isDemo && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Senaste status från HA', 'Last status from HA')}: {current.ha_runtime_received_at ? formatHomeStamp(current.ha_runtime_received_at, homeTimeZone) : t('Inte mottagen', 'Not received')}.
                  {runtimeStatus.runtime?.recovering ? t(' Begär automatiskt en ny plan.', ' Automatically requesting a fresh plan.')
                    : runtimeStatus.runtime?.retry_at && !runtimeStatus.ready ? ` ${t('Automatiskt nytt försök', 'Automatic retry')}: ${formatHomeTimeWithSeconds(runtimeStatus.runtime.retry_at, homeTimeZone)}.` : ''}
                  {runtimeStatus.runtime?.last_error ? ` ${runtimeStatus.runtime.last_error}` : ''}
                  {current.ha_ack_status === 'accepted' ? ` ${t('Tidigare accepterad', 'Previously accepted')}: ${current.ha_acknowledged_at ? formatHomeStamp(current.ha_acknowledged_at, homeTimeZone) : '—'}.` : ''}
                </p>
              )}
              {!isDemo && current.generation_request_id && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Begäran', 'Request')} {current.generation_request_id} {current.ha_integration_version ? `· ${t('Accepterad/avvisad av HA', 'Acknowledged by HA')} ${current.ha_integration_version}` : ''}
                </p>
              )}
              {!isDemo && nextReplanAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Nästa omplanering', 'Next replan')} {formatHomeTimeWithSeconds(nextReplanAt, homeTimeZone)} · {t('planen gäller till', 'plan valid until')} {formatHomeTimeWithSeconds(plan.valid_until, homeTimeZone)}
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
          {section === 'plan' && (
          <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi
              label={t('Solproduktion', 'Solar production')}
              value={`${windowSummary.solarKwh.toFixed(1)} kWh`}
              detail={provenance}
            />
            <Kpi
              label={t('Husets förbrukning', 'House consumption')}
              value={`${windowSummary.consumptionKwh.toFixed(1)} kWh`}
              detail={t('all last i perioden', 'all load in the period')}
            />
            <Kpi
              label={t('Nätimport', 'Grid import')}
              value={`${windowSummary.gridImportKwh.toFixed(1)} kWh`}
              detail={windowLabel}
            />
            <Kpi
              label={t('Nätexport', 'Grid export')}
              value={`${windowSummary.gridExportKwh.toFixed(1)} kWh`}
              detail={windowLabel}
            />
            <Kpi
              label={t('Nettokostnad', 'Net cost')}
              value={`${windowSummary.netCostSek.toFixed(2)} SEK`}
              detail={windowSummary.fullyPriced
                ? t('import minus exportersättning', 'import minus export credit')
                : t('endast prissatta kvartar', 'priced quarters only')}
              tone={windowSummary.netCostSek > 0 ? undefined : 'good'}
            />
          </div>
          <PowerSection
            model={model}
            rows={timeline}
            range={timelineRange}
            dayWindow={dayWindow}
            dayWindowOptions={dayWindowOptions}
            onDayWindowChange={onDayWindowChange}
            deviceNameByKey={deviceNameByKey}
            schedulableKeys={schedulableKeys}
            hasBattery={hasBattery}
            hasEvBattery={hasEvBattery}
          />
          </>
          )}

          {section === 'thermal' && (
            <ThermalSection
              model={model}
              empiricalDevices={empiricalDevices}
              thermalObservations={thermalObservations}
              zoneModels={zoneModels}
            />
          )}
          {section === 'economics' && (
            <ValueCurvesTab
              customerId={customerId}
              homeId={homeId}
              planSnapshotId={plan.snapshot_id}
              importPriceSekPerKwh={livePrices.import}
              exportPriceSekPerKwh={livePrices.export}
              vehicleTargetRangeKm={vehicleTargetRangeKm}
              vehicleFullRangeKm={vehicleFullRangeKm}
              vehicleChargeLimitSoc={vehicleChargeLimitSoc}
              batteryValueCurve={plan.battery_value_curve}
              replan={current}
              onReplanChanged={onReplanChanged}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
};



export default PlanWorkspace;
