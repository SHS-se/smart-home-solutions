import React, { useEffect, useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface FieldDef {
  key: string;
  type: 'text' | 'number';
  required: boolean;
  label: string;
}

export interface DeviceType {
  id: string;
  key: string;
  display_name: string;
  field_schema: { fields: FieldDef[] };
  supported_profile_kinds: string[];
}

export interface DeviceRow {
  id: string;
  name: string;
  customer_id: string | null;
  device_type_id: string;
  field_values: Record<string, any>;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
  include_in_standard_home?: boolean;
  device_types: {
    key: string;
    display_name: string;
    field_schema: { fields: FieldDef[] };
  } | null;
}

export interface DeviceEditorFormProps {
  deviceTypes: DeviceType[];
  selected: DeviceRow | null;
  customerId: string | null;
  isStaff: boolean;
  onSaved: (deviceId: string) => void;
  onDeleted?: () => void;
  onNewRequested?: () => void;
}

function groupFields(fields: FieldDef[]) {
  const identification: FieldDef[] = [];
  const electrical: FieldDef[] = [];
  const performance: FieldDef[] = [];
  for (const f of fields) {
    if (['make', 'model'].includes(f.key)) identification.push(f);
    else if (f.key.includes('power') || f.key.includes('input_power')) electrical.push(f);
    else performance.push(f);
  }
  return { identification, electrical, performance };
}

const DeviceEditorForm: React.FC<DeviceEditorFormProps> = ({
  deviceTypes,
  selected,
  customerId,
  isStaff,
  onSaved,
  onDeleted,
  onNewRequested,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    device_type_id: '',
    name: '',
    controllable: false,
    shiftable: false,
    include_in_standard_home: false,
    priority: 0,
    field_values: {} as Record<string, any>,
  });

  // Sync form when selected changes
  useEffect(() => {
    if (selected) {
      setForm({
        device_type_id: selected.device_type_id,
        name: selected.name,
        controllable: selected.controllable,
        shiftable: selected.shiftable,
        include_in_standard_home: selected.include_in_standard_home ?? false,
        priority: selected.priority,
        field_values: selected.field_values || {},
      });
    } else {
      setForm({
        device_type_id: deviceTypes[0]?.id || '',
        name: '',
        controllable: false,
        shiftable: false,
        include_in_standard_home: false,
        priority: 0,
        field_values: {},
      });
    }
  }, [selected, deviceTypes]);

  const handleSave = async () => {
    if (!form.device_type_id || !form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        device_type_id: form.device_type_id,
        name: form.name.trim(),
        field_values: form.field_values,
        controllable: form.controllable,
        shiftable: form.shiftable,
        include_in_standard_home: form.include_in_standard_home,
        priority: form.priority,
      };

      if (selected && (isStaff || selected.customer_id === customerId)) {
        // Edit existing device in place (staff can edit any, customer can edit own)
        const { error } = await supabase.from('device_instances').update(payload).eq('id', selected.id);
        if (error) throw error;
        onSaved(selected.id);
      } else {
        // New device OR customer viewing a global device → create new customer device
        const { data, error } = await supabase.from('device_instances').insert({ ...payload, customer_id: customerId }).select('id').single();
        if (error) throw error;
        onSaved(data.id);
      }
      toast({ title: t('Sparat!', 'Saved!') });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    const { error } = await supabase.from('device_instances').delete().eq('id', selected.id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen!', 'Deleted!') });
      onDeleted?.();
    }
  };

  const selectedType = deviceTypes.find(dt => dt.id === form.device_type_id) || null;
  const schema = selectedType?.field_schema?.fields || [];
  const grouped = groupFields(schema);

  // Show "include in standard home" toggle only for global devices (staff only)
  const showStandardHomeToggle = isStaff && (!selected || selected.customer_id === null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {selected ? t('Redigera enhet', 'Edit Device') : t('Ny enhet', 'New Device')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-sm">{t('Enhetstyp', 'Device Type')}</Label>
          <Select value={form.device_type_id} onValueChange={v => setForm(f => ({ ...f, device_type_id: v, field_values: {} }))}>
            <SelectTrigger><SelectValue placeholder={t('Välj typ...', 'Select type...')} /></SelectTrigger>
            <SelectContent>
              {deviceTypes.map(dt => <SelectItem key={dt.id} value={dt.id}>{dt.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-sm">{t('Namn', 'Name')}</Label>
          <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </div>

        {grouped.identification.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Identifiering', 'Identification')}</p>
            {grouped.identification.map(field => (
              <div key={field.key}>
                <Label className="text-xs">{field.label}{field.required && <span className="text-destructive ml-0.5">*</span>}</Label>
                <Input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={form.field_values[field.key] ?? ''}
                  onChange={e => {
                    const val = field.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value || undefined;
                    setForm(f => ({ ...f, field_values: { ...f.field_values, [field.key]: val } }));
                  }}
                  placeholder="—"
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </div>
        )}

        {grouped.electrical.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Elektriska gränser', 'Electrical Limits')}</p>
            {grouped.electrical.map(field => (
              <div key={field.key}>
                <Label className="text-xs">{field.label}{field.required && <span className="text-destructive ml-0.5">*</span>}</Label>
                <Input
                  type="number"
                  value={form.field_values[field.key] ?? ''}
                  onChange={e => setForm(f => ({ ...f, field_values: { ...f.field_values, [field.key]: e.target.value === '' ? undefined : Number(e.target.value) } }))}
                  placeholder="—"
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </div>
        )}

        {grouped.performance.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('Prestanda', 'Performance')}</p>
            {grouped.performance.map(field => (
              <div key={field.key}>
                <Label className="text-xs">{field.label}{field.required && <span className="text-destructive ml-0.5">*</span>}</Label>
                <Input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={form.field_values[field.key] ?? ''}
                  onChange={e => {
                    const val = field.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value || undefined;
                    setForm(f => ({ ...f, field_values: { ...f.field_values, [field.key]: val } }));
                  }}
                  placeholder="—"
                  className="h-8 text-sm"
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('Styrbar', 'Controllable')}</Label>
          <Switch checked={form.controllable} onCheckedChange={v => setForm(f => ({ ...f, controllable: v }))} />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('Förskjutbar', 'Shiftable')}</Label>
          <Switch checked={form.shiftable} onCheckedChange={v => setForm(f => ({ ...f, shiftable: v }))} />
        </div>
        {showStandardHomeToggle && (
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('Inkludera i standardhem', 'Include in standard home')}</Label>
            <Switch checked={form.include_in_standard_home} onCheckedChange={v => setForm(f => ({ ...f, include_in_standard_home: v }))} />
          </div>
        )}
        <div>
          <Label className="text-sm">{t('Prioritet', 'Priority')}</Label>
          <Input type="number" min={0} max={10} value={form.priority} onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) || 0 }))} className="h-8 text-sm" />
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || !form.name.trim() || !form.device_type_id} className="flex-1">
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            <Save className="w-4 h-4 mr-2" />{t('Spara', 'Save')}
          </Button>
          {selected && isStaff && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="icon"><Trash2 className="w-4 h-4" /></Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('Radera enhet?', 'Delete device?')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('Alla hemtilldelningar tas också bort.', 'All home assignments will also be removed.')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>{t('Radera', 'Delete')}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default DeviceEditorForm;
