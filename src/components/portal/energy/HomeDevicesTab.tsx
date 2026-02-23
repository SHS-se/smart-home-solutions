import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Trash2, Globe, User } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

import DeviceEditorForm, { DeviceType, DeviceRow } from './DeviceEditorForm';
import PerformanceDataStatus from './PerformanceDataStatus';
import AddDeviceModal from './AddDeviceModal';

interface AssignmentEntry {
  id: string;
  home_id: string;
  device_instance_id: string;
  quantity: number;
  device_instances: DeviceRow;
}

// A virtual row is a standard-home device not yet persisted as an assignment
interface DisplayRow {
  assignmentId: string | null; // null = virtual
  deviceInstanceId: string;
  device: DeviceRow;
  quantity: number;
  isVirtual: boolean;
}

interface HomeDevicesTabProps {
  customerId: string;
  homeId: string | null;
}

const HomeDevicesTab: React.FC<HomeDevicesTabProps> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const { isStaff } = useAuth();
  const { toast } = useToast();

  const [assignments, setAssignments] = useState<AssignmentEntry[]>([]);
  const [standardDevices, setStandardDevices] = useState<DeviceRow[]>([]);
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>([]);
  const [allDevices, setAllDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);

  // Right panel state
  const [selected, setSelected] = useState<DeviceRow | null>(null);
  const [performanceDataDeviceId, setPerformanceDataDeviceId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const typesPromise = supabase.from('device_types').select('*').order('display_name');

    const assignPromise = homeId
      ? supabase.from('home_device_assignments')
          .select('id, home_id, device_instance_id, quantity, device_instances(id, name, customer_id, device_type_id, field_values, controllable, shiftable, priority, include_in_standard_home, performance_data_device_id, device_types(key, display_name, field_schema))')
          .eq('home_id', homeId)
      : null;

    const stdPromise = supabase.from('device_instances')
      .select('id, name, customer_id, device_type_id, field_values, controllable, shiftable, priority, include_in_standard_home, performance_data_device_id, device_types(key, display_name, field_schema)')
      .is('customer_id', null)
      .eq('include_in_standard_home', true);

    const allPromise = supabase.from('device_instances')
      .select('id, name, customer_id, device_type_id, field_values, controllable, shiftable, priority, include_in_standard_home, performance_data_device_id, device_types(key, display_name, field_schema)')
      .or(`customer_id.eq.${customerId},customer_id.is.null`)
      .order('name');

    const [typesResult, assignResult, stdResult, allResult] = await Promise.all([
      typesPromise,
      assignPromise,
      stdPromise,
      allPromise,
    ]);

    if (typesResult.data) {
      setDeviceTypes(typesResult.data.map((t: any) => ({ ...t, field_schema: t.field_schema as any, supported_profile_kinds: (t.supported_profile_kinds || []) as string[] })) as DeviceType[]);
    }

    if (assignResult?.data) setAssignments(assignResult.data as unknown as AssignmentEntry[]);
    else if (!homeId) setAssignments([]);

    if (stdResult.data) setStandardDevices(stdResult.data as unknown as DeviceRow[]);
    if (allResult.data) setAllDevices(allResult.data as unknown as DeviceRow[]);

    setLoading(false);
  }, [customerId, homeId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Build display rows: real assignments + virtual standard-home devices
  const assignedDeviceIds = new Set(assignments.map(a => a.device_instance_id));

  const displayRows: DisplayRow[] = [
    ...assignments.map(a => ({
      assignmentId: a.id,
      deviceInstanceId: a.device_instance_id,
      device: a.device_instances,
      quantity: a.quantity,
      isVirtual: false,
    })),
    ...standardDevices
      .filter(d => !assignedDeviceIds.has(d.id))
      .map(d => ({
        assignmentId: null,
        deviceInstanceId: d.id,
        device: d,
        quantity: 1,
        isVirtual: true,
      })),
  ];

  const excludedDeviceIds = new Set(displayRows.map(r => r.deviceInstanceId));

  const handleUpdateQuantity = async (row: DisplayRow, newQty: number) => {
    if (newQty < 1) return;
    if (!homeId) return;

    if (row.isVirtual) {
      // Persist the virtual assignment first
      const { error } = await supabase.from('home_device_assignments').insert({
        home_id: homeId, device_instance_id: row.deviceInstanceId, quantity: newQty,
      });
      if (error) toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      else fetchData();
    } else {
      const { error } = await supabase.from('home_device_assignments').update({ quantity: newQty }).eq('id', row.assignmentId!);
      if (error) toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      else fetchData();
    }
  };

  const handleRemoveAssignment = async (row: DisplayRow) => {
    if (row.isVirtual) {
      // Virtual row: nothing to delete, but we could persist a qty=0 record — for now just ignore
      toast({ title: t('Standardenhet', 'Standard device'), description: t('Denna enhet ingår automatiskt i standardhemmet.', 'This device is auto-included in the standard home.') });
      return;
    }
    const { error } = await supabase.from('home_device_assignments').delete().eq('id', row.assignmentId!);
    if (error) toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    else { toast({ title: t('Borttagen', 'Removed') }); fetchData(); }
  };

  const handleSelectRow = (row: DisplayRow) => {
    setSelected(row.device);
    setPerformanceDataDeviceId((row.device as any).performance_data_device_id || null);
  };

  const handleDeviceSaved = async (deviceId: string) => {
    // Auto-assign to home if not already assigned
    if (homeId && !assignedDeviceIds.has(deviceId)) {
      await supabase.from('home_device_assignments').insert({
        home_id: homeId, device_instance_id: deviceId, quantity: 1,
      });
    }
    fetchData();
  };

  const handleNewDevice = () => {
    setSelected(null);
    setPerformanceDataDeviceId(null);
  };

  const selectedDeviceType = selected ? deviceTypes.find(d => d.id === selected.device_type_id) : null;
  const showPerformancePanel = selected && (selectedDeviceType?.supported_profile_kinds?.length ?? 0) > 0;

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className={`grid grid-cols-1 ${showPerformancePanel ? 'lg:grid-cols-3' : 'lg:grid-cols-2'} gap-6`}>
      {/* LEFT: Devices in This Home */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">{t('Enheter i detta hem', 'Devices in This Home')}</h3>
          <div className="flex gap-2">
            {homeId && (
              <Button size="sm" variant="outline" onClick={() => setAddModalOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" />{t('Lägg till', 'Add Existing')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleNewDevice}>
              <Plus className="w-3.5 h-3.5 mr-1" />{t('Ny enhet', 'New Device')}
            </Button>
          </div>
        </div>

        {!homeId ? (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[200px] text-muted-foreground text-sm">
              {t('Välj ett hem för att se enheter.', 'Select a home to see devices.')}
            </CardContent>
          </Card>
        ) : displayRows.length === 0 ? (
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
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayRows.map(row => (
                    <TableRow
                      key={row.deviceInstanceId}
                      className={`cursor-pointer ${selected?.id === row.deviceInstanceId ? 'bg-muted' : ''}`}
                      onClick={() => handleSelectRow(row)}
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5">
                          {row.device.customer_id === null
                            ? <Globe className="w-3.5 h-3.5 text-primary shrink-0" />
                            : <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                          {row.device.name}
                          {row.isVirtual && <Badge variant="secondary" className="text-[10px] ml-1">{t('Standard', 'Standard')}</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{row.device.device_types?.display_name}</Badge>
                      </TableCell>
                      <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                        <Input
                          type="number"
                          min={1}
                          className="w-16 h-7 text-center text-sm"
                          value={row.quantity}
                          onChange={e => handleUpdateQuantity(row, Number(e.target.value) || 1)}
                        />
                      </TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleRemoveAssignment(row)}>
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

      {/* CENTER: Device Editor */}
      <DeviceEditorForm
        deviceTypes={deviceTypes}
        selected={selected}
        customerId={customerId}
        isStaff={isStaff}
        onSaved={handleDeviceSaved}
        onDeleted={() => { handleNewDevice(); fetchData(); }}
        onNewRequested={handleNewDevice}
      />

      {/* RIGHT: Performance Data Panel */}
      {showPerformancePanel && selected && selectedDeviceType && (
        <div className="space-y-4">
          <PerformanceDataStatus
            deviceId={selected.id}
            devices={allDevices.map(d => ({ id: d.id, name: d.name, device_type_id: d.device_type_id }))}
            currentDeviceTypeId={selected.device_type_id}
            performanceDataDeviceId={performanceDataDeviceId}
            supportedProfileKinds={selectedDeviceType.supported_profile_kinds}
            onPerformanceDeviceChange={async (id) => {
              setPerformanceDataDeviceId(id);
              await supabase.from('device_instances').update({ performance_data_device_id: id }).eq('id', selected.id);
            }}
          />
        </div>
      )}

      {/* Add Device Modal */}
      {homeId && (
        <AddDeviceModal
          open={addModalOpen}
          onOpenChange={setAddModalOpen}
          customerId={customerId}
          homeId={homeId}
          excludedDeviceIds={excludedDeviceIds}
          onAssigned={fetchData}
        />
      )}
    </div>
  );
};

export default HomeDevicesTab;
