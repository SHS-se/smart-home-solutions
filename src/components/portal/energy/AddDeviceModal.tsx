import React, { useEffect, useState } from 'react';
import { Search, Globe, User, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface DevicePickerRow {
  id: string;
  name: string;
  customer_id: string | null;
  field_values: Record<string, any>;
  device_types: { display_name: string } | null;
}

interface AddDeviceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  homeId: string;
  excludedDeviceIds: Set<string>;
  onAssigned: () => void;
}

const AddDeviceModal: React.FC<AddDeviceModalProps> = ({
  open,
  onOpenChange,
  customerId,
  homeId,
  excludedDeviceIds,
  onAssigned,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [devices, setDevices] = useState<DevicePickerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setSearch('');
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('device_instances')
        .select('id, name, customer_id, field_values, device_types(display_name)')
        .or(`customer_id.eq.${customerId},customer_id.is.null`)
        .order('name');
      setDevices((data as unknown as DevicePickerRow[]) || []);
      setLoading(false);
    })();
  }, [open, customerId]);

  const available = devices
    .filter(d => !excludedDeviceIds.has(d.id))
    .filter(d => {
      if (!search) return true;
      const q = search.toLowerCase();
      return d.name.toLowerCase().includes(q) || d.device_types?.display_name?.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      // Customer-owned first, global second
      if (a.customer_id !== null && b.customer_id === null) return -1;
      if (a.customer_id === null && b.customer_id !== null) return 1;
      return a.name.localeCompare(b.name);
    });

  const handlePick = async (deviceId: string) => {
    const { error } = await supabase.from('home_device_assignments').insert({ home_id: homeId, device_instance_id: deviceId, quantity: 1 });
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Tilldelad!', 'Assigned!') });
      onAssigned();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Lägg till befintlig enhet', 'Add Existing Device')}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Sök...', 'Search...')} className="pl-9 h-8 text-sm" />
        </div>
        <div className="space-y-1 max-h-[350px] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">{t('Inga tillgängliga enheter.', 'No available devices.')}</p>
          ) : available.map(d => (
            <div
              key={d.id}
              className="p-2 rounded cursor-pointer flex items-center gap-2 hover:bg-muted/50"
              onClick={() => handlePick(d.id)}
            >
              {d.customer_id === null
                ? <Globe className="w-3.5 h-3.5 text-primary shrink-0" />
                : <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{d.name}</p>
              </div>
              <Badge variant="outline" className="text-xs shrink-0">{d.device_types?.display_name}</Badge>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AddDeviceModal;
