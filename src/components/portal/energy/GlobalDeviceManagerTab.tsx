import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Search, Plus, Trash2, Pencil, Globe, User, ArrowUpFromLine } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import DeviceInstanceDialog from './DeviceInstanceDialog';

interface DeviceInstanceRow {
  id: string;
  name: string;
  customer_id: string | null;
  field_values: Record<string, any>;
  device_template_id: string;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
  device_templates: {
    display_name: string;
    make: string;
    model: string;
    device_kind: string;
    device_types: {
      key: string;
      display_name: string;
    } | null;
  };
}

type FilterMode = 'all' | 'global' | 'customer';

const GlobalDeviceManagerTab: React.FC = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [devices, setDevices] = useState<DeviceInstanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInstanceRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceInstanceRow | null>(null);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('device_instances')
      .select('id, name, customer_id, field_values, device_template_id, controllable, shiftable, priority, device_templates(display_name, make, model, device_kind, device_types(key, display_name))')
      .order('name');
    if (data) setDevices(data as unknown as DeviceInstanceRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  const deviceTypes = Array.from(new Set(devices.map(d => d.device_templates?.device_types?.display_name).filter(Boolean))) as string[];

  const filtered = devices.filter(d => {
    if (filterMode === 'global' && d.customer_id !== null) return false;
    if (filterMode === 'customer' && d.customer_id === null) return false;
    if (typeFilter && d.device_templates?.device_types?.display_name !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.name.toLowerCase().includes(q) ||
        d.device_templates?.make?.toLowerCase().includes(q) ||
        d.device_templates?.model?.toLowerCase().includes(q) ||
        d.device_templates?.device_types?.display_name?.toLowerCase().includes(q);
    }
    return true;
  });

  const handleDelete = async (id: string) => {
    if (!confirm(t('Radera denna enhet?', 'Delete this device?'))) return;
    const { error } = await supabase.from('device_instances').delete().eq('id', id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen', 'Deleted') });
      if (selectedDevice?.id === id) setSelectedDevice(null);
      fetchDevices();
    }
  };

  const handlePromoteToGlobal = async (id: string) => {
    if (!confirm(t('Gör denna enhet global? Den kommer inte längre vara kopplad till en specifik kund.', 'Promote this device to global? It will no longer be tied to a specific customer.'))) return;
    const { error } = await supabase.from('device_instances').update({ customer_id: null } as any).eq('id', id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Enhet är nu global', 'Device is now global') });
      fetchDevices();
      if (selectedDevice?.id === id) {
        setSelectedDevice(prev => prev ? { ...prev, customer_id: null } : null);
      }
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left: Device list */}
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={() => { setEditingDevice(null); setDialogOpen(true); }}>
            <Plus className="w-4 h-4 mr-1" />
            {t('Ny global enhet', 'New Global Device')}
          </Button>
          <div className="flex gap-1 ml-auto">
            {(['all', 'global', 'customer'] as FilterMode[]).map(mode => (
              <Badge
                key={mode}
                variant={filterMode === mode ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => setFilterMode(mode)}
              >
                {mode === 'all' ? t('Alla', 'All') : mode === 'global' ? t('Globala', 'Global') : t('Kundägda', 'Customer')}
              </Badge>
            ))}
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Sök enheter...', 'Search devices...')} className="pl-9" />
        </div>

        {deviceTypes.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            <Badge variant={typeFilter === null ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setTypeFilter(null)}>
              {t('Alla typer', 'All Types')}
            </Badge>
            {deviceTypes.map(dt => (
              <Badge key={dt} variant={typeFilter === dt ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setTypeFilter(dt)}>
                {dt}
              </Badge>
            ))}
          </div>
        )}

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Namn', 'Name')}</TableHead>
                  <TableHead>{t('Tillverkare / Modell', 'Make / Model')}</TableHead>
                  <TableHead>{t('Typ', 'Type')}</TableHead>
                  <TableHead className="text-right">{t('Effekt', 'Power')}</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      {t('Inga enheter hittades.', 'No devices found.')}
                    </TableCell>
                  </TableRow>
                ) : filtered.map(d => (
                  <TableRow
                    key={d.id}
                    className={`cursor-pointer ${selectedDevice?.id === d.id ? 'bg-accent' : ''}`}
                    onClick={() => setSelectedDevice(d)}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {d.customer_id === null ? (
                          <Globe className="w-3.5 h-3.5 text-primary shrink-0" />
                        ) : (
                          <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        )}
                        {d.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{d.device_templates?.make} {d.device_templates?.model}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {d.device_templates?.device_types?.display_name || d.device_templates?.device_kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{formatPower(Number(d.field_values?.max_power_w) || 0).display}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={e => { e.stopPropagation(); handleDelete(d.id); }}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Right: Detail panel */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">{t('Detaljer', 'Details')}</h3>
        {!selectedDevice ? (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[200px] text-muted-foreground text-sm">
              {t('Välj en enhet för att se detaljer.', 'Select a device to see details.')}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                {selectedDevice.customer_id === null ? (
                  <Badge variant="default" className="text-xs"><Globe className="w-3 h-3 mr-1" />{t('Global', 'Global')}</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs"><User className="w-3 h-3 mr-1" />{t('Kundägd', 'Customer-owned')}</Badge>
                )}
                {selectedDevice.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div><Label className="text-muted-foreground">{t('Tillverkare', 'Make')}</Label><p>{selectedDevice.device_templates?.make || '—'}</p></div>
                <div><Label className="text-muted-foreground">{t('Modell', 'Model')}</Label><p>{selectedDevice.device_templates?.model || '—'}</p></div>
              </div>
              <div>
                <Label className="text-muted-foreground">{t('Typ', 'Type')}</Label>
                <p>{selectedDevice.device_templates?.device_types?.display_name || selectedDevice.device_templates?.device_kind}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label className="text-muted-foreground">{t('Effekt', 'Power')}</Label><p>{formatPower(Number(selectedDevice.field_values?.max_power_w) || 0).display}</p></div>
                <div><Label className="text-muted-foreground">{t('Prioritet', 'Priority')}</Label><p>{selectedDevice.priority}</p></div>
              </div>
              <div className="flex gap-4">
                <div className="flex items-center gap-2"><Label className="text-muted-foreground">{t('Styrbar', 'Controllable')}</Label><Switch checked={selectedDevice.controllable} disabled /></div>
                <div className="flex items-center gap-2"><Label className="text-muted-foreground">{t('Förskjutbar', 'Shiftable')}</Label><Switch checked={selectedDevice.shiftable} disabled /></div>
              </div>

              {/* Field values */}
              {Object.keys(selectedDevice.field_values || {}).length > 0 && (
                <div>
                  <Label className="text-muted-foreground mb-1 block">{t('Fältvärden', 'Field Values')}</Label>
                  <div className="bg-muted/50 rounded p-2 space-y-1 text-xs">
                    {Object.entries(selectedDevice.field_values).map(([k, v]) => (
                      <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k}</span><span>{String(v)}</span></div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={() => { setEditingDevice(selectedDevice); setDialogOpen(true); }}>
                  <Pencil className="w-3.5 h-3.5 mr-1" />{t('Redigera', 'Edit')}
                </Button>
                {selectedDevice.customer_id !== null && (
                  <Button size="sm" variant="outline" onClick={() => handlePromoteToGlobal(selectedDevice.id)}>
                    <ArrowUpFromLine className="w-3.5 h-3.5 mr-1" />{t('Gör global', 'Promote to Global')}
                  </Button>
                )}
                <Button size="sm" variant="destructive" onClick={() => handleDelete(selectedDevice.id)}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" />{t('Radera', 'Delete')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <DeviceInstanceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        customerId=""
        device={editingDevice as any}
        onSaved={() => { fetchDevices(); setSelectedDevice(null); }}
      />
    </div>
  );
};

export default GlobalDeviceManagerTab;
