import ReplanControls from './ReplanControls';
import MeasurementIssuesAlert from './MeasurementIssuesAlert';
import { planMeasurementIssues } from '@/lib/energy-shift/measurement-issues';
import { REPLAN_OVERDUE_MS, replanState } from '@/lib/energy-shift/replan-request';
import { downloadTrafficReport, recordPortalSync } from '@/lib/network-traffic';
import { HistoryCache, type HistoryDelta, type ChangedValue } from '@/lib/energy-shift/portal-sync';
import { planRefreshError, readPlanRefresh } from '@/lib/energy-shift/plan-refresh';
import { haRuntimeStatus, type HaRuntimeRow } from '@/lib/energy-shift/ha-runtime';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  effectivePlanningRole,
  type ActualEnergySlot,
} from '@/lib/energy-shift/contracts';
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
  const [latestRuntime, setLatestRuntime] = useState<HaRuntimeRow | null>(null);
  const [actuals, setActuals] = useState<ActualEnergySlot[]>([]);
  const [prices, setPrices] = useState<PriceSlotRow[]>([]);
  const [empiricalDevices, setEmpiricalDevices] = useState<EmpiricalEnergyDevice[]>([]);
  const [deviceActuals, setDeviceActuals] = useState<EmpiricalDeviceSlotMatrix[]>([]);
  const [thermalObservations, setThermalObservations] = useState<ThermalObservationSummary>(
    EMPTY_THERMAL_OBSERVATIONS,
  );
  const [zoneModels, setZoneModels] = useState<ThermalZoneModelSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestingReplan, setRequestingReplan] = useState(false);
  // The chart always loads the full window and slices locally, so this is
  // presentation state and never triggers a refetch.
  const [dayWindow, setDayWindow] = useState<DayWindow>(0);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  // Cache survives 30-second refreshes, but is never shared across customers or
  // homes. In-flight responses are discarded when the selected home changes.
  const syncScope = `${customerId ?? ''}:${homeId ?? ''}`;
  const syncRef = useRef<{
    scope: string;
    busy: boolean;
    initialized: boolean;
    failures: number;
    current: CurrentRow | null;
    known: Record<string, string | Record<string, string>>;
    actuals: HistoryCache<ActualEnergySlot>;
    prices: HistoryCache<PriceSlotRow>;
    deviceActuals: HistoryCache<EmpiricalDeviceSlotMatrix>;
  } | null>(null);
  if (syncRef.current?.scope !== syncScope) {
    syncRef.current = { scope: syncScope, busy: false, initialized: false, failures: 0, current: null, known: {},
      actuals: new HistoryCache(), prices: new HistoryCache(), deviceActuals: new HistoryCache() };
  }

  const load = useCallback(async (background = false) => {
    const cache = syncRef.current!;
    if (cache.scope !== `${customerId ?? ''}:${homeId ?? ''}` || cache.busy) return;
    if (!cache.initialized) {
      setCurrent(null);
      setLatestRuntime(null);
      setActuals([]);
      setPrices([]);
      setEmpiricalDevices([]);
      setDeviceActuals([]);
      setThermalObservations(EMPTY_THERMAL_OBSERVATIONS);
      setZoneModels([]);
      setError(null);
      setRetrying(false);
    }
    if (!customerId || !homeId) { setLoading(false); return; }
    cache.busy = true;
    if (!background) setLoading(true);
    try {
      const { data, error: syncError } = await supabase.rpc('get_energy_portal_delta', {
        p_customer_id: customerId, p_home_id: homeId,
        p_known: { ...cache.known, actuals: cache.actuals.hashes(),
          prices: cache.prices.hashes(), device_actuals: cache.deviceActuals.hashes() },
      });
      if (syncRef.current !== cache) return;
      if (syncError) throw syncError;
      const delta = data as unknown as {
        current: Omit<CurrentRow, 'plan'> | null;
        plan: CurrentRow['plan'] | null;
        actuals: HistoryDelta<ActualEnergySlot>;
        prices: HistoryDelta<PriceSlotRow>;
        device_actuals: HistoryDelta<EmpiricalDeviceSlotMatrix>;
        devices: ChangedValue<EmpiricalEnergyDevice[]>;
        zone_models: ChangedValue<ThermalZoneModelSummary[]>;
        thermal: ChangedValue<ThermalObservationSummary>;
      };
      recordPortalSync(delta, !cache.initialized);
      const row = delta.current ? { ...delta.current,
        plan: delta.plan ?? (cache.current?.plan_id === delta.current.plan_id ? cache.current?.plan : null),
      } : null;
      const refreshed = readPlanRefresh(row);
      setLatestRuntime(refreshed.runtime);
      if (refreshed.unsupported && delta.current?.plan_id) {
        throw new Error(t('Webbplatsen kan inte visa det mottagna planformatet.', 'The website cannot display the received plan format.'));
      }
      setCurrent(refreshed.current);
      // Cache only validated plans; an unsupported response is retried and
      // cannot make a later metadata-only response appear usable.
      cache.current = refreshed.current;
      cache.known.plan_id = refreshed.current?.plan_id ?? '';
      setActuals(cache.actuals.apply(delta.actuals));
      setPrices(cache.prices.apply(delta.prices));
      setDeviceActuals(cache.deviceActuals.apply(delta.device_actuals));
      if (delta.devices.value !== null) setEmpiricalDevices(delta.devices.value);
      if (delta.zone_models.value !== null) setZoneModels(delta.zone_models.value);
      if (delta.thermal.value !== null) setThermalObservations(delta.thermal.value);
      cache.known.devices = delta.devices.hash;
      cache.known.zone_models = delta.zone_models.hash;
      cache.known.thermal = delta.thermal.hash;
      cache.initialized = true;
      cache.failures = 0;
      setRetrying(false);
      setError(null);
    } catch (loadError) {
      if (syncRef.current === cache) {
        cache.failures += 1;
        // Keep the displayed plan through a failed background read and retry
        // promptly. Repeated failures remain visible with a readable message.
        const retry = cache.current !== null && cache.failures === 1;
        setRetrying(retry);
        setError(retry ? null : planRefreshError(loadError));
      }
    } finally {
      cache.busy = false;
      if (syncRef.current === cache) {
        setLastCheckedAt(Date.now());
        setLoading(false);
      }
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
  const pendingReplan = replanState(current).status === 'waiting';
  const runtimeRefreshing = Boolean(latestRuntime?.ha_runtime?.recovering)
    && clock - Date.parse(latestRuntime?.ha_runtime_received_at ?? '') < REPLAN_OVERDUE_MS;
  const refreshing = requestingReplan || pendingReplan || runtimeRefreshing || retrying || (loading && current !== null);
  useEffect(() => {
    // Poll small metadata and content deltas. Hidden tabs resume on visibility.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, refreshing ? 1_000 : 30_000);
    const resume = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [load, refreshing]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeConnection: HomeAssistantConnection | undefined = latestRuntime?.ha_runtime_received_at
    ? { device_name: 'Home Assistant', home_id: homeId!, last_seen_at: latestRuntime.ha_runtime_received_at }
    : undefined;

  const replanControls = <ReplanControls homeId={homeId} replan={current} refreshing={refreshing}
    onBusyChange={setRequestingReplan} onReplanChanged={() => void load(true)} />;

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
          refreshing={refreshing}
          homeId={homeId}
          onChanged={() => load(true)}
        />
      );
    }
  } else if (!homeId) {
    content = <EmptyState text={t('Välj ett hem för att visa energiplanen.', 'Select a home to view its energy plan.')} />;
  } else if (loading && !current) {
    content = <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Laddar energiplan…', 'Loading energy plan…')}</div>;
  } else if (error && !current) {
    content = (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('Kunde inte läsa energiplanen', 'Could not load the energy plan')}</AlertTitle>
        <AlertDescription>
          {error}
          {latestRuntime && haRuntimeStatus(latestRuntime, clock).ready && (
            <p className="mt-1">{t('Home Assistant rapporterar att en giltig plan är tillgänglig. Felet gäller webbplatsens visning.',
              'Home Assistant reports that a validated plan is available. This error affects the website display.')}</p>
          )}
        </AlertDescription>
      </Alert>
    );
  } else if (!current) {

    content = (
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 py-8">
            <div>
              <p className="font-medium">
                {activeConnection
                  ? t('Home Assistant är ansluten — väntar på den första godkända planen', 'Home Assistant has reported — waiting for the first accepted plan')
                  : t('Väntar på den första statusrapporten från Home Assistant', 'Waiting for the first status report from Home Assistant')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeConnection
                  ? t(
                    `Anslutningen ${activeConnection.device_name} sågs senast ${activeConnection.last_seen_at ? formatHomeStamp(activeConnection.last_seen_at, homeTimeZone) : 'aldrig'}. Portalen kontrollerar efter en plan var 30:e sekund.`,
                    `The ${activeConnection.device_name} connection was last seen ${activeConnection.last_seen_at ? formatHomeStamp(activeConnection.last_seen_at, homeTimeZone) : 'never'}. The portal checks for a plan every 30 seconds.`,
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
            </div>
          </CardContent>
        </Card>
      </div>
    );
  } else {
    content = (
      <div className="space-y-4">
        <PlanView
          section={section}
          customerId={customerId}
          homeId={homeId}
          current={current}
          refreshError={error}
          refreshing={refreshing || requestingReplan}
          latestRuntime={latestRuntime}
          actuals={actuals}
          empiricalDevices={empiricalDevices}
          thermalObservations={thermalObservations}
          zoneModels={zoneModels}
          stale={clock > Date.parse(current.plan.valid_until)}
          replanControls={section === 'plan' ? replanControls : undefined}
          lastCheckedAt={lastCheckedAt}
          connectionLastSeenAt={activeConnection?.last_seen_at ?? null}
          deviceActuals={deviceActuals}
          prices={prices}
          now={clock}
          dayWindow={dayWindow}
          onDayWindowChange={setDayWindow}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {refreshing && !pendingReplan && !requestingReplan && (
        <Alert role="status" aria-live="polite" data-testid="plan-refresh-progress">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          <AlertTitle>{t('Uppdatering pågår', 'Refresh in progress')}</AlertTitle>
          <AlertDescription>{t('Den tidigare planen visas under tiden. Du kan spara igen när uppdateringen är klar.', 'The previous plan remains visible. Saving is available when the refresh finishes.')}</AlertDescription>
        </Alert>
      )}
      {!pendingReplan && !requestingReplan && (current?.replan_recommendations?.length ?? 0) > 0 && <Alert data-testid="replan-recommendations">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('Omplanering rekommenderas', 'Manual replan recommended')}</AlertTitle>
        <AlertDescription>
          {t('Den nuvarande planen ligger kvar. Använd Planera om nu på planfliken för att ändra den.', 'The current schedule is retained. Use Replan now on the Plan tab to change it.')}
          <details className="mt-2"><summary className="cursor-pointer">{t('Orsaker och tidpunkter', 'Reasons and times')}</summary>
            <ul>{current?.replan_recommendations!.map(reason => <li key={reason.key}>{reason.reason} · {formatHomeStamp(reason.occurred_at, homeTimeZone)}</li>)}</ul>
          </details>
        </AlertDescription>
      </Alert>}
      {!pendingReplan && !requestingReplan && <MeasurementIssuesAlert issues={planMeasurementIssues(current?.plan)} />}
      {!current && section === 'plan' && replanControls}
      {content}
      {(
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('Trafikdiagnostik', 'Traffic diagnostics')}</summary>
          <p className="mt-1">{t('Trafik i denna flik sedan sidan laddades. Datastorlek före komprimering, inte fakturerad trafik.', 'Traffic in this tab since page load. Payload sizes before compression, not billed traffic.')}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={downloadTrafficReport}>
            {t('Ladda ned trafikrapport', 'Download traffic report')}
          </Button>
        </details>
      )}
    </div>
  );
};

const PlanView: React.FC<{
  section: PlanSection;
  customerId: string | null;
  homeId: string | null;
  current: CurrentRow;
  refreshError?: string | null;
  refreshing?: boolean;
  latestRuntime?: HaRuntimeRow | null;
  actuals: ActualEnergySlot[];
  empiricalDevices: EmpiricalEnergyDevice[];
  thermalObservations: ThermalObservationSummary;
  zoneModels: ThermalZoneModelSummary[];
  stale: boolean;
  replanControls?: React.ReactNode;
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
}> = ({
  section,
  customerId,
  homeId,
  current,
  refreshError = null,
  refreshing = false,
  latestRuntime,
  actuals,
  empiricalDevices,
  thermalObservations,
  zoneModels,
  stale,
  replanControls,
  lastCheckedAt,
  connectionLastSeenAt,
  dayWindow,
  onDayWindowChange,
  deviceActuals,
  prices,
  now,
}) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const model = usePlanModel(current, empiricalDevices, stale);
  const {
    plan, planView, setPlanView, executed, active, comparison, hasBattery, hasEvBattery,
    sourceStale, bindingExpired, ready, pct, costDelta, costTone, costMeaning,
    validationMessages,
  } = model;
  const runtimeStatus = haRuntimeStatus(latestRuntime ?? current, now);
  const runtimeReady = ready && runtimeStatus.ready;
  const runtimeLabel = runtimeStatus.state === 'unconfirmed' ? t('HA-status obekräftad', 'HA status unconfirmed')
    : runtimeStatus.state === 'different_plan' ? t('Annan plan i HA', 'Different plan in HA')
    : runtimeStatus.state === 'ready' ? t('Senast rapporterad redo i HA', 'Last reported ready in HA')
    : runtimeStatus.state === 'disabled' ? t('Avstängd i HA', 'Disabled in HA')
    : runtimeStatus.state === 'expired' ? t('Utgången', 'Expired')
    : runtimeStatus.state === 'advisory_only' ? t('Endast rådgivande', 'Advisory only')
    : runtimeStatus.state === 'not_configured' ? t('Konfiguration krävs i HA', 'HA configuration required')
    : runtimeStatus.state === 'invalid' ? t('Ogiltig plan i HA', 'Invalid plan in HA')
    : t('Plan otillgänglig i HA', 'Plan unavailable in HA');
  const runtimeDetail = runtimeStatus.state === 'unconfirmed'
    ? t('Ingen statusrapport har mottagits från Home Assistant.', 'No status report has been received from Home Assistant.')
    : runtimeStatus.state === 'different_plan'
      ? t('Home Assistant rapporterar en annan plan än den som visas här.', 'Home Assistant reports a different plan from the one shown here.')
      : runtimeStatus.state === 'expired'
        ? t('Den senaste planen har gått ut.', 'The last plan has expired.')
        : runtimeStatus.state === 'advisory_only'
          ? t('Inga bindande instruktioner återstår i planen.', 'No binding instructions remain in this plan.')
          : runtimeStatus.runtime?.reason ?? runtimeLabel;

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
  // Only Planned devices get a schedule band. A change to Monitored takes
  // effect in the chart while the replacement plan is being requested.
  const schedulableKeys = useMemo(
    () => new Set(model.deviceRoleView.visibleModels.map(device => device.key)),
    [model.deviceRoleView.visibleModels],
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
      {refreshError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('Webbplatsen kunde inte uppdateras', 'The website could not refresh')}</AlertTitle>
          <AlertDescription>{refreshError} {t('Visade uppgifter kan vara inaktuella.', 'Displayed information may be out of date.')}</AlertDescription>
        </Alert>
      ) : (!refreshing && (validationMessages.length > 0 || !runtimeReady)) && (() => {
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

        const title = !runtimeStatus.ready
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

        const body = !runtimeStatus.ready
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
                <CardTitle className="text-lg">{t('Liveplan för 15-minutersstyrning', 'Live 15-minute energy plan')}</CardTitle>
                {(!refreshError && runtimeReady && validationMessages.length === 0) && (
                  <Badge variant="secondary">{runtimeLabel}</Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Plan', 'Plan')} <code title={plan.plan_id}>{plan.plan_id.slice(0, 8)}</code>
                {' · '}{t('Utfärdad', 'Issued')} {formatHomeStamp(plan.issued_at, homeTimeZone)}
              </p>
              {(
                <p className="mt-1 text-sm text-muted-foreground" data-testid="ha-plan-identity">
                  {t('Senast rapporterad plan i HA', 'Last reported plan in HA')}: {runtimeStatus.runtime?.plan_id
                    ? <><code title={runtimeStatus.runtime.plan_id}>{runtimeStatus.runtime.plan_id.slice(0, 8)}</code>{' · '}{runtimeStatus.runtime.plan_id === plan.plan_id
                      ? t('Samma plan', 'Same plan') : t('Annan plan', 'Different plan')}
                    {' · '}{formatHomeStamp(runtimeStatus.runtime.observed_at, homeTimeZone)}</>
                    : t('Inte bekräftad', 'Unconfirmed')}
                </p>
              )}
              {(
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{t('Statusdetaljer', 'Status details')}</summary>
                  <p className="mt-1">{plan.model_version} · {actuals.length} {t('faktiska kvartar', 'actual quarters')}</p>
                  <p className="mt-1 break-all">{t('Visat plan-ID', 'Displayed plan ID')}: <code>{plan.plan_id}</code></p>
                  {runtimeStatus.runtime?.plan_id && (
                    <p className="mt-1 break-all">{t('Senast rapporterat plan-ID i HA', 'Last reported plan ID in HA')}: <code>{runtimeStatus.runtime.plan_id}</code></p>
                  )}
                  <p className="mt-1">{t('Jämför plan-ID med schemat i SHS-integrationen. Varje ersättningsplan får ett nytt ID.', 'Compare the plan ID with the schedule in the SHS integration. Each replacement plan gets a new ID.')}</p>
                  {lastCheckedAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('Portalen kontrollerade senast', 'Portal last checked')} {formatHomeTimeWithSeconds(lastCheckedAt, homeTimeZone)}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('Senaste status från HA', 'Last status from HA')}: {(latestRuntime ?? current).ha_runtime_received_at ? formatHomeStamp((latestRuntime ?? current).ha_runtime_received_at!, homeTimeZone) : t('Inte mottagen', 'Not received')}.
                    {runtimeStatus.runtime?.recovering ? t(' Begär automatiskt en ny plan.', ' Automatically requesting a fresh plan.')
                      : runtimeStatus.runtime?.retry_at && !runtimeStatus.ready ? ` ${t('Automatiskt nytt försök', 'Automatic retry')}: ${formatHomeTimeWithSeconds(runtimeStatus.runtime.retry_at, homeTimeZone)}.` : ''}
                    {runtimeStatus.runtime?.last_error ? ` ${runtimeStatus.runtime.last_error}` : ''}
                    {current.ha_ack_status === 'accepted' ? ` ${t('Tidigare accepterad', 'Previously accepted')}: ${current.ha_acknowledged_at ? formatHomeStamp(current.ha_acknowledged_at, homeTimeZone) : '—'}.` : ''}
                  </p>
                  {current.generation_request_id && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('Begäran', 'Request')} {current.generation_request_id} {current.ha_integration_version ? `· ${t('Accepterad/avvisad av HA', 'Acknowledged by HA')} ${current.ha_integration_version}` : ''}
                    </p>
                  )}
                  <p className="mt-1">{t('SHS söker normalt en ny plan var 15:e minut. En sparad plan kan fortsätta tills den löper ut om ingen ersättare kommer.', 'SHS normally checks for a new plan every 15 minutes. A cached plan can continue until it expires if no replacement arrives.')}</p>
                  <p className="mt-1">{t('Publicerade priser till', 'Published prices until')} {formatHomeStamp(plan.binding_until, homeTimeZone)}{' · '}{t('Planen gäller till', 'Plan valid until')} {formatHomeStamp(plan.valid_until, homeTimeZone)}</p>
                </details>
              )}
            </div>
            <div className="space-y-3 text-right">
              {replanControls}
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
              key={`${customerId}:${homeId}`}
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
              refreshing={refreshing}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
};



export default PlanWorkspace;
