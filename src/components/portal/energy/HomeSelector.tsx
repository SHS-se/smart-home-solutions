import React, { useEffect, useState, useCallback } from 'react';
import { Home, Plus, Pencil, Loader2 } from 'lucide-react';
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
  const [editingHomeId, setEditingHomeId] = useState<string | null>(null);

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
      const values = { name: newName.trim(), address_text: newAddress.trim() || null };
      const query = editingHomeId
        ? supabase.from('homes').update(values).eq('id', editingHomeId)
        : supabase.from('homes').insert({ customer_id: customerId, ...values });
      const { data, error } = await query.select('id, name, address_text').single();
      if (error) throw error;
      if (data) {
        setHomes(prev => {
          const next = editingHomeId ? prev.map(home => home.id === data.id ? data : home) : [...prev, data];
          onHomeCountChange?.(next.length);
          return next;
        });
        onHomeChange(data.id);
        toast({ title: editingHomeId ? t('Hem uppdaterat', 'Home updated') : t('Hem skapat!', 'Home created!') });
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
      {selectedHomeId && <Button size="icon" variant="ghost" className="h-11 w-11 shrink-0"
        aria-label={t('Redigera installationsadress', 'Edit installation address')} onClick={() => {
          const home = homes.find(home => home.id === selectedHomeId);
          if (!home) return;
          setEditingHomeId(home.id); setNewName(home.name); setNewAddress(home.address_text ?? ''); setCreateOpen(true);
        }}><Pencil className="h-4 w-4" /></Button>}
      <Button size="icon" variant="ghost" className="h-11 w-11 shrink-0" aria-label={t('Skapa hem', 'Create home')} onClick={() => {
        setEditingHomeId(null); setNewName(''); setNewAddress(''); setCreateOpen(true);
      }}>
        <Plus className="w-4 h-4" />
      </Button>
      <HomeDialog
        editing={editingHomeId !== null}
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

interface HomeDialogProps {
  editing: boolean;
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

const HomeDialog: React.FC<HomeDialogProps> = ({
  editing, open, onOpenChange, newName, setNewName, newAddress, setNewAddress, creating, onSave, t
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{editing ? t('Redigera hem', 'Edit home') : t('Skapa nytt hem', 'Create New Home')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label htmlFor="planner-home-name">{t('Namn', 'Name')}</Label>
          <Input id="planner-home-name" value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('t.ex. Sommarhus', 'e.g. Summer House')} />
        </div>
        <div>
          <Label htmlFor="planner-installation-address">{t('Installationsadress', 'Installation address')}</Label>
          <Input id="planner-installation-address" value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder={t('Gatuadress, postnummer, stad', 'Street, postcode, city')} />
          <p className="mt-2 text-sm text-muted-foreground">{t('Planeringens väder och plats utgår från denna adress.', 'Planning weather and location use this address.')}</p>
          <a href="https://www.openstreetmap.org/copyright" className="text-xs text-muted-foreground underline" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
        <Button onClick={onSave} disabled={creating || !newName.trim()}>
          {creating && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
          {editing ? t('Spara', 'Save') : t('Skapa', 'Create')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default HomeSelector;
