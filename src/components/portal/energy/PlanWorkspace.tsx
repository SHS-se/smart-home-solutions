import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  type ThermalFixtureSeason,
} from '@/lib/energy-shift/contracts';
import { createWebsiteDemoActuals, createWebsiteDemoPlan } from '@/lib/energy-shift/demo';
import { formatSigned } from '@/lib/energy-shift/plan-comparison';
import {
  type ThermalObservationSummary,
  type ThermalZoneModelSummary,
} from '@/lib/energy-shift/thermal-readiness';
import {
  EMPTY_THERMAL_OBSERVATIONS,
  type CurrentRow,
  type EmpiricalDeviceSlotMatrix,
  type HomeAssistantConnection,
  type ZoneModelRow,
  type ThermalSlotRow,
  summariseThermalSlots,
} from './plan/types';
export type { PlanSection } from './plan/types';
import type { PlanSection } from './plan/types';
import {
  DeltaKpi,
  EmptyState,
  Kpi,
} from './plan/ui';
import ActualPerformance from './plan/ActualPerformance';
import { usePlanModel } from './plan/usePlanModel';
import PowerSection from './plan/sections/PowerSection';
import ThermalSection from './plan/sections/ThermalSection';
import EconomicsSection from './plan/sections/EconomicsSection';
import StorageSection from './plan/sections/StorageSection';

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

const PlanWorkspace: React.FC<PlanWorkspaceProps> = ({ section, customerId, homeId, accountPath }) => {
  const { t } = useLanguage();
  const [current, setCurrent] = useState<CurrentRow | null>(null);
  const [actuals, setActuals] = useState<ActualEnergySlot[]>([]);
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
        connectionResult,
        deviceResult,
        deviceActualResult,
        thermalResult,
        zoneModelResult,
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
        supabase
          .from('energy_optimisation_zone_models')
          .select('device_id, trained, rejection_reason, sample_count')
          .eq('customer_id', customerId)
          .eq('home_id', homeId),
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
      const deviceKeyById = new Map(
        (deviceRows ?? []).map(row => [row.id as string, row.device_key as string]),
      );
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
            // The panel counts zones, not parameters, so the device key is
            // only needed to line a model up with its device.
            device_key: deviceKeyById.get(row.device_id) ?? row.device_id,
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
          onChanged={() => load(true)}
        />
      );
    }
  } else if (view === 'demo') {
    content = (
      <PlanView
        section={section}
        current={demoCurrent}
        actuals={demoActuals}
        empiricalDevices={[]}
        thermalObservations={EMPTY_THERMAL_OBSERVATIONS}
        zoneModels={[]}
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
        {section === 'plan' && <ActualPerformance actuals={actuals} devices={empiricalDevices} deviceActuals={deviceActuals} />}
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
          current={current}
          actuals={actuals}
          empiricalDevices={empiricalDevices}
          thermalObservations={thermalObservations}
          zoneModels={zoneModels}
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
  current: CurrentRow;
  actuals: ActualEnergySlot[];
  empiricalDevices: EmpiricalEnergyDevice[];
  thermalObservations: ThermalObservationSummary;
  zoneModels: ThermalZoneModelSummary[];
  deviceActuals: EmpiricalDeviceSlotMatrix[];
  stale: boolean;
  isDemo: boolean;
  lastCheckedAt?: number | null;
}> = ({
  section,
  current,
  actuals,
  empiricalDevices,
  deviceActuals,
  thermalObservations,
  zoneModels,
  stale,
  isDemo,
  lastCheckedAt,
}) => {
  const { t } = useLanguage();
  const model = usePlanModel(current, empiricalDevices, stale);
  const {
    plan, planView, setPlanView, executed, active, comparison, hasBattery,
    sourceStale, bindingExpired, ready, pct, costDelta, costTone, costMeaning,
    validationMessages,
  } = model;

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
          {section === 'plan' && (
          <>
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
          <PowerSection model={model} />
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
          {section === 'economics' && <EconomicsSection model={model} />}
          {section === 'storage' && <StorageSection model={model} />}
        </CardContent>
      </Card>

      {section === 'plan' && (
      <ActualPerformance actuals={actuals} devices={empiricalDevices} deviceActuals={deviceActuals} />
      )}

    </div>
  );
};



export default PlanWorkspace;
