import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';

interface DeviceTemplate {
  id: string;
  display_name: string;
  make: string;
  model: string;
  device_kind: string;
  max_electrical_power_w: number;
  controllable_default: boolean;
  shiftable_default: boolean;
  scop: number | null;
}

interface DeviceInstance {
  id: string;
  name: string;
  device_template_id: string;
  quantity: number;
  max_power_override_w: number | null;
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

const DeviceAddEditDialog: React.FC<Props> = ({ open, onOpenChange, homeId, device, onSaved }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<DeviceTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [maxPowerOverride, setMaxPowerOverride] = useState<string>('');
  const [controllable, setControllable] = useState(false);
  const [shiftable, setShiftable] = useState(false);
  const [priority, setPriority] = useState(5);

  useEffect(() => {
    const fetchTemplates = async () => {
      setLoading(true);
      const { data } = await supabase
        .from('device_templates')
        .select('id, display_name, make, model, device_kind, max_electrical_power_w, controllable_default, shiftable_default, scop')
        .eq('is_deleted', false)
        .order('device_kind')
        .order('display_name');
      if (data) setTemplates(data);
      setLoading(false);
    };
    if (open) fetchTemplates();
  }, [open]);

  useEffect(() => {
    if (device) {
      setName(device.name);
      setTemplateId(device.device_template_id);
      setQuantity(device.quantity);
      setMaxPowerOverride(device.max_power_override_w ? String(device.max_power_override_w) : '');
      setControllable(device.controllable);
      setShiftable(device.shiftable);
      setPriority(device.priority);
    } else {
      setName('');
      setTemplateId('');
      setQuantity(1);
      setMaxPowerOverride('');
      setControllable(false);
      setShiftable(false);
      setPriority(5);
    }
  }, [device, open]);

  const handleTemplateChange = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find(t => t.id === id);
    if (tpl && !device) {
      setName(tpl.display_name);
      setControllable(tpl.controllable_default);
      setShiftable(tpl.shiftable_default);
    }
  };

  const selectedTemplate = templates.find(t => t.id === templateId);

  const handleSave = async () => {
    if (!templateId || !name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        home_id: homeId,
        name: name.trim(),
        device_template_id: templateId,
        quantity,
        max_power_override_w: maxPowerOverride ? Number(maxPowerOverride) : null,
        controllable,
        shiftable,
        priority,
      };

      if (device) {
        const { error } = await supabase.from('energy_devices').update(payload).eq('id', device.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('energy_devices').insert(payload);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{device ? t('Redigera enhet', 'Edit Device') : t('Lägg till enhet', 'Add Device')}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>{t('Mall', 'Template')}</Label>
              <Select value={templateId} onValueChange={handleTemplateChange}>
                <SelectTrigger>
                  <SelectValue placeholder={t('Välj mall...', 'Select template...')} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map(tpl => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.make} {tpl.model} ({formatPower(tpl.max_electrical_power_w).display})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('Namn', 'Name')}</Label>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </div>
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
            <div>
              <Label>{t('Max effekt överskr. (W)', 'Max Power Override (W)')}</Label>
              <Input
                type="number"
                value={maxPowerOverride}
                onChange={e => setMaxPowerOverride(e.target.value)}
                placeholder={selectedTemplate ? formatPower(selectedTemplate.max_electrical_power_w).display : '—'}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('Styrbar', 'Controllable')}</Label>
              <Switch checked={controllable} onCheckedChange={setControllable} />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('Förskjutbar', 'Shiftable')}</Label>
              <Switch checked={shiftable} onCheckedChange={setShiftable} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || !templateId || !name.trim()}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {t('Spara', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeviceAddEditDialog;
