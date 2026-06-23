import React, { useEffect, useState, useCallback } from 'react';
import { Home, Plus, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface HomeEntry {
  id: string;
  name: string;
  address_text: string | null;
}

interface HomeSelectorProps {
  customerId: string;
  selectedHomeId: string | null;
  onHomeChange: (homeId: string) => void;
  onHomeCountChange?: (count: number) => void;
}

const HomeSelector: React.FC<HomeSelectorProps> = ({ customerId, selectedHomeId, onHomeChange, onHomeCountChange }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [homes, setHomes] = useState<HomeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchHomes = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('homes')
      .select('id, name, address_text')
      .eq('customer_id', customerId)
      .order('created_at');
    if (data) {
      setHomes(data);
      onHomeCountChange?.(data.length);
      if (data.length > 0 && !selectedHomeId) {
        onHomeChange(data[0].id);
      }
    }
    setLoading(false);
  }, [customerId, selectedHomeId, onHomeChange, onHomeCountChange]);

  useEffect(() => { fetchHomes(); }, [fetchHomes]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from('homes')
        .insert({ customer_id: customerId, name: newName.trim(), address_text: newAddress.trim() || null })
        .select('id, name, address_text')
        .single();
      if (error) throw error;
      if (data) {
        setHomes(prev => {
          const next = [...prev, data];
          onHomeCountChange?.(next.length);
          return next;
        });
        onHomeChange(data.id);
        toast({ title: t('Hem skapat!', 'Home created!') });
      }
      setCreateOpen(false);
      setNewName('');
      setNewAddress('');
    } catch (err) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm text-muted-foreground">{t('Laddar hem...', 'Loading homes...')}</span></div>;
  }

  return (
    <div className="flex items-center gap-2">
      <Home className="w-4 h-4 text-muted-foreground" />
      <Select value={selectedHomeId || ''} onValueChange={onHomeChange}>
        <SelectTrigger className="w-[220px]">
          <SelectValue placeholder={t('Välj hem...', 'Select home...')} />
        </SelectTrigger>
        <SelectContent>
          {homes.map(h => (
            <SelectItem key={h.id} value={h.id}>
              {h.name}{h.address_text ? ` — ${h.address_text}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setCreateOpen(true)}>
        <Plus className="w-4 h-4" />
      </Button>
      <CreateHomeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        newName={newName}
        setNewName={setNewName}
        newAddress={newAddress}
        setNewAddress={setNewAddress}
        creating={creating}
        onSave={handleCreate}
        t={t}
      />
    </div>
  );
};

interface CreateHomeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  setNewName: (v: string) => void;
  newAddress: string;
  setNewAddress: (v: string) => void;
  creating: boolean;
  onSave: () => void;
  t: (sv: string, en: string) => string;
}

const CreateHomeDialog: React.FC<CreateHomeDialogProps> = ({
  open, onOpenChange, newName, setNewName, newAddress, setNewAddress, creating, onSave, t
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{t('Skapa nytt hem', 'Create New Home')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label>{t('Namn', 'Name')}</Label>
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('t.ex. Sommarhus', 'e.g. Summer House')} />
        </div>
        <div>
          <Label>{t('Adress (valfritt)', 'Address (optional)')}</Label>
          <Input value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder={t('Gatuadress, stad', 'Street, city')} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
        <Button onClick={onSave} disabled={creating || !newName.trim()}>
          {creating && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
          {t('Skapa', 'Create')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default HomeSelector;
