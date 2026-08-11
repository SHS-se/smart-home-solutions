import React, { useState } from 'react';
import { Database, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type {
  DeviceControlType,
  DeviceLoadType,
  DevicePlanningRole,
} from '@/lib/energy-shift/contracts';

export interface EmpiricalEnergyDevice {
  id: string;
  device_key: string;
  statistic_id: string;
  name: string;
  category: string;
  load_type_override: DeviceLoadType;
  planning_role_override: DevicePlanningRole;
  control_type_override: DeviceControlType | null;
  active_power_w: number | null;
  profile_sample_count: number;
  last_seen_at: string;
}

const LOAD_TYPES: DeviceLoadType[] = [
  'fixed_full_load',
  'variable_full_load',
  'duty_cycle',
  'inverter',
];

const CONTROL_TYPES: DeviceControlType[] = [
  'switch_schedule',
  'variable_power',
  'permit_inhibit',
  'setpoint',
  'current_limit',
];

const EmpiricalDeviceModelsCard: React.FC<{
  devices: EmpiricalEnergyDevice[];
  onChanged: () => Promise<void> | void;
}> = ({ devices, onChanged }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [savingId, setSavingId] = useState<string | null>(null);
  const loadLabel: Record<DeviceLoadType, string> = {
    fixed_full_load: t('Fast full last', 'Fixed full load'),
    variable_full_load: t('Variabel full last', 'Variable full load'),
    duty_cycle: t('Termostat / driftcykel', 'Thermostat / duty cycle'),
    inverter: t('Inverterlast', 'Inverter load'),
  };
  const roleLabel: Record<DevicePlanningRole, string> = {
    base_load: t('Baslast', 'Base load'),
    controllable: t('Styrbar', 'Controllable'),
  };
  const controlLabel: Record<DeviceControlType, string> = {
    switch_schedule: t('På/av-schema', 'On/off schedule'),
    variable_power: t('Variabel effekt', 'Variable power'),
    permit_inhibit: t('Tillåt/blockera', 'Permit/inhibit'),
    setpoint: t('Börvärde', 'Setpoint'),
    current_limit: t('Strömgräns', 'Current limit'),
  };

  const persist = async (
    device: EmpiricalEnergyDevice,
    operation: PromiseLike<{ error: { message: string } | null }>,
    errorTitle: string,
  ) => {
    setSavingId(device.id);
    const { error } = await operation;
    if (error) {
      toast({ title: errorTitle, description: error.message, variant: 'destructive' });
    } else {
      await onChanged();
    }
    setSavingId(null);
  };

  const updateLoadType = (device: EmpiricalEnergyDevice, value: string) => persist(
    device,
    supabase.rpc('set_energy_device_load_type', {
      p_device_id: device.id,
      p_load_type: value as DeviceLoadType,
    }),
    t('Kunde inte spara lasttypen', 'Could not save load type'),
  );

  const updatePlanning = (device: EmpiricalEnergyDevice, value: string) => {
    const [role, control] = value.split(':') as [DevicePlanningRole, DeviceControlType | undefined];
    return persist(
      device,
      supabase.rpc('set_energy_device_planning', {
        p_device_id: device.id,
        p_planning_role: role,
        p_control_type: control ?? null,
      }),
      t('Kunde inte spara planeringsrollen', 'Could not save planning role'),
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" />
          {t('Empiriska enhetsmodeller från Home Assistant', 'Empirical Home Assistant device models')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t(
            'Alla enheter lärs från verkliga 15-minutersvärden. Home Assistant-analysen väljer startvärdena när en enhet upptäcks; därefter behålls valen tills kunden eller personal ändrar dem. Baslastenheter slås ihop med hemmets empiriska baslast och visas inte separat. Bara styrbara enheter tas ut ur baslasten och visas som egna serier. Klassificeringen är lokal för hemmet; globala personalmallar finns kvar i Enhetskatalogen.',
            'Every device is learned from real 15-minute values. Home Assistant inference chooses the initial values when a device is discovered; the selections then persist until the customer or staff changes them. Base-load devices are merged into the home’s empirical base load and are not shown separately. Only controllable devices are removed from base load and shown as individual series. Classification is local to the home; staff-owned global templates remain in the Device Catalog.',
          )}
        </p>
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
                  <TableHead>{t('Planeringsroll / styrning', 'Planning role / control')}</TableHead>
                  <TableHead>{t('Lastkaraktär', 'Load characteristic')}</TableHead>
                  <TableHead className="text-right">{t('Aktiv effekt', 'Active power')}</TableHead>
                  <TableHead className="text-right">{t('Historik', 'History')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map(device => (
                  <TableRow key={device.id}>
                    <TableCell>
                      <div className="font-medium">{device.name}</div>
                      <div className="max-w-[300px] truncate text-xs text-muted-foreground" title={device.statistic_id}>{device.statistic_id}</div>
                    </TableCell>
                    <TableCell><Badge variant="outline">{device.category.replace(/_/g, ' ')}</Badge></TableCell>
                    <TableCell className="min-w-[250px]">
                      <Select
                        value={device.planning_role_override === 'base_load'
                          ? 'base_load'
                          : `controllable:${device.control_type_override}`}
                        onValueChange={value => void updatePlanning(device, value)}
                        disabled={savingId === device.id}
                      >
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="base_load">{roleLabel.base_load}</SelectItem>
                          {CONTROL_TYPES.map(type => (
                            <SelectItem key={type} value={`controllable:${type}`}>
                              {roleLabel.controllable} · {controlLabel[type]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="min-w-[230px]">
                      <div className="flex items-center gap-2">
                        <Select
                          value={device.load_type_override}
                          onValueChange={value => void updateLoadType(device, value)}
                          disabled={savingId === device.id}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {LOAD_TYPES.map(type => <SelectItem key={type} value={type}>{loadLabel[type]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {savingId === device.id && <Loader2 className="h-4 w-4 animate-spin" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {device.active_power_w == null ? '—' : `${(device.active_power_w / 1_000).toFixed(2)} kW`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {device.profile_sample_count > 0
                        ? `${device.profile_sample_count} × 15 min`
                        : t('Samlas in', 'Collecting')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-4">
          <div><span className="font-medium text-foreground">{loadLabel.fixed_full_load}:</span> {t('samma märkeffekt under hela på-tiden', 'one rated power throughout on-time')}</div>
          <div><span className="font-medium text-foreground">{loadLabel.variable_full_load}:</span> {t('varierande effekt medan enheten arbetar', 'varying power while the device works')}</div>
          <div><span className="font-medium text-foreground">{loadLabel.duty_cycle}:</span> {t('en intern termostat styr den verkliga driftcykeln', 'an internal thermostat owns the real duty cycle')}</div>
          <div><span className="font-medium text-foreground">{loadLabel.inverter}:</span> {t('empirisk varierande last, normalt temperaturberoende', 'empirical variable load, normally temperature-dependent')}</div>
        </div>
        <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
          {t(
            'Styrtypen beskriver den verkliga kontrollmöjligheten och gör inte automatiskt en enhet styrbar i Home Assistant. En matchande lokal styrning måste vara konfigurerad. Ändringar används efter nästa Home Assistant-utbyte och omplanering. Varmvattenberedaren föreslås som Tillåt/blockera: dess egen termostat bestämmer när den drar effekt, och planen får bara blockera olämpliga kvartar — aldrig tvinga den att slå på.',
            'The control type describes the real control capability; it does not automatically make a device controllable in Home Assistant. A matching local controller must be configured. Changes take effect after the next Home Assistant exchange and replan. The water boiler is suggested as Permit/inhibit: its own thermostat decides when it draws power, and the plan may only block unsuitable quarters—never force it on.',
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default EmpiricalDeviceModelsCard;
