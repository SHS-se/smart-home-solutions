import React, { useState } from 'react';
import { Database, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { DeviceLoadType } from '@/lib/energy-shift/contracts';

export interface EmpiricalEnergyDevice {
  id: string;
  device_key: string;
  statistic_id: string;
  name: string;
  category: string;
  suggested_load_type: DeviceLoadType;
  load_type_override: DeviceLoadType | null;
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

const EmpiricalDeviceModelsCard: React.FC<{
  devices: EmpiricalEnergyDevice[];
  onChanged: () => Promise<void> | void;
}> = ({ devices, onChanged }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [savingId, setSavingId] = useState<string | null>(null);
  const label: Record<DeviceLoadType, string> = {
    fixed_full_load: t('Fast full last', 'Fixed full load'),
    variable_full_load: t('Variabel full last', 'Variable full load'),
    duty_cycle: t('Termostat / driftcykel', 'Thermostat / duty cycle'),
    inverter: t('Inverterlast', 'Inverter load'),
  };

  const update = async (device: EmpiricalEnergyDevice, value: string) => {
    setSavingId(device.id);
    const loadType = value === 'automatic' ? null : value as DeviceLoadType;
    const { error } = await supabase.rpc('set_energy_device_load_type', {
      p_device_id: device.id,
      p_load_type: loadType,
    });
    if (error) {
      toast({ title: t('Kunde inte spara lasttypen', 'Could not save load type'), description: error.message, variant: 'destructive' });
    } else {
      await onChanged();
    }
    setSavingId(null);
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
            'Varje enhet i Home Assistants energipanel klassificeras automatiskt och lärs från kompletta 15-minutersvärden. Klassificeringen här är lokal för hemmet och kan ändras av kunden eller personal. Globala personalmallar hanteras fortfarande i Enhetskatalogen.',
            'Every Energy Dashboard device is classified automatically and learned from complete 15-minute values. This classification is local to the home and can be changed by the customer or staff. Staff-owned global templates remain in the Device Catalog.',
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
                    <TableCell className="min-w-[230px]">
                      <div className="flex items-center gap-2">
                        <Select
                          value={device.load_type_override ?? 'automatic'}
                          onValueChange={value => void update(device, value)}
                          disabled={savingId === device.id}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="automatic">
                              {t('Automatisk', 'Automatic')} · {label[device.suggested_load_type]}
                            </SelectItem>
                            {LOAD_TYPES.map(type => <SelectItem key={type} value={type}>{label[type]}</SelectItem>)}
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
          <div><span className="font-medium text-foreground">{label.fixed_full_load}:</span> {t('samma märkeffekt under hela på-tiden', 'one rated power throughout on-time')}</div>
          <div><span className="font-medium text-foreground">{label.variable_full_load}:</span> {t('varierande effekt medan enheten arbetar', 'varying power while the device works')}</div>
          <div><span className="font-medium text-foreground">{label.duty_cycle}:</span> {t('termostaten styr påslag; planen styr tillåtelse/avstängning', 'the thermostat owns cycling; the plan owns permit/off')}</div>
          <div><span className="font-medium text-foreground">{label.inverter}:</span> {t('empirisk varierande last, normalt temperaturberoende', 'empirical variable load, normally temperature-dependent')}</div>
        </div>
      </CardContent>
    </Card>
  );
};

export default EmpiricalDeviceModelsCard;
