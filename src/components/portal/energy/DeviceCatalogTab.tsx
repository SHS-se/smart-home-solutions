import type { Json } from "@/integrations/supabase/types";
import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Search, Globe, User } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

import DeviceEditorForm, { DeviceType, DeviceRow } from './DeviceEditorForm';
import PerformanceDataStatus from './PerformanceDataStatus';

type ScopeFilter = 'all' | 'global' | 'customer';

const DeviceCatalogTab: React.FC = () => {
  const { t } = useLanguage();
  const { user, isStaff } = useAuth();

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [performanceDataDeviceId, setPerformanceDataDeviceId] = useState<string | null>(null);
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const [selected, setSelected] = useState<DeviceRow | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [{ data: devs }, { data: types }] = await Promise.all([
      supabase.from('device_instances').select('id, name, customer_id, device_type_id, field_values, controllable, shiftable, priority, performance_data_device_id, include_in_standard_home, device_types(key, display_name, field_schema)').order('name'),
      supabase.from('device_types').select('*').order('display_name'),
    ]);
    if (devs) setDevices(devs as unknown as DeviceRow[]);
    if (types) setDeviceTypes(types.map(t => ({ ...t, field_schema: t.field_schema as Json, supported_profile_kinds: (t.supported_profile_kinds || []) as string[] })) as unknown as DeviceType[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSelect = (dev: DeviceRow) => {
    setSelected(dev);
    setPerformanceDataDeviceId((dev as { performance_data_device_id?: string }).performance_data_device_id || null);
  };

  const handleNew = () => {
    setSelected(null);
    setPerformanceDataDeviceId(null);
  };

  const filtered = devices.filter(d => {
    if (scopeFilter === 'global' && d.customer_id !== null) return false;
    if (scopeFilter === 'customer' && d.customer_id === null) return false;
    if (typeFilter && d.device_type_id !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.name.toLowerCase().includes(q) ||
        (d.field_values?.make as string)?.toLowerCase().includes(q) ||
        (d.field_values?.model as string)?.toLowerCase().includes(q);
    }
    return true;
  });

  const selectedDeviceType = selected ? deviceTypes.find(d => d.id === selected.device_type_id) : null;
  const showPerformancePanel = selected && (selectedDeviceType?.supported_profile_kinds?.length ?? 0) > 0;

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className={`grid grid-cols-1 ${showPerformancePanel ? 'lg:grid-cols-3' : 'lg:grid-cols-2'} gap-6`}>
      {/* LEFT: Device List */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('Enheter', 'Devices')}</CardTitle>
            {isStaff && (
              <Button size="sm" variant="outline" onClick={handleNew}>
                <Plus className="w-3.5 h-3.5 mr-1" />{t('Ny global', 'New Global')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Sök...', 'Search...')} className="pl-9 h-8 text-sm" />
          </div>

          <div className="flex gap-1">
            {(['all', 'global', 'customer'] as ScopeFilter[]).map(s => (
              <Badge key={s} variant={scopeFilter === s ? 'default' : 'outline'} className="cursor-pointer text-xs" onClick={() => setScopeFilter(s)}>
                {s === 'all' ? t('Alla', 'All') : s === 'global' ? t('Globala', 'Global') : t('Kund', 'Customer')}
              </Badge>
            ))}
          </div>

          <div className="flex gap-1 flex-wrap">
            <Badge variant={typeFilter === null ? 'default' : 'outline'} className="cursor-pointer text-xs" onClick={() => setTypeFilter(null)}>
              {t('Alla typer', 'All Types')}
            </Badge>
            {deviceTypes.map(dt => (
              <Badge key={dt.id} variant={typeFilter === dt.id ? 'default' : 'outline'} className="cursor-pointer text-xs" onClick={() => setTypeFilter(dt.id)}>
                {dt.display_name}
              </Badge>
            ))}
          </div>

          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('Inga enheter hittades.', 'No devices found.')}</p>
            ) : filtered.map(d => (
              <div
                key={d.id}
                className={`p-2 rounded cursor-pointer flex items-center gap-2 ${selected?.id === d.id ? 'bg-muted' : 'hover:bg-muted/50'}`}
                onClick={() => handleSelect(d)}
              >
                {d.customer_id === null ? <Globe className="w-3.5 h-3.5 text-primary shrink-0" /> : <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{d.name}</p>
                  {(d.field_values?.make || d.field_values?.model) && (
                    <p className="text-xs text-muted-foreground truncate">{d.field_values?.make as string} {d.field_values?.model as string}</p>
                  )}
                </div>
                <Badge variant="outline" className="text-xs shrink-0">{d.device_types?.display_name}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* CENTER: Edit Form */}
      <DeviceEditorForm
        deviceTypes={deviceTypes}
        selected={selected}
        customerId={null}
        isStaff={isStaff}
        onSaved={() => fetchData()}
        onDeleted={() => { handleNew(); fetchData(); }}
        onNewRequested={handleNew}
      />

      {/* RIGHT: Performance Data Panel */}
      {showPerformancePanel && selected && selectedDeviceType && (
        <div className="space-y-4">
          <PerformanceDataStatus
            deviceId={selected.id}
            devices={devices.map(d => ({ id: d.id, name: d.name, device_type_id: d.device_type_id }))}
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
    </div>
  );
};

export default DeviceCatalogTab;
