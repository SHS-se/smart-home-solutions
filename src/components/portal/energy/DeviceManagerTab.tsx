import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Pencil, Trash2, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import DeviceAddEditDialog from './DeviceAddEditDialog';
import PerformanceCurveChart from './PerformanceCurveChart';

const CATEGORY_LABELS: Record<string, { sv: string; en: string }> = {
  heating: { sv: 'Uppvärmning', en: 'Heating' },
  ev: { sv: 'Elbil', en: 'EV' },
  hot_water: { sv: 'Varmvatten', en: 'Hot Water' },
  appliance: { sv: 'Apparat', en: 'Appliance' },
  base_load: { sv: 'Baslast', en: 'Base Load' },
};

interface DeviceWithTemplate {
  id: string;
  name: string;
  device_template_id: string;
  quantity: number;
  max_power_override_w: number | null;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
  device_templates: {
    name: string;
    category: string;
    device_type: string;
    max_electrical_power_w: number;
    scop: number | null;
  };
}

interface DeviceManagerTabProps {
  customerId: string;
}

const DeviceManagerTab: React.FC<DeviceManagerTabProps> = ({ customerId }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [devices, setDevices] = useState<DeviceWithTemplate[]>([]);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceWithTemplate | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceWithTemplate | null>(null);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    try {
      // Get settings id
      let { data: settings } = await supabase
        .from('energy_home_settings')
        .select('id')
        .eq('customer_id', customerId)
        .maybeSingle();

      if (!settings) {
        // Create settings
        const { data: newSettings } = await supabase
          .from('energy_home_settings')
          .insert({ customer_id: customerId })
          .select('id')
          .single();
        settings = newSettings;
      }

      if (settings) {
        setSettingsId(settings.id);
        const { data } = await supabase
          .from('energy_devices')
          .select('id, name, device_template_id, quantity, max_power_override_w, controllable, shiftable, priority, device_templates(name, category, device_type, max_electrical_power_w, scop)')
          .eq('energy_home_settings_id', settings.id)
          .order('priority');
        if (data) setDevices(data as unknown as DeviceWithTemplate[]);
      }
    } catch (err) {
      console.error('Error fetching devices:', err);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  const handleDelete = async (deviceId: string) => {
    if (!confirm(t('Vill du ta bort denna enhet?', 'Delete this device?'))) return;
    const { error } = await supabase.from('energy_devices').delete().eq('id', deviceId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen!', 'Deleted!') });
      if (selectedDevice?.id === deviceId) setSelectedDevice(null);
      fetchDevices();
    }
  };

  const filteredDevices = devices.filter(d => {
    const matchSearch = !search || d.name.toLowerCase().includes(search.toLowerCase());
    const matchCategory = !categoryFilter || d.device_templates.category === categoryFilter;
    return matchSearch && matchCategory;
  });

  const categories = [...new Set(devices.map(d => d.device_templates.category))];

  // Generate COP curve for heat pump
  const copChartData = selectedDevice?.device_templates.scop
    ? Array.from({ length: 13 }, (_, i) => {
        const temp = -20 + i * 5;
        const baseCOP = selectedDevice.device_templates.scop!;
        const cop = Math.max(1, baseCOP * (1 + (temp - 7) * 0.03));
        return { x: temp, y: parseFloat(cop.toFixed(2)) };
      })
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left: device list */}
      <div className="lg:col-span-2 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('Sök enheter...', 'Search devices...')}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1">
            <Badge
              variant={categoryFilter === null ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => setCategoryFilter(null)}
            >
              {t('Alla', 'All')}
            </Badge>
            {categories.map(cat => (
              <Badge
                key={cat}
                variant={categoryFilter === cat ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => setCategoryFilter(cat === categoryFilter ? null : cat)}
              >
                {t(CATEGORY_LABELS[cat]?.sv || cat, CATEGORY_LABELS[cat]?.en || cat)}
              </Badge>
            ))}
          </div>
          <Button size="sm" onClick={() => { setEditingDevice(null); setDialogOpen(true); }}>
            <Plus className="w-4 h-4 mr-1" /> {t('Lägg till', 'Add')}
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Namn', 'Name')}</TableHead>
                  <TableHead>{t('Kategori', 'Category')}</TableHead>
                  <TableHead className="text-right">{t('Effekt', 'Power')}</TableHead>
                  <TableHead className="text-center">{t('Antal', 'Qty')}</TableHead>
                  <TableHead className="text-center">{t('Prio', 'Prio')}</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDevices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      {t('Inga enheter tillagda ännu.', 'No devices added yet.')}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredDevices.map(d => {
                    const power = d.max_power_override_w ?? d.device_templates.max_electrical_power_w;
                    return (
                      <TableRow
                        key={d.id}
                        className={`cursor-pointer ${selectedDevice?.id === d.id ? 'bg-muted/50' : ''}`}
                        onClick={() => setSelectedDevice(d)}
                      >
                        <TableCell className="font-medium">{d.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {t(CATEGORY_LABELS[d.device_templates.category]?.sv || d.device_templates.category, CATEGORY_LABELS[d.device_templates.category]?.en || d.device_templates.category)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{formatPower(power).display}</TableCell>
                        <TableCell className="text-center">{d.quantity}</TableCell>
                        <TableCell className="text-center">{d.priority}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => { e.stopPropagation(); setEditingDevice(d); setDialogOpen(true); }}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={e => { e.stopPropagation(); handleDelete(d.id); }}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Right: detail panel */}
      <div className="space-y-4">
        {selectedDevice ? (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{selectedDevice.name}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Typ', 'Type')}</span><span>{selectedDevice.device_templates.device_type}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Maxeffekt', 'Max Power')}</span><span>{formatPower(selectedDevice.max_power_override_w ?? selectedDevice.device_templates.max_electrical_power_w).display}</span></div>
                {selectedDevice.device_templates.scop && (
                  <div className="flex justify-between"><span className="text-muted-foreground">SCOP</span><span>{selectedDevice.device_templates.scop}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Styrbar', 'Controllable')}</span><span>{selectedDevice.controllable ? '✓' : '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Förskjutbar', 'Shiftable')}</span><span>{selectedDevice.shiftable ? '✓' : '—'}</span></div>
              </CardContent>
            </Card>

            {copChartData && (
              <PerformanceCurveChart
                title="COP vs Outdoor Temp"
                data={copChartData}
                xLabel="°C"
                yLabel="COP"
                height={200}
              />
            )}
          </>
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[200px] text-muted-foreground text-sm">
              {t('Välj en enhet för detaljer', 'Select a device for details')}
            </CardContent>
          </Card>
        )}
      </div>

      {settingsId && (
        <DeviceAddEditDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          settingsId={settingsId}
          device={editingDevice}
          onSaved={fetchDevices}
        />
      )}
    </div>
  );
};

export default DeviceManagerTab;
