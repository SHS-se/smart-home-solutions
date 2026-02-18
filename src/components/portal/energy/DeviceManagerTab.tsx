import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { formatPower } from '@/lib/energy-units';
import PerformanceCurveChart from './PerformanceCurveChart';

const TYPE_LABELS: Record<string, { sv: string; en: string }> = {
  air_to_air_heat_pump: { sv: 'Luft-luft VP', en: 'Air-Air HP' },
  direct_electric_heater: { sv: 'Elradiator', en: 'Electric Heater' },
  ev_charger: { sv: 'Elbilsladdare', en: 'EV Charger' },
  appliance: { sv: 'Apparat', en: 'Appliance' },
  base_load: { sv: 'Baslast', en: 'Base Load' },
  hot_water_heater: { sv: 'Varmvatten', en: 'Hot Water' },
};

interface DeviceInstanceEntry {
  id: string;
  name: string;
  field_values: Record<string, any>;
  quantity: number;
  device_template_id: string;
  device_templates: {
    display_name: string;
    device_kind: string;
    device_types: {
      key: string;
      display_name: string;
    } | null;
  };
}

interface TemplateEntry {
  id: string;
  display_name: string;
  make: string;
  model: string;
  device_kind: string;
  max_electrical_power_w: number;
  scop: number | null;
  device_types: {
    key: string;
    display_name: string;
  } | null;
}

interface DeviceManagerTabProps {
  customerId: string;
  homeId: string | null;
}

const DeviceManagerTab: React.FC<DeviceManagerTabProps> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const [viewMode, setViewMode] = useState<'my' | 'all'>('my');
  const [myInstances, setMyInstances] = useState<DeviceInstanceEntry[]>([]);
  const [allTemplates, setAllTemplates] = useState<TemplateEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateEntry | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Fetch all templates
    const { data: templates } = await supabase
      .from('device_templates')
      .select('id, display_name, make, model, device_kind, max_electrical_power_w, scop, device_types(key, display_name)')
      .eq('is_deleted', false)
      .order('device_kind')
      .order('display_name');
    if (templates) setAllTemplates(templates as unknown as TemplateEntry[]);

    // Fetch my device instances
    const { data: homes } = await supabase
      .from('homes')
      .select('id')
      .eq('customer_id', customerId);
    if (homes && homes.length > 0) {
      const homeIds = homes.map(h => h.id);
      const { data: instances } = await supabase
        .from('device_instances')
        .select('id, name, field_values, quantity, device_template_id, device_templates(display_name, device_kind, device_types(key, display_name))')
        .in('home_id', homeIds);
      if (instances) setMyInstances(instances as unknown as DeviceInstanceEntry[]);
    }
    setLoading(false);
  }, [customerId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // In "my" mode show instances; in "all" mode show templates
  const myTemplateIds = new Set(myInstances.map(i => i.device_template_id));

  const displayTemplates = viewMode === 'my'
    ? allTemplates.filter(t => myTemplateIds.has(t.id))
    : allTemplates;

  const filteredTemplates = displayTemplates.filter(t => {
    const matchSearch = !search || `${t.make} ${t.model} ${t.display_name}`.toLowerCase().includes(search.toLowerCase());
    const matchKind = !kindFilter || t.device_kind === kindFilter;
    return matchSearch && matchKind;
  });

  const kinds = [...new Set(displayTemplates.map(t => t.device_kind))];

  const copData = selectedTemplate?.scop
    ? Array.from({ length: 13 }, (_, i) => {
        const temp = -20 + i * 5;
        const cop = Math.max(1, selectedTemplate.scop! * (1 + (temp - 7) * 0.03));
        return { x: temp, y: parseFloat(cop.toFixed(2)) };
      })
    : null;

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Sök enheter...', 'Search devices...')} className="pl-9" />
          </div>
          <div className="flex gap-1">
            <Badge variant={viewMode === 'my' ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setViewMode('my')}>
              {t('Mina', 'My Devices')}
            </Badge>
            <Badge variant={viewMode === 'all' ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setViewMode('all')}>
              {t('Alla', 'All Devices')}
            </Badge>
          </div>
          <div className="flex gap-1">
            <Badge variant={kindFilter === null ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setKindFilter(null)}>
              {t('Alla typer', 'All Types')}
            </Badge>
            {kinds.map(k => (
              <Badge key={k} variant={kindFilter === k ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setKindFilter(k === kindFilter ? null : k)}>
                {t(TYPE_LABELS[k]?.sv || k, TYPE_LABELS[k]?.en || k)}
              </Badge>
            ))}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Tillverkare', 'Make')}</TableHead>
                  <TableHead>{t('Modell', 'Model')}</TableHead>
                  <TableHead>{t('Typ', 'Type')}</TableHead>
                  <TableHead className="text-right">{t('Effekt', 'Power')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTemplates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      {viewMode === 'my'
                        ? t('Inga enheter tilldelade dina hem ännu. Lägg till via Heminställningar.', 'No devices assigned to your homes yet. Add via Home Setup.')
                        : t('Inga enheter hittades.', 'No devices found.')}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTemplates.map(tpl => (
                    <TableRow
                      key={tpl.id}
                      className={`cursor-pointer ${selectedTemplate?.id === tpl.id ? 'bg-muted/50' : ''}`}
                      onClick={() => setSelectedTemplate(tpl)}
                    >
                      <TableCell className="font-medium">{tpl.make}</TableCell>
                      <TableCell>{tpl.model}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {tpl.device_types?.display_name || t(TYPE_LABELS[tpl.device_kind]?.sv || tpl.device_kind, TYPE_LABELS[tpl.device_kind]?.en || tpl.device_kind)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatPower(tpl.max_electrical_power_w).display}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        {selectedTemplate ? (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{selectedTemplate.display_name}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Tillverkare', 'Make')}</span><span>{selectedTemplate.make}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Modell', 'Model')}</span><span>{selectedTemplate.model}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Typ', 'Type')}</span><span>{selectedTemplate.device_types?.display_name || t(TYPE_LABELS[selectedTemplate.device_kind]?.sv || selectedTemplate.device_kind, TYPE_LABELS[selectedTemplate.device_kind]?.en || selectedTemplate.device_kind)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Maxeffekt', 'Max Power')}</span><span>{formatPower(selectedTemplate.max_electrical_power_w).display}</span></div>
                {selectedTemplate.scop && <div className="flex justify-between"><span className="text-muted-foreground">SCOP</span><span>{selectedTemplate.scop}</span></div>}
              </CardContent>
            </Card>
            {copData && (
              <PerformanceCurveChart title="COP vs Outdoor Temp" data={copData} xLabel="°C" yLabel="COP" height={200} />
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
    </div>
  );
};

export default DeviceManagerTab;
