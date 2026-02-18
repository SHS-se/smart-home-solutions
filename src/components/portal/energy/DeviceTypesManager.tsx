import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Save, Trash2, GripVertical } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

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
  supported_profile_kinds: string[];
  simulation_model_key: string;
}

const PROFILE_KIND_OPTIONS = ['cop_curve', 'capacity_curve', 'load_curve'];

const DeviceTypesManager: React.FC = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [types, setTypes] = useState<DeviceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<DeviceType | null>(null);

  const [form, setForm] = useState({
    key: '',
    display_name: '',
    simulation_model_key: '',
    supported_profile_kinds: [] as string[],
    fields: [{ key: '', type: 'text' as 'text' | 'number', required: true, label: '' }],
  });

  const fetchTypes = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('device_types')
      .select('*')
      .order('display_name');
    if (data) {
      setTypes(data.map(d => ({
        ...d,
        field_schema: d.field_schema as any,
        supported_profile_kinds: d.supported_profile_kinds as any,
      })));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchTypes(); }, [fetchTypes]);

  const handleSelect = (dt: DeviceType) => {
    setSelected(dt);
    setForm({
      key: dt.key,
      display_name: dt.display_name,
      simulation_model_key: dt.simulation_model_key,
      supported_profile_kinds: dt.supported_profile_kinds,
      fields: dt.field_schema.fields.length > 0 ? dt.field_schema.fields : [{ key: '', type: 'text', required: true, label: '' }],
    });
  };

  const handleNew = () => {
    setSelected(null);
    setForm({
      key: '', display_name: '', simulation_model_key: '',
      supported_profile_kinds: [],
      fields: [{ key: '', type: 'text', required: true, label: '' }],
    });
  };

  const handleSave = async () => {
    if (!form.key.trim() || !form.display_name.trim() || !form.simulation_model_key.trim()) return;
    const validFields = form.fields.filter(f => f.key.trim() && f.label.trim());
    if (validFields.length === 0) return;

    setSaving(true);
    try {
      const payload = {
        key: form.key.trim(),
        display_name: form.display_name.trim(),
        simulation_model_key: form.simulation_model_key.trim(),
        supported_profile_kinds: form.supported_profile_kinds,
        field_schema: { fields: validFields },
      };

      if (selected) {
        const { error } = await supabase.from('device_types').update(payload).eq('id', selected.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('device_types').insert(payload);
        if (error) throw error;
      }
      toast({ title: t('Sparat!', 'Saved!') });
      fetchTypes();
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || !confirm(t('Ta bort denna enhetstyp?', 'Delete this device type?'))) return;
    const { error } = await supabase.from('device_types').delete().eq('id', selected.id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen!', 'Deleted!') });
      setSelected(null);
      handleNew();
      fetchTypes();
    }
  };

  const addField = () => {
    setForm(f => ({ ...f, fields: [...f.fields, { key: '', type: 'text', required: false, label: '' }] }));
  };

  const removeField = (idx: number) => {
    setForm(f => ({ ...f, fields: f.fields.filter((_, i) => i !== idx) }));
  };

  const updateField = (idx: number, patch: Partial<FieldDef>) => {
    setForm(f => ({
      ...f,
      fields: f.fields.map((field, i) => i === idx ? { ...field, ...patch } : field),
    }));
  };

  const toggleProfileKind = (kind: string) => {
    setForm(f => ({
      ...f,
      supported_profile_kinds: f.supported_profile_kinds.includes(kind)
        ? f.supported_profile_kinds.filter(k => k !== kind)
        : [...f.supported_profile_kinds, kind],
    }));
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* List */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('Enhetstyper', 'Device Types')}</CardTitle>
            <Button size="sm" variant="outline" onClick={handleNew}><Plus className="w-3.5 h-3.5 mr-1" />{t('Ny', 'New')}</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-1 max-h-[500px] overflow-y-auto">
          {types.map(dt => (
            <div
              key={dt.id}
              className={`p-2 rounded cursor-pointer flex items-center justify-between ${selected?.id === dt.id ? 'bg-muted' : 'hover:bg-muted/50'}`}
              onClick={() => handleSelect(dt)}
            >
              <div>
                <p className="text-sm font-medium">{dt.display_name}</p>
                <p className="text-xs text-muted-foreground">{dt.key}</p>
              </div>
              <Badge variant="outline" className="text-xs">{dt.field_schema.fields.length} {t('fält', 'fields')}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Form */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{selected ? t('Redigera typ', 'Edit Type') : t('Ny typ', 'New Type')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-sm">{t('Nyckel', 'Key')}</Label>
              <Input value={form.key} onChange={e => setForm(f => ({ ...f, key: e.target.value }))} placeholder="e.g. air_to_air_heat_pump" disabled={!!selected} />
            </div>
            <div>
              <Label className="text-sm">{t('Visningsnamn', 'Display Name')}</Label>
              <Input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
            </div>
          </div>
          <div>
            <Label className="text-sm">{t('Simuleringsmodell', 'Simulation Model Key')}</Label>
            <Input value={form.simulation_model_key} onChange={e => setForm(f => ({ ...f, simulation_model_key: e.target.value }))} placeholder="e.g. heat_pump_aa" />
          </div>

          <div>
            <Label className="text-sm">{t('Profiltyper', 'Supported Profile Kinds')}</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {PROFILE_KIND_OPTIONS.map(kind => (
                <Badge
                  key={kind}
                  variant={form.supported_profile_kinds.includes(kind) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => toggleProfileKind(kind)}
                >
                  {kind}
                </Badge>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm">{t('Fältschema', 'Field Schema')}</Label>
              <Button size="sm" variant="outline" onClick={addField}><Plus className="w-3 h-3 mr-1" />{t('Fält', 'Field')}</Button>
            </div>
            <div className="space-y-2">
              {form.fields.map((field, idx) => (
                <div key={idx} className="flex items-center gap-2 p-2 rounded border border-border">
                  <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    className="flex-1"
                    value={field.key}
                    onChange={e => updateField(idx, { key: e.target.value })}
                    placeholder={t('Nyckel', 'Key')}
                  />
                  <Input
                    className="flex-1"
                    value={field.label}
                    onChange={e => updateField(idx, { label: e.target.value })}
                    placeholder={t('Etikett', 'Label')}
                  />
                  <Select value={field.type} onValueChange={v => updateField(idx, { type: v as 'text' | 'number' })}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1">
                    <Switch checked={field.required} onCheckedChange={v => updateField(idx, { required: v })} />
                    <span className="text-xs text-muted-foreground">{t('Obligatoriskt', 'Required')}</span>
                  </div>
                  {form.fields.length > 1 && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeField(idx)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !form.key.trim() || !form.display_name.trim()} className="flex-1">
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
    </div>
  );
};

export default DeviceTypesManager;
