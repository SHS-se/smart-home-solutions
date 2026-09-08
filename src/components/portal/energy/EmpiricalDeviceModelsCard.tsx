import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Database, Loader2 } from 'lucide-react';
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
  planning_choice_at: string | null;
  control_type_override: DeviceControlType | null;
  mapping_status: 'not_configured' | 'ready' | 'invalid';
  mapped_control_type: DeviceControlType | null;
  mapping_error: string | null;
  mapping_summary: Record<string, unknown>;
  mapping_reported_at: string | null;
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
];

const EmpiricalDeviceModelsCard: React.FC<{
  devices: EmpiricalEnergyDevice[];
  homeId: string;
  onChanged: () => Promise<void> | void;
}> = ({ devices, homeId, onChanged }) => {
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
  const chooseBattery = async (value: string) => {
    setSavingId('battery'); setChoiceError("");
    const { data, error } = await supabase.rpc('set_energy_battery_planning', { p_home_id: homeId, p_included: value === 'included' });
    if (error) setChoiceError(error.message);
    else { setBattery(data); await onChanged(); }
    setSavingId(null);
  };
  const loadLabel: Record<DeviceLoadType, string> = {
    fixed_full_load: t('Fast full last', 'Fixed full load'),
    variable_full_load: t('Variabel full last', 'Variable full load'),
    duty_cycle: t('Termostat / driftcykel', 'Thermostat / duty cycle'),
    inverter: t('Inverterlast', 'Inverter load'),
  };
  const roleLabel: Record<DevicePlanningRole, string> = {
    base_load: t('Exkluderat', 'Excluded'),
    controllable: t('Inkluderat', 'Included'),
  };
  const controlLabel: Record<DeviceControlType, string> = {
    switch_schedule: t('På/av-schema', 'On/off schedule'),
    variable_power: t('Variabel effekt', 'Variable power'),
    permit_inhibit: t('Tillåt/blockera', 'Permit/inhibit'),
    setpoint: t('Börvärde', 'Setpoint'),
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
  const pendingCount = devices.filter(device => mappingState(device) === 'pending').length;
  const invalidCount = devices.filter(device => mappingState(device) === 'invalid').length;

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
        {choiceError && <p role="alert" className="text-destructive">{choiceError}</p>}
        {battery?.battery_present && <div className="rounded-md border p-3">
          <strong>{t('Husbatteri', 'House battery')}</strong>
          <label className="mt-2 block text-sm">{t('Inkludera i planen', 'Include in the plan')}</label>
          <Select value={battery.battery_choice_at ? (battery.battery_included ? 'included' : 'excluded') : ''}
            onValueChange={value => void chooseBattery(value)} disabled={savingId !== null}>
            <SelectTrigger aria-label="Include house battery in the plan"><SelectValue placeholder={t('Inkluderat — inte granskat', 'Included — not reviewed')} /></SelectTrigger>
            <SelectContent><SelectItem value="included">{t('Inkluderat', 'Included')}</SelectItem><SelectItem value="excluded">{t('Exkluderat', 'Excluded')}</SelectItem></SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">{t('Tillåt styrning i Home Assistant.', 'Permission to operate it is chosen in Home Assistant.')}</p>
        </div>}
        <p className="text-sm text-muted-foreground">
          {t(
            'Alla nya enheter börjar som baslast och lärs från verkliga 15-minutersvärden. När du väljer en styrtyp här blir den en begäran till Home Assistant. Enheten stannar i baslasten tills en matchande lokal entitetsmappning har bekräftats; först då visas den som en egen planserie.',
            'Every new device starts in base load and is learned from real 15-minute values. Selecting a control type here creates a request for Home Assistant. The device stays in base load until a matching local entity mapping is confirmed; only then does it become a separate plan series.',
          )}
        </p>
        {(pendingCount > 0 || invalidCount > 0) && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">
                {t(
                  `${pendingCount + invalidCount} styrbara enheter behöver konfigureras i Home Assistant`,
                  `${pendingCount + invalidCount} controllable devices need Home Assistant configuration`,
                )}
              </div>
              <div className="text-xs opacity-80">
                {t(
                  'Öppna Konfigurera på SHS-integrationen. Den hämtar dessa val direkt—ingen omstart av Home Assistant krävs.',
                  'Open Configure on the SHS integration. It fetches these selections immediately—no Home Assistant restart is required.',
                )}
              </div>
            </div>
          </div>
        )}
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
                  <TableHead>{t('Planeringsroll / styrning', 'Include in the plan')}</TableHead>
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
                        value={!device.planning_choice_at ? '' : device.planning_role_override === 'base_load'
                          ? 'base_load'
                          : `controllable:${device.control_type_override}`}
                        onValueChange={value => void updatePlanning(device, value)}
                        disabled={savingId === device.id}
                      >
                        <SelectTrigger className="h-8" aria-label={`Include ${device.name} in the plan`}><SelectValue placeholder={t("Inte granskat", "Not reviewed")} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="base_load">{roleLabel.base_load}</SelectItem>
                          {CONTROL_TYPES.map(type => (
                            <SelectItem key={type} value={`controllable:${type}`}>
                              {roleLabel.controllable} · {controlLabel[type]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                        {mappingState(device) === 'ready' ? (
                          <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{t('Klar i Home Assistant', 'Ready in Home Assistant')}</>
                        ) : mappingState(device) === 'invalid' ? (
                          <><AlertTriangle className="h-3.5 w-3.5 text-destructive" /><span title={device.mapping_error ?? undefined}>{t('Behöver åtgärdas', 'Needs attention')}</span></>
                        ) : mappingState(device) === 'pending' ? (
                          <><Clock3 className="h-3.5 w-3.5 text-amber-600" />{t('Konfigurera i Home Assistant', 'Set up in Home Assistant')}</>
                        ) : (
                          <>{t('Ingår i empirisk baslast', 'Included in empirical base load')}</>
                        )}
                      </div>
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
            'Styrtypen beskriver den verkliga kontrollmöjligheten. Integrationen hämtar ändringar automatiskt vid nästa 15-minutersutbyte eller direkt när Konfigurera öppnas. Ofullständiga eller felaktiga mappningar stannar säkert i baslasten. Varmvatten med Tillåt/blockera låter fortfarande den egna termostaten bestämma driftcykeln; planen kan bara blockera olämpliga kvartar, aldrig tvinga enheten att slå på.',
            'The control type describes the real control capability. The integration fetches changes automatically on the next 15-minute exchange, or immediately when Configure is opened. Incomplete or invalid mappings safely remain in base load. Permit/inhibit hot water still leaves the duty cycle to its own thermostat; the plan can only block unsuitable quarters, never force the device on.',
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default EmpiricalDeviceModelsCard;
