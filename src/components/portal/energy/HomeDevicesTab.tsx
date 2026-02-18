import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Search, Plus, Trash2, Pencil, ArrowRight, Globe } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import DeviceInstanceDialog from './DeviceInstanceDialog';

interface DeviceInstanceEntry {
  id: string;
  name: string;
  customer_id: string | null;
  field_values: Record<string, any>;
  device_template_id: string;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
  device_templates: {
    display_name: string;
    device_kind: string;
    device_types: {
      key: string;
      display_name: string;
    } | null;
  };
}

interface AssignmentEntry {
  id: string;
  home_id: string;
  device_instance_id: string;
  quantity: number;
  device_instances: DeviceInstanceEntry;
}

interface HomeDevicesTabProps {
  customerId: string;
  homeId: string | null;
}

const HomeDevicesTab: React.FC<HomeDevicesTabProps> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [myDevices, setMyDevices] = useState<DeviceInstanceEntry[]>([]);
  const [assignments, setAssignments] = useState<AssignmentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceInstanceEntry | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Fetch customer's own + global device instances
    if (customerId) {
      const { data: instances } = await supabase
        .from('device_instances')
        .select('id, name, customer_id, field_values, device_template_id, controllable, shiftable, priority, device_templates(display_name, device_kind, device_types(key, display_name))')
        .or(`customer_id.eq.${customerId},customer_id.is.null`)
        .order('name');
      if (instances) setMyDevices(instances as unknown as DeviceInstanceEntry[]);
    }

    // Fetch assignments for selected home
    if (homeId) {
      const { data: assigns } = await supabase
        .from('home_device_assignments')
        .select('id, home_id, device_instance_id, quantity, device_instances(id, name, customer_id, field_values, device_template_id, controllable, shiftable, priority, device_templates(display_name, device_kind, device_types(key, display_name)))')
        .eq('home_id', homeId);
      if (assigns) setAssignments(assigns as unknown as AssignmentEntry[]);
    } else {
      setAssignments([]);
    }
    setLoading(false);
  }, [customerId, homeId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const assignedIds = new Set(assignments.map(a => a.device_instance_id));

  const filteredDevices = myDevices.filter(d => {
    if (!search) return true;
    const q = search.toLowerCase();
    return d.name.toLowerCase().includes(q) ||
      d.device_templates?.display_name?.toLowerCase().includes(q) ||
      d.device_templates?.device_types?.display_name?.toLowerCase().includes(q);
  });

  const handleAssignToHome = async (deviceInstanceId: string) => {
    if (!homeId) {
      toast({ title: t('Välj ett hem först', 'Select a home first'), variant: 'destructive' });
      return;
    }
    // Check if already assigned
    if (assignedIds.has(deviceInstanceId)) {
      // Increment quantity
      const existing = assignments.find(a => a.device_instance_id === deviceInstanceId);
      if (existing) {
        const { error } = await supabase
          .from('home_device_assignments')
          .update({ quantity: existing.quantity + 1 })
          .eq('id', existing.id);
        if (error) {
          toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
        } else {
          toast({ title: t('Antal ökat', 'Quantity increased') });
          fetchData();
        }
      }
      return;
    }
    const { error } = await supabase
      .from('home_device_assignments')
      .insert({ home_id: homeId, device_instance_id: deviceInstanceId, quantity: 1 });
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Tilldelad!', 'Assigned!') });
      fetchData();
    }
  };

  const handleUpdateQuantity = async (assignmentId: string, newQty: number) => {
    if (newQty < 1) return;
    const { error } = await supabase
      .from('home_device_assignments')
      .update({ quantity: newQty })
      .eq('id', assignmentId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      fetchData();
    }
  };

  const handleRemoveAssignment = async (assignmentId: string) => {
    const { error } = await supabase
      .from('home_device_assignments')
      .delete()
      .eq('id', assignmentId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen', 'Removed') });
      fetchData();
    }
  };

  const handleDeleteDevice = async (deviceId: string) => {
    if (!confirm(t('Ta bort enhet? Alla hemtilldelningar tas också bort.', 'Delete device? All home assignments will also be removed.'))) return;
    const { error } = await supabase.from('device_instances').delete().eq('id', deviceId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Borttagen', 'Deleted') });
      fetchData();
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: My Devices */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-medium">{t('Mina enheter', 'My Devices')}</h3>
          <Button size="sm" onClick={() => { setEditingDevice(null); setAddDialogOpen(true); }}>
            <Plus className="w-4 h-4 mr-1" />
            {t('Ny enhet', 'New Device')}
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Sök enheter...', 'Search devices...')} className="pl-9" />
        </div>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Namn', 'Name')}</TableHead>
                  <TableHead>{t('Typ', 'Type')}</TableHead>
                  <TableHead className="text-right">{t('Effekt', 'Power')}</TableHead>
                  <TableHead className="w-[120px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDevices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      {t('Inga enheter ännu. Skapa en ny enhet.', 'No devices yet. Create a new device.')}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredDevices.map(d => (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          {d.customer_id === null && <Globe className="w-3.5 h-3.5 text-primary shrink-0" />}
                          {d.name}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {d.device_templates?.device_types?.display_name || d.device_templates?.device_kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatPower(Number(d.field_values?.max_power_w) || 0).display}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingDevice(d); setAddDialogOpen(true); }}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          {homeId && (
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleAssignToHome(d.id)} title={t('Tilldela hem', 'Assign to home')}>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteDevice(d.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Right: Devices in This Home */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">{t('Enheter i detta hem', 'Devices in This Home')}</h3>
        {!homeId ? (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[200px] text-muted-foreground text-sm">
              {t('Välj ett hem för att se tilldelningar.', 'Select a home to see assignments.')}
            </CardContent>
          </Card>
        ) : assignments.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[200px] text-muted-foreground text-sm">
              {t('Inga enheter tilldelade detta hem ännu.', 'No devices assigned to this home yet.')}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Namn', 'Name')}</TableHead>
                    <TableHead>{t('Typ', 'Type')}</TableHead>
                    <TableHead className="text-center">{t('Antal', 'Qty')}</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.map(a => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.device_instances.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {a.device_instances.device_templates?.device_types?.display_name || a.device_instances.device_templates?.device_kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Input
                          type="number"
                          min={1}
                          className="w-16 h-7 text-center text-sm"
                          value={a.quantity}
                          onChange={e => handleUpdateQuantity(a.id, Number(e.target.value) || 1)}
                        />
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleRemoveAssignment(a.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      <DeviceInstanceDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        customerId={customerId}
        device={editingDevice as any}
        onSaved={fetchData}
      />
    </div>
  );
};

export default HomeDevicesTab;
