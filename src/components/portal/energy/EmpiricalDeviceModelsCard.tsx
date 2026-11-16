import React, { useEffect, useState } from 'react';
import { AlertTriangle, Database, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
export type { EmpiricalEnergyDevice } from '@/lib/energy-shift/device-colours';
import type { EmpiricalEnergyDevice } from '@/lib/energy-shift/device-colours';
import DeviceName from './DeviceName';

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
}> = ({ devices, homeId, onChanged, refreshing = false }) => {
  devices = devices.filter(device => device.retired_at === null);
  const { t } = useLanguage();
  const { toast } = useToast();
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" />
          {t('Enhetsplanering', 'Device planning')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {choiceError && <p role="alert" className="text-destructive">{choiceError}</p>}
        {battery?.battery_present && <div className="rounded-md border p-3">
          <strong>{t('Husbatteri', 'House battery')}</strong>
          <label className="mt-2 block text-sm">{t('Planering', 'Planning')}</label>
          <PlanningToggle name={t('husbatteriet', 'house battery')} included={battery.battery_included}
            disabled={refreshing || savingId !== null} onChange={included => void chooseBattery(included)} />
          <p className="mt-2 text-xs text-muted-foreground">{t('Tillåt styrning i Home Assistant.', 'Permission to operate it is chosen in Home Assistant.')}</p>
        </div>}
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('Väntar på en enhetsinventering från Home Assistant.', 'Waiting for a device inventory from Home Assistant.')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Enhet', 'Device')}</TableHead>
                  <TableHead>{t('Kategori', 'Category')}</TableHead>
                  <TableHead>{t('Planering', 'Planning')}</TableHead>
                  <TableHead>{t('Planeringsstatus', 'Planning status')}</TableHead>
                  <TableHead className="text-right">{t('Aktiv effekt', 'Active power')}</TableHead>
                  <TableHead className="text-right">{t('Historik', 'History')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map(device => {
                  const status = mappingState(device);
                  const fields = setupFields(device);
                  return <TableRow key={device.id}>
                    <TableCell>
                      <DeviceName name={device.name} colour={device.colour} deviceKey={device.device_key} className="font-medium" />
                    </TableCell>
                    <TableCell><Badge variant="outline">{device.category.replace(/_/g, ' ')}</Badge></TableCell>
                    <TableCell>
                      <PlanningToggle name={device.name} included={device.planning_role_override === 'controllable'}
                        disabled={refreshing || savingId !== null || (!device.control_type_override && device.planning_role_override !== 'controllable')}
                        onChange={included => void updatePlanning(device, included)} />
                      {savingId === device.id && <Loader2 aria-label={t('Sparar', 'Saving')} className="mt-1 h-4 w-4 animate-spin" />}
                    </TableCell>
                    <TableCell className="min-w-[200px] text-sm">
                      {!device.control_type_override || status === 'pending' || status === 'invalid' ? (
                        <div className="flex items-start gap-2">
                          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <div>
                            {status === 'base_load' ? t('Ingår i baslasten', 'Counted in household use')
                              : t('Utanför planeringen tills installationen är klar', 'Left out of planning until setup is complete')}
                            <p className="text-xs text-muted-foreground">
                              {!device.control_type_override
                                ? t('Välj Styrmetod under Enheter i SHS-appen.', 'Choose Control method under Devices in the SHS app.')
                                : fields.length
                                  ? t(`Kontrollera ${fields.join(', ')} under Enheter i SHS-appen.`, `Check ${fields.join(', ')} under Devices in the SHS app.`)
                                  : t('Öppna enhetens inställningar under Enheter i SHS-appen.', 'Open this device under Devices in the SHS app to complete its setup.')}
                            </p>
                          </div>
                        </div>
                      ) : status === 'ready' ? t('Klar för planering', 'Ready to plan')
                        : t('Ingår i baslasten', 'Counted in household use')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {device.active_power_w == null ? '—' : `${(device.active_power_w / 1_000).toFixed(2)} kW`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {device.profile_sample_count > 0
                        ? `${device.profile_sample_count} × 15 min`
                        : t('Samlas in', 'Collecting')}
                    </TableCell>
                  </TableRow>;
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default EmpiricalDeviceModelsCard;
