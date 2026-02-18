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

interface FieldDef {
  key: string;
  type: 'text' | 'number';
  required: boolean;
  label: string;
}

interface DeviceType {
  id: string;
  key: string;
  display_name: string;
  field_schema: { fields: FieldDef[] };
}

interface DeviceTemplate {
  id: string;
  name: string;
  display_name: string;
  device_kind: string;
  device_type_id: string;
  field_defaults: Record<string, any>;
  max_electrical_power_w: number;
  controllable_default: boolean;
  shiftable_default: boolean;
  scop: number | null;
  min_operating_temp_c: number | null;
  is_deleted: boolean;
  make: string;
  model: string;
  category: string;
  device_type: string;
  device_types: { key: string; display_name: string; field_schema: { fields: FieldDef[] } } | null;
}

const DeviceTemplatesTab: React.FC = () => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<DeviceTemplate[]>([]);
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<DeviceTemplate | null>(null);

  const [form, setForm] = useState({
    device_type_id: '',
    display_name: '',
    controllable_default: false,
    shiftable_default: false,
    field_defaults: {} as Record<string, any>,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [{ data: tpls }, { data: types }] = await Promise.all([
      supabase.from('device_templates').select('*, device_types(key, display_name, field_schema)').eq('is_deleted', false).order('display_name'),
      supabase.from('device_types').select('*').order('display_name'),
    ]);
    if (tpls) setTemplates(tpls as unknown as DeviceTemplate[]);
    if (types) setDeviceTypes(types.map(t => ({ ...t, field_schema: t.field_schema as any })) as DeviceType[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const selectedType = deviceTypes.find(dt => dt.id === form.device_type_id) || null;
  const schema = selectedType?.field_schema?.fields || [];

  const handleSelect = (tpl: DeviceTemplate) => {
    setSelected(tpl);
    setForm({
      device_type_id: tpl.device_type_id,
      display_name: tpl.display_name,
      controllable_default: tpl.controllable_default,
      shiftable_default: tpl.shiftable_default,
      field_defaults: tpl.field_defaults || {},
    });
  };

  const handleNew = () => {
    setSelected(null);
    setForm({
      device_type_id: deviceTypes[0]?.id || '',
      display_name: '',
      controllable_default: false,
      shiftable_default: false,
      field_defaults: {},
    });
  };

  const handleSave = async () => {
    if (!form.device_type_id || !form.display_name.trim()) return;
    setSaving(true);
    try {
      // Derive legacy fields from field_defaults
      const make = form.field_defaults.make || '';
      const model = form.field_defaults.model || '';
      const maxPower = form.field_defaults.max_power_w || 0;
      const scop = form.field_defaults.scop || null;
      const minTemp = form.field_defaults.min_temp_c || null;
      const typeObj = deviceTypes.find(dt => dt.id === form.device_type_id);

      const payload = {
        device_type_id: form.device_type_id,
        display_name: form.display_name.trim(),
        field_defaults: form.field_defaults,
        controllable_default: form.controllable_default,
        shiftable_default: form.shiftable_default,
        // Legacy fields kept in sync
        make: String(make),
        model: String(model),
        name: form.display_name.trim(),
        device_kind: typeObj?.key || '',
        category: typeObj?.key?.includes('heat_pump') ? 'heating' : typeObj?.key === 'direct_electric_heater' ? 'heating' : typeObj?.key === 'ev_charger' ? 'ev' : typeObj?.key === 'base_load' ? 'base_load' : 'appliance',
        device_type: typeObj?.key?.includes('heat_pump') ? 'heat_pump_air_air' : typeObj?.key === 'ev_charger' ? 'ev_charger' : typeObj?.key === 'direct_electric_heater' ? 'resistive_heater' : typeObj?.key || '',
        max_electrical_power_w: Number(maxPower) || 0,
        scop: scop ? Number(scop) : null,
        min_operating_temp_c: minTemp ? Number(minTemp) : null,
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
      fetchData();
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
      fetchData();
    }
  };

  const copData = (form.field_defaults.scop)
    ? Array.from({ length: 13 }, (_, i) => {
        const temp = -20 + i * 5;
        const cop = Math.max(1, Number(form.field_defaults.scop) * (1 + (temp - 7) * 0.03));
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
                <p className="text-sm font-medium">{tpl.display_name}</p>
                <p className="text-xs text-muted-foreground">{formatPower(tpl.max_electrical_power_w).display}</p>
              </div>
              <Badge variant="outline" className="text-xs">{tpl.device_types?.display_name || tpl.device_kind}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{selected ? t('Redigera mall', 'Edit Template') : t('Ny mall', 'New Template')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-sm">{t('Enhetstyp', 'Device Type')}</Label>
            <Select value={form.device_type_id} onValueChange={v => setForm(f => ({ ...f, device_type_id: v, field_defaults: {} }))} disabled={!!selected}>
              <SelectTrigger><SelectValue placeholder={t('Välj typ...', 'Select type...')} /></SelectTrigger>
              <SelectContent>
                {deviceTypes.map(dt => <SelectItem key={dt.id} value={dt.id}>{dt.display_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-sm">{t('Visningsnamn', 'Display Name')}</Label>
            <Input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
          </div>

          {/* Dynamic fields from type schema */}
          {schema.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground">{t('Standardvärden (valfria)', 'Default Values (optional)')}</Label>
              {schema.map(field => (
                <div key={field.key}>
                  <Label className="text-xs">{field.label}</Label>
                  <Input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={form.field_defaults[field.key] ?? ''}
                    onChange={e => {
                      const val = field.type === 'number'
                        ? (e.target.value === '' ? undefined : Number(e.target.value))
                        : e.target.value || undefined;
                      setForm(f => ({
                        ...f,
                        field_defaults: { ...f.field_defaults, [field.key]: val },
                      }));
                    }}
                    placeholder="—"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('Styrbar standard', 'Controllable Default')}</Label>
            <Switch checked={form.controllable_default} onCheckedChange={v => setForm(f => ({ ...f, controllable_default: v }))} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('Förskjutbar standard', 'Shiftable Default')}</Label>
            <Switch checked={form.shiftable_default} onCheckedChange={v => setForm(f => ({ ...f, shiftable_default: v }))} />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !form.display_name.trim() || !form.device_type_id} className="flex-1">
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
