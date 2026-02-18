import React, { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface FieldDef {
  key: string;
  type: 'text' | 'number';
  required: boolean;
  label: string;
}

interface TemplateWithType {
  id: string;
  display_name: string;
  make: string;
  model: string;
  device_kind: string;
  field_defaults: Record<string, any>;
  device_type_id: string;
  device_types: {
    key: string;
    display_name: string;
    field_schema: { fields: FieldDef[] };
  };
}

interface DeviceInstance {
  id: string;
  name: string;
  device_template_id: string;
  quantity: number;
  field_values: Record<string, any>;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  homeId: string;
  device?: DeviceInstance | null;
  onSaved: () => void;
}

const DeviceInstanceDialog: React.FC<Props> = ({ open, onOpenChange, homeId, device, onSaved }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<TemplateWithType[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateWithType | null>(null);

  // Instance form state
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});
  const [controllable, setControllable] = useState(false);
  const [shiftable, setShiftable] = useState(false);
  const [priority, setPriority] = useState(5);

  const isEditMode = !!device;

  useEffect(() => {
    const fetchTemplates = async () => {
      setLoading(true);
      const { data } = await supabase
        .from('device_templates')
        .select('id, display_name, make, model, device_kind, field_defaults, device_type_id, device_types(key, display_name, field_schema)')
        .eq('is_deleted', false)
        .order('device_kind')
        .order('display_name');
      if (data) setTemplates(data as unknown as TemplateWithType[]);
      setLoading(false);
    };
    if (open) {
      fetchTemplates();
      setSearch('');
      if (!isEditMode) {
        setSelectedTemplate(null);
      }
    }
  }, [open, isEditMode]);

  // Edit mode: populate form from device
  useEffect(() => {
    if (device && templates.length > 0) {
      setName(device.name);
      setQuantity(device.quantity);
      setFieldValues(device.field_values || {});
      setControllable(device.controllable);
      setShiftable(device.shiftable);
      setPriority(device.priority);
      const tpl = templates.find(t => t.id === device.device_template_id);
      if (tpl) setSelectedTemplate(tpl);
    }
  }, [device, templates]);

  const handleSelectTemplate = (tpl: TemplateWithType) => {
    setSelectedTemplate(tpl);
    setName(tpl.display_name);
    // Pre-fill with template defaults
    const defaults: Record<string, any> = { ...tpl.field_defaults };
    // Also pre-fill make/model from template if in schema
    const schema = tpl.device_types?.field_schema?.fields || [];
    for (const field of schema) {
      if (field.key === 'make' && !defaults.make) defaults.make = tpl.make;
      if (field.key === 'model' && !defaults.model) defaults.model = tpl.model;
    }
    setFieldValues(defaults);
    setQuantity(1);
    setPriority(5);
    setControllable(false);
    setShiftable(false);
  };

  const handleSave = async () => {
    if (!selectedTemplate || !name.trim()) return;
    
    // Validate required fields
    const schema = selectedTemplate.device_types?.field_schema?.fields || [];
    for (const field of schema) {
      if (field.required && (fieldValues[field.key] === undefined || fieldValues[field.key] === '')) {
        toast({ title: t('Fält saknas', 'Missing field'), description: field.label, variant: 'destructive' });
        return;
      }
    }

    setSaving(true);
    try {
      if (isEditMode && device) {
        const { error } = await supabase.from('device_instances').update({
          name: name.trim(),
          quantity,
          field_values: fieldValues,
          controllable,
          shiftable,
          priority,
        }).eq('id', device.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('device_instances').insert({
          home_id: homeId,
          device_template_id: selectedTemplate.id,
          name: name.trim(),
          quantity,
          field_values: fieldValues,
          controllable,
          shiftable,
          priority,
        });
        if (error) throw error;
      }
      toast({ title: t('Sparat!', 'Saved!') });
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const filteredTemplates = templates.filter(tpl => {
    if (!search) return true;
    const q = search.toLowerCase();
    return tpl.display_name.toLowerCase().includes(q) || tpl.make.toLowerCase().includes(q) || tpl.model.toLowerCase().includes(q) || tpl.device_kind.toLowerCase().includes(q);
  });

  const schema = selectedTemplate?.device_types?.field_schema?.fields || [];
  const showForm = isEditMode || selectedTemplate;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={showForm ? 'max-w-lg' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('Redigera enhet', 'Edit Device') : selectedTemplate ? t('Konfigurera enhet', 'Configure Device') : t('Välj enhetsmall', 'Select Template')}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : showForm ? (
          <div className="space-y-4">
            {selectedTemplate && (
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="secondary">{selectedTemplate.device_types?.display_name}</Badge>
                <span className="text-muted-foreground">{selectedTemplate.display_name}</span>
                {!isEditMode && (
                  <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={() => setSelectedTemplate(null)}>
                    {t('Byt mall', 'Change')}
                  </Button>
                )}
              </div>
            )}

            <div>
              <Label>{t('Namn', 'Name')}</Label>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </div>

            {/* Dynamic fields from type schema */}
            {schema.map(field => (
              <div key={field.key}>
                <Label>
                  {field.label}
                  {field.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <Input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={fieldValues[field.key] ?? ''}
                  onChange={e => {
                    const val = field.type === 'number'
                      ? (e.target.value === '' ? '' : Number(e.target.value))
                      : e.target.value;
                    setFieldValues(prev => ({ ...prev, [field.key]: val }));
                  }}
                />
              </div>
            ))}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{t('Antal', 'Quantity')}</Label>
                <Input type="number" min={1} value={quantity} onChange={e => setQuantity(Number(e.target.value) || 1)} />
              </div>
              <div>
                <Label>{t('Prioritet', 'Priority')}</Label>
                <Input type="number" min={1} max={10} value={priority} onChange={e => setPriority(Number(e.target.value) || 5)} />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label>{t('Styrbar', 'Controllable')}</Label>
              <Switch checked={controllable} onCheckedChange={setControllable} />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('Förskjutbar', 'Shiftable')}</Label>
              <Switch checked={shiftable} onCheckedChange={setShiftable} />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
              <Button onClick={handleSave} disabled={saving || !name.trim()}>
                {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {t('Spara', 'Save')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* Template picker */
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input className="pl-9" placeholder={t('Sök mall...', 'Search template...')} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="max-h-[400px] overflow-y-auto space-y-1">
              {filteredTemplates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">{t('Inga mallar hittades.', 'No templates found.')}</p>
              ) : (
                filteredTemplates.map(tpl => (
                  <button
                    key={tpl.id}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent text-left transition-colors"
                    onClick={() => handleSelectTemplate(tpl)}
                  >
                    <div>
                      <span className="text-sm font-medium">{tpl.make} {tpl.model}</span>
                      <Badge variant="outline" className="ml-2 text-xs">{tpl.device_types?.display_name || tpl.device_kind}</Badge>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DeviceInstanceDialog;
