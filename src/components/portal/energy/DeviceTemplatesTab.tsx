import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import PerformanceCurveChart from './PerformanceCurveChart';

interface DeviceTemplate {
  id: string;
  name: string;
  category: string;
  device_type: string;
  make: string;
  model: string;
  display_name: string;
  device_kind: string;
  specs: Record<string, any>;
  max_electrical_power_w: number;
  controllable_default: boolean;
  shiftable_default: boolean;
  scop: number | null;
  min_operating_temp_c: number | null;
  is_deleted: boolean;
}

const DEVICE_KINDS = [
  'air_to_air_heat_pump', 'air_to_water_heat_pump', 'direct_electric_heater',
  'ev_charger', 'appliance', 'base_load', 'hot_water_heater',
];

const KIND_LABELS: Record<string, string> = {
  air_to_air_heat_pump: 'Air-Air Heat Pump',
  air_to_water_heat_pump: 'Air-Water Heat Pump',
  direct_electric_heater: 'Electric Heater',
  ev_charger: 'EV Charger',
  appliance: 'Appliance',
  base_load: 'Base Load',
  hot_water_heater: 'Hot Water Heater',
};

const DeviceTemplatesTab: React.FC = () => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<DeviceTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<DeviceTemplate | null>(null);

  const [form, setForm] = useState({
    make: '', model: '', display_name: '', device_kind: 'direct_electric_heater',
    max_electrical_power_w: 2000, controllable_default: false, shiftable_default: false,
    scop: '', min_operating_temp_c: '',
  });

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('device_templates')
      .select('*')
      .eq('is_deleted', false)
      .order('device_kind')
      .order('display_name');
    if (data) setTemplates(data as unknown as DeviceTemplate[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleSelect = (tpl: DeviceTemplate) => {
    setSelected(tpl);
    setForm({
      make: tpl.make, model: tpl.model, display_name: tpl.display_name,
      device_kind: tpl.device_kind, max_electrical_power_w: tpl.max_electrical_power_w,
      controllable_default: tpl.controllable_default, shiftable_default: tpl.shiftable_default,
      scop: tpl.scop ? String(tpl.scop) : '', min_operating_temp_c: tpl.min_operating_temp_c ? String(tpl.min_operating_temp_c) : '',
    });
  };

  const handleNew = () => {
    setSelected(null);
    setForm({
      make: '', model: '', display_name: '', device_kind: 'direct_electric_heater',
      max_electrical_power_w: 2000, controllable_default: false, shiftable_default: false,
      scop: '', min_operating_temp_c: '',
    });
  };

  const handleSave = async () => {
    if (!form.make.trim() || !form.model.trim()) return;
    setSaving(true);
    try {
      const derivedDisplayName = form.display_name.trim() || `${form.make.trim()} ${form.model.trim()}`;
      const payload = {
        make: form.make.trim(),
        model: form.model.trim(),
        display_name: derivedDisplayName,
        device_kind: form.device_kind,
        // Keep legacy fields in sync
        name: derivedDisplayName,
        category: form.device_kind.includes('heat_pump') ? 'heating' : form.device_kind === 'direct_electric_heater' ? 'heating' : form.device_kind === 'ev_charger' ? 'ev' : form.device_kind === 'base_load' ? 'base_load' : 'appliance',
        device_type: form.device_kind.includes('heat_pump') ? 'heat_pump_air_air' : form.device_kind === 'ev_charger' ? 'ev_charger' : form.device_kind === 'direct_electric_heater' ? 'resistive_heater' : form.device_kind,
        max_electrical_power_w: form.max_electrical_power_w,
        controllable_default: form.controllable_default,
        shiftable_default: form.shiftable_default,
        scop: form.scop ? Number(form.scop) : null,
        min_operating_temp_c: form.min_operating_temp_c ? Number(form.min_operating_temp_c) : null,
        created_by: user?.id || null,
      };

      if (selected) {
        const { error } = await supabase.from('device_templates').update(payload).eq('id', selected.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('device_templates').insert(payload);
        if (error) throw error;
      }
      toast({ title: t('Sparat!', 'Saved!') });
      fetchTemplates();
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || !confirm(t('Ta bort denna mall?', 'Delete this template?'))) return;
    const { error } = await supabase.from('device_templates').update({ is_deleted: true }).eq('id', selected.id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen!', 'Deleted!') });
      setSelected(null);
      handleNew();
      fetchTemplates();
    }
  };

  const copData = selected?.scop
    ? Array.from({ length: 13 }, (_, i) => {
        const temp = -20 + i * 5;
        const cop = Math.max(1, selected.scop! * (1 + (temp - 7) * 0.03));
        return { x: temp, y: parseFloat(cop.toFixed(2)) };
      })
    : null;

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('Mallar', 'Templates')}</CardTitle>
            <Button size="sm" variant="outline" onClick={handleNew}><Plus className="w-3.5 h-3.5 mr-1" />{t('Ny', 'New')}</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 max-h-[500px] overflow-y-auto">
          {templates.map(tpl => (
            <div
              key={tpl.id}
              className={`p-2 rounded cursor-pointer flex items-center justify-between ${selected?.id === tpl.id ? 'bg-muted' : 'hover:bg-muted/50'}`}
              onClick={() => handleSelect(tpl)}
            >
              <div>
                <p className="text-sm font-medium">{tpl.make} {tpl.model}</p>
                <p className="text-xs text-muted-foreground">{formatPower(tpl.max_electrical_power_w).display}</p>
              </div>
              <Badge variant="outline" className="text-xs">{KIND_LABELS[tpl.device_kind] || tpl.device_kind}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{selected ? t('Redigera mall', 'Edit Template') : t('Ny mall', 'New Template')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-sm">{t('Tillverkare', 'Make')}</Label>
              <Input value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
            </div>
            <div>
              <Label className="text-sm">{t('Modell', 'Model')}</Label>
              <Input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label className="text-sm">{t('Visningsnamn', 'Display Name')}</Label>
            <Input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} placeholder={`${form.make} ${form.model}`.trim() || '—'} />
          </div>
          <div>
            <Label className="text-sm">{t('Enhetstyp', 'Device Kind')}</Label>
            <Select value={form.device_kind} onValueChange={v => setForm(f => ({ ...f, device_kind: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {DEVICE_KINDS.map(dk => <SelectItem key={dk} value={dk}>{KIND_LABELS[dk] || dk}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-sm">{t('Max eleffekt (W)', 'Max Electrical Power (W)')}</Label>
            <Input type="number" value={form.max_electrical_power_w} onChange={e => setForm(f => ({ ...f, max_electrical_power_w: Number(e.target.value) || 0 }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-sm">SCOP</Label>
              <Input type="number" step="0.1" value={form.scop} onChange={e => setForm(f => ({ ...f, scop: e.target.value }))} placeholder="—" />
            </div>
            <div>
              <Label className="text-sm">{t('Min temp (°C)', 'Min Temp (°C)')}</Label>
              <Input type="number" value={form.min_operating_temp_c} onChange={e => setForm(f => ({ ...f, min_operating_temp_c: e.target.value }))} placeholder="—" />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('Styrbar standard', 'Controllable Default')}</Label>
            <Switch checked={form.controllable_default} onCheckedChange={v => setForm(f => ({ ...f, controllable_default: v }))} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('Förskjutbar standard', 'Shiftable Default')}</Label>
            <Switch checked={form.shiftable_default} onCheckedChange={v => setForm(f => ({ ...f, shiftable_default: v }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !form.make.trim() || !form.model.trim()} className="flex-1">
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              <Save className="w-4 h-4 mr-2" /> {t('Spara', 'Save')}
            </Button>
            {selected && (
              <Button variant="destructive" size="icon" onClick={handleDelete}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {copData ? (
          <PerformanceCurveChart title={t('COP vs Utomhustemp', 'COP vs Outdoor Temp')} data={copData} xLabel="°C" yLabel="COP" height={250} />
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[250px] text-muted-foreground text-sm">
              {t('Välj en värmepumpmall för COP-kurva', 'Select a heat pump template for COP curve')}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default DeviceTemplatesTab;
