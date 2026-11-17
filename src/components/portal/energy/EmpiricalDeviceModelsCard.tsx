import React, { useEffect, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { PortalOptimisationPlan } from '@/lib/energy-shift/contracts';
import { describeMeasurementIssue, planMeasurementIssues } from '@/lib/energy-shift/measurement-issues';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
export type { EmpiricalEnergyDevice } from '@/lib/energy-shift/device-colours';
import type { EmpiricalEnergyDevice } from '@/lib/energy-shift/device-colours';
import DeviceName from './DeviceName';
import DeviceHeatingPowerModel from './DeviceHeatingPowerModel';

const PlanningToggle: React.FC<{
  name: string; included: boolean; disabled: boolean; onChange: (included: boolean) => void;
}> = ({ name, included, disabled, onChange }) => {
  const { t } = useLanguage();
  return <label className="inline-flex items-center gap-2 whitespace-nowrap">
    <Switch checked={included} disabled={disabled} onCheckedChange={onChange}
      aria-label={t(`Planera ${name}`, `Plan ${name}`)} />
    <span>{included ? t('Planerad', 'Planned') : t('Övervakning', 'Monitoring')}</span>
  </label>;
};

const EmpiricalDeviceModelsCard: React.FC<{
  devices: EmpiricalEnergyDevice[];
  homeId: string;
  onChanged: () => Promise<void> | void;
  refreshing?: boolean;
  plan: PortalOptimisationPlan | null;
  now: number;
}> = ({ devices, homeId, onChanged, plan, now, refreshing = false }) => {
  devices = devices.filter(device => device.retired_at === null);
  const { t } = useLanguage();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [battery, setBattery] = useState<{ battery_present: boolean; battery_included: boolean; battery_choice_at: string | null } | null>(null);
  const [choiceError, setChoiceError] = useState("");
  useEffect(() => {
    let active = true;
    supabase.from('energy_optimisation_home_planning').select('battery_present, battery_included, battery_choice_at')
      .eq('home_id', homeId).maybeSingle().then(({ data, error }) => {
        if (active) { setBattery(data); setChoiceError(error?.message ?? ""); }
      });
    return () => { active = false; };
  }, [homeId]);
  const chooseBattery = async (included: boolean) => {
    if (refreshing || savingId !== null) return;
    setSavingId('battery'); setChoiceError("");
    const { data, error } = await supabase.rpc('set_energy_battery_planning', { p_home_id: homeId, p_included: included });
    if (error) setChoiceError(error.message);
    else { setBattery(data); await onChanged(); }
    setSavingId(null);
  };
  const mappingState = (device: EmpiricalEnergyDevice) => {
    if (device.planning_role_override === 'base_load') return 'base_load' as const;
    if (
      device.mapping_status === 'ready'
      && device.mapped_control_type === device.control_type_override
    ) return 'ready' as const;
    if (
      device.mapping_status === 'invalid'
      && device.mapped_control_type === device.control_type_override
    ) return 'invalid' as const;
    return 'pending' as const;
  };
  const setupFieldLabels: Record<string, string> = {
    control_type: t('Styrmetod', 'Control method'),
    actuator_entity_ids: t('Styrenhet', 'Control entity'),
    control_entity_id: t('Effekt- eller strömstyrning', 'Power or current control'),
    temperature_entity_id: t('Rumstemperatur', 'Room temperature'),
    room_area_id: t('Rum', 'Room'),
    power: t('Effekt', 'Power'),
    minimum_value: t('Minimivärde', 'Minimum value'),
    maximum_value: t('Maximivärde', 'Maximum value'),
    pool_water_temperature_entity: t('Pooltemperatur', 'Pool water temperature'),
    pool_start_temperature_entity: t('Värmarens starttemperatur', 'Heater start temperature'),
    pool_stop_temperature_entity: t('Värmarens stopptemperatur', 'Heater stop temperature'),
  };
  const setupFields = (device: EmpiricalEnergyDevice) => {
    const fields = device.mapping_summary?.setup_fields;
    return Array.isArray(fields) ? fields.flatMap((field: unknown) =>
      typeof field === 'string' && Object.prototype.hasOwnProperty.call(setupFieldLabels, field)
        ? [setupFieldLabels[field]] : []) : [];
  };

  const persist = async (
    device: EmpiricalEnergyDevice,
    operation: PromiseLike<{ error: { message: string } | null }>,
    errorTitle: string,
  ) => {
    if (refreshing || savingId !== null) return;
    setSavingId(device.id);
    const { error } = await operation;
    if (error) {
      toast({ title: errorTitle, description: error.message, variant: 'destructive' });
    } else {
      await onChanged();
    }
    setSavingId(null);
  };

  const updatePlanning = (device: EmpiricalEnergyDevice, included: boolean) => {
    return persist(
      device,
      supabase.rpc('set_energy_device_participation', {
        p_device_id: device.id,
        p_planning_role: included ? 'controllable' : 'base_load',
      }),
      t('Kunde inte spara planeringsrollen', 'Could not save planning role'),
    );
  };

  const roomKey = (device: EmpiricalEnergyDevice) => typeof device.mapping_summary?.room_key === 'string'
    ? device.mapping_summary.room_key : null;
  const currentPlan = plan?.status === 'ready' && Date.parse(plan.valid_until) > now ? plan : null;
  const priority = currentPlan?.plans.priority;
  const issues = planMeasurementIssues(currentPlan);
  const hasBattery = battery?.battery_present === true;
  const selection = params.get('device');
  const selected = devices.find(device => device.id === selection) ?? devices[0];
  const selectedBattery = hasBattery && (selection === 'battery' || !selected);

  function planStatus(device: EmpiricalEnergyDevice | null) {
    const key = device?.device_key ?? '$battery';
    const owner = currentPlan?.operating_scope?.device_owners[key] ?? key;
    const system = owner.startsWith('$') ? owner.slice(1) : null;
    const room = device && roomKey(device);
    const measurement = issues.filter(issue => issue.device === system);
    const warnings = (currentPlan?.planning_warnings ?? []).filter(warning =>
      [key, owner, system, room].includes(warning.scope));
    const scheduled = system === 'battery' ? currentPlan?.battery != null
      : priority?.slots.some(slot => Object.prototype.hasOwnProperty.call(slot.device_commands ?? {}, key))
        || (system != null && priority?.dispatched_devices.includes(system))
        || (system != null && currentPlan?.services.some(service => service.device === system
          && (Object.prototype.hasOwnProperty.call(priority?.service_slots ?? {}, service.id)
            || Object.prototype.hasOwnProperty.call(priority?.service_inhibited_slots ?? {}, service.id))));
    const forecast = device && currentPlan?.device_models.some(model => model.key === key)
      && priority?.slots.some(slot => Object.prototype.hasOwnProperty.call(slot.device_loads_w ?? {}, key));
    const included = device ? device.planning_role_override === 'controllable' : battery?.battery_included;
    const setup = device && mappingState(device) !== 'ready';
    const fields = device ? setupFields(device) : [];
    const keys = device?.mapping_summary?.setup_fields;
    const detail = Array.isArray(keys) && keys.includes('temperature_entity_id')
      ? t('Planeraren behöver ett användbart rumsmätvärde för att uppfylla komfortschemat.',
        'The planner needs a usable room temperature reading to schedule against the comfort targets.')
      : null;
    const correction = device && !device.control_type_override
      ? t('Välj Styrmetod under Enheter i SHS-appen.', 'Choose Control method under Devices in the SHS app.')
      : fields.length
        ? t(`Kontrollera ${fields.join(', ')} under Enheter i SHS-appen.`, `Check ${fields.join(', ')} under Devices in the SHS app.`)
        : t('Öppna enhetens inställningar under Enheter i SHS-appen.', 'Open this device under Devices in the SHS app to complete its setup.');
    if (!included) return { heading: t('Utanför planen', 'Not in the plan'), label: t('Övervakning', 'Monitoring'),
      reason: device ? t('Förbrukningen räknas i hushållets baslast.', 'Its consumption counts toward household base load.')
        : t('Husbatteriet är inte valt för planering.', 'The house battery is excluded from planning.'), details: [] };
    if (measurement.length) return { heading: t('Utanför planen', 'Not in the plan'), label: t('Mätvärde behöver kontrolleras', 'Reading needs attention'),
      reason: null, details: measurement.map(issue => describeMeasurementIssue(issue, t)) };
    if (setup && !scheduled) return { heading: t('Utanför planen', 'Not in the plan'), label: t('Behöver ställas in i appen', 'Needs app setup'),
      reason: detail, details: [correction] };
    if (scheduled || forecast) return { heading: t('Ingår i planen', 'In the plan'), label: null,
      reason: scheduled ? t('Den senaste planen omfattar enheten.', 'The latest plan includes this device.')
        : t('Planen innehåller en prognos för enhetens förbrukning.', 'The plan includes a forecast of this device’s consumption.'),
      details: warnings.flatMap(warning => [warning.message, warning.consequence]) };
    return { heading: currentPlan ? t('Utanför planen', 'Not in the plan') : t('Ingen aktuell plan', 'No current plan'), label: null,
      reason: warnings.length ? null : currentPlan
        ? t('Den senaste planen innehåller inga instruktioner för enheten. Ingen specifik orsak har rapporterats.', 'The latest plan has no instructions for this device. No specific reason was reported.')
        : t('Nästa plan visar om enheten har tagits med.', 'The next plan will show whether the device is included.'),
      details: warnings.flatMap(warning => [warning.message, warning.consequence]) };
  }

  const device = selectedBattery ? null : selected;
  const status = planStatus(device ?? null);
  const name = device?.name ?? t('Husbatteri', 'House battery');
  const selectedRoom = device && roomKey(device);
  const roomName = device?.mapping_summary?.room_name;
  const viewRoom = selectedRoom && typeof roomName === 'string';
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('device', id);
    setParams(next, { replace: true });
  };
  const items = [
    ...(hasBattery ? [{ id: 'battery', name: t('Husbatteri', 'House battery'), needsSetup: false, device: null }] : []),
    ...devices.map(item => ({ id: item.id, name: item.name, device: item,
      needsSetup: item.planning_role_override === 'controllable' && mappingState(item) !== 'ready' })),
  ];

  return (
    <Card className="overflow-hidden">
      {choiceError && <p className="px-4 py-3 text-sm text-destructive" role="alert">{choiceError}</p>}
      {!items.length ? (
        <p className="p-5 text-sm text-muted-foreground">{t('Väntar på en enhetsinventering från Home Assistant.', 'Waiting for a device inventory from Home Assistant.')}</p>
      ) : (
        <div className="grid min-w-0 md:grid-cols-[minmax(10rem,13rem)_minmax(0,1fr)]">
          <nav aria-label={t('Enheter', 'Devices')} className="flex gap-2 overflow-x-auto border-b bg-muted/25 p-3 md:block md:space-y-1 md:overflow-visible md:border-b-0 md:border-r">
            {items.map(item => {
              const active = item.id === (selectedBattery ? 'battery' : device?.id);
              return <button key={item.id} type="button" aria-current={active ? 'true' : undefined}
                onClick={() => select(item.id)}
                className={`min-h-11 shrink-0 rounded-md px-3 py-2 text-left text-sm font-medium md:w-full ${active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}>
                <span className="flex items-center justify-between gap-2">{item.device ? <DeviceName name={item.name} colour={item.device.colour} deviceKey={item.device.device_key} /> : item.name}{active && <ChevronRight className="size-4 shrink-0" aria-hidden="true" />}</span>
                {item.needsSetup && <span className="block text-xs text-muted-foreground">{t('Behöver ställas in', 'Needs setup')}</span>}
              </button>;
            })}
          </nav>
          <section className="min-w-0 space-y-4 p-4 sm:p-6" aria-labelledby="device-detail-title">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="device-detail-title" className="text-xl font-semibold">{name}</h2>
                {device && <p className="text-sm text-muted-foreground">
                  {[device.category.replace(/_/g, ' '), viewRoom ? roomName : null].filter(Boolean).join(' · ')}
                </p>}
              </div>
              {viewRoom && <Link className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary"
                to={{ search: new URLSearchParams({ tab: 'comfort', room: selectedRoom }).toString() }}>
                {t('Visa rum', 'View room')} <ChevronRight className="size-4" aria-hidden="true" />
              </Link>}
            </header>
            <Tabs defaultValue="plan" key={device?.id ?? 'battery'}>
              <TabsList className="justify-start" aria-label={t('Enhetsvyer', 'Device views')}>
                <TabsTrigger value="plan" className="min-h-10">{t('Plan', 'Plan')}</TabsTrigger>
                <TabsTrigger value="model" className="min-h-10">{t('Modell', 'Model')}</TabsTrigger>
              </TabsList>
              <TabsContent value="plan" className="space-y-4">
                <div className="space-y-2 rounded-md border border-l-4 border-l-primary bg-muted/30 p-4" aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">{status.heading}</h3>
                    {status.label && <Badge variant="outline">{status.label}</Badge>}
                  </div>
                  {status.reason && <p className="text-sm">{status.reason}</p>}
                  {status.details.map((detail, index) => <p key={index} className="text-sm">{detail}</p>)}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
                  <span>{t('Inkludera i planen', 'Include in plan')}</span>
                  {device ? <PlanningToggle name={name} included={device.planning_role_override === 'controllable'}
                    disabled={refreshing || savingId !== null || (!device.control_type_override && device.planning_role_override !== 'controllable')}
                    onChange={included => void updatePlanning(device, included)} />
                    : <PlanningToggle name={t('husbatteriet', 'house battery')} included={battery?.battery_included === true}
                      disabled={refreshing || savingId !== null} onChange={included => void chooseBattery(included)} />}
                  {savingId === (device?.id ?? 'battery') && <Loader2 aria-label={t('Sparar', 'Saving')} className="size-4 animate-spin" />}
                </div>
              </TabsContent>
              <TabsContent value="model">
                {device ? <DeviceHeatingPowerModel homeId={homeId} deviceKey={device.device_key}>
                  <dl className="grid gap-4 rounded-md border p-4 text-sm sm:grid-cols-2">
                    <div><dt className="text-muted-foreground">{t('Aktiv effekt', 'Active power')}</dt>
                      <dd>{device.active_power_w == null ? '—' : `${(device.active_power_w / 1_000).toFixed(2)} kW`}</dd></div>
                    <div><dt className="text-muted-foreground">{t('Historik', 'History')}</dt>
                      <dd>{device.profile_sample_count > 0 ? `${device.profile_sample_count} × 15 min` : t('Samlas in', 'Collecting')}</dd></div>
                  </dl>
                </DeviceHeatingPowerModel> : <p className="rounded-md border p-4 text-sm">{t('Batteriets modell och prognos visas i energiplanen.', 'The energy plan shows the battery model and forecast.')}</p>}
              </TabsContent>
            </Tabs>
          </section>
        </div>
      )}
    </Card>
  );
};

export default EmpiricalDeviceModelsCard;
