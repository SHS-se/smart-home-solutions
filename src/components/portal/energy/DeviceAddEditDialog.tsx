import React, { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
  const [search, setSearch] = useState('');

  // Edit mode state
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [maxPowerOverride, setMaxPowerOverride] = useState<string>('');
  const [controllable, setControllable] = useState(false);
  const [shiftable, setShiftable] = useState(false);
  const [priority, setPriority] = useState(5);

  const isEditMode = !!device;

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
    if (open) {
      fetchTemplates();
      setSearch('');
    }
  }, [open]);

  useEffect(() => {
    if (device) {
      setName(device.name);
      setQuantity(device.quantity);
      setMaxPowerOverride(device.max_power_override_w ? String(device.max_power_override_w) : '');
      setControllable(device.controllable);
      setShiftable(device.shiftable);
      setPriority(device.priority);
    }
  }, [device, open]);

  const handleQuickAdd = async (tpl: DeviceTemplate) => {
    setSaving(true);
    try {
      const { error } = await supabase.from('energy_devices').insert({
        home_id: homeId,
        name: tpl.display_name,
        device_template_id: tpl.id,
        quantity: 1,
        controllable: tpl.controllable_default,
        shiftable: tpl.shiftable_default,
        priority: 5,
      });
      if (error) throw error;
      toast({ title: t('Tillagd!', 'Added!') });
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!device || !name.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('energy_devices').update({
        name: name.trim(),
        quantity,
        max_power_override_w: maxPowerOverride ? Number(maxPowerOverride) : null,
        controllable,
        shiftable,
        priority,
      }).eq('id', device.id);
      if (error) throw error;
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

  const selectedTemplate = isEditMode ? templates.find(t => t.id === device.device_template_id) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isEditMode ? 'max-w-md' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('Redigera enhet', 'Edit Device') : t('Lägg till enhet', 'Add Device')}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : isEditMode ? (
          /* Edit mode: full form */
          <div className="space-y-4">
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
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
              <Button onClick={handleSaveEdit} disabled={saving || !name.trim()}>
                {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {t('Spara', 'Save')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* Add mode: searchable template picker */
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder={t('Sök enhet...', 'Search device...')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="max-h-[400px] overflow-y-auto space-y-1">
              {filteredTemplates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">{t('Inga enheter hittades.', 'No devices found.')}</p>
              ) : (
                filteredTemplates.map(tpl => (
                  <button
                    key={tpl.id}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent text-left transition-colors disabled:opacity-50"
                    onClick={() => handleQuickAdd(tpl)}
                    disabled={saving}
                  >
                    <div>
                      <span className="text-sm font-medium">{tpl.make} {tpl.model}</span>
                      <span className="text-xs text-muted-foreground ml-2">{tpl.device_kind}</span>
                    </div>
                    <span className="text-sm text-muted-foreground">{formatPower(tpl.max_electrical_power_w).display}</span>
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

export default DeviceAddEditDialog;
