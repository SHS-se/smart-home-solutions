import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Plus, Save, Trash2, Search, Globe, User, Upload, Download, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import PerformanceCurveChart from './PerformanceCurveChart';
import CurveUploadModal from './CurveUploadModal';
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

interface DeviceType {
  id: string;
  key: string;
  display_name: string;
  field_schema: { fields: FieldDef[] };
}

interface DeviceRow {
  id: string;
  name: string;
  customer_id: string | null;
  device_type_id: string;
  field_values: Record<string, any>;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
  device_types: {
    key: string;
    display_name: string;
    field_schema: { fields: FieldDef[] };
  } | null;
}

interface DeviceProfile {
  id: string;
  device_id: string;
  profile_kind: string;
  data: { points: Array<{ temp_c: number; cop: number; capacity_w: number }> };
  source: string | null;
  notes: string | null;
  updated_at: string;
}

type ScopeFilter = 'all' | 'global' | 'customer';

// Group schema fields into sections
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

const DeviceCatalogTab: React.FC = () => {
  const { t } = useLanguage();
  const { user, isStaff } = useAuth();
  const { toast } = useToast();

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  // Selected device
  const [selected, setSelected] = useState<DeviceRow | null>(null);
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  // Form state
  const [form, setForm] = useState({
    device_type_id: '',
    name: '',
    controllable: false,
    shiftable: false,
    priority: 0,
    field_values: {} as Record<string, any>,
  });

  // Upload modal
  const [uploadOpen, setUploadOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [{ data: devs }, { data: types }] = await Promise.all([
      supabase.from('device_instances').select('id, name, customer_id, device_type_id, field_values, controllable, shiftable, priority, device_types(key, display_name, field_schema)').order('name'),
      supabase.from('device_types').select('*').order('display_name'),
    ]);
    if (devs) setDevices(devs as unknown as DeviceRow[]);
    if (types) setDeviceTypes(types.map(t => ({ ...t, field_schema: t.field_schema as any })) as DeviceType[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchProfile = useCallback(async (deviceId: string) => {
    setProfileLoading(true);
    const { data } = await supabase.from('device_profiles').select('*').eq('device_id', deviceId).maybeSingle();
    setProfile(data as unknown as DeviceProfile | null);
    setProfileLoading(false);
  }, []);

  const handleSelect = (dev: DeviceRow) => {
    setSelected(dev);
    setForm({
      device_type_id: dev.device_type_id,
      name: dev.name,
      controllable: dev.controllable,
      shiftable: dev.shiftable,
      priority: dev.priority,
      field_values: dev.field_values || {},
    });
    fetchProfile(dev.id);
  };

  const handleNew = () => {
    setSelected(null);
    setProfile(null);
    setForm({
      device_type_id: deviceTypes[0]?.id || '',
      name: '',
      controllable: false,
      shiftable: false,
      priority: 0,
      field_values: {},
    });
  };

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
        priority: form.priority,
      };

      if (selected) {
        const { error } = await supabase.from('device_instances').update(payload).eq('id', selected.id);
        if (error) throw error;
      } else {
        // New global device (customer_id = null)
        const { error } = await supabase.from('device_instances').insert({ ...payload, customer_id: null });
        if (error) throw error;
      }
      toast({ title: t('Sparat!', 'Saved!') });
      fetchData();
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
      setSelected(null);
      setProfile(null);
      handleNew();
      fetchData();
    }
  };

  const handleClearCurve = async () => {
    if (!profile) return;
    const { error } = await supabase.from('device_profiles').delete().eq('id', profile.id);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('Kurva borttagen', 'Curve cleared') });
      setProfile(null);
    }
  };

  // Filters
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

  const selectedType = deviceTypes.find(dt => dt.id === form.device_type_id) || null;
  const schema = selectedType?.field_schema?.fields || [];
  const grouped = groupFields(schema);

  // Build chart data from profile
  const chartData = profile?.data?.points?.map(p => ({
    temp_c: p.temp_c,
    cop: p.cop,
    capacity_kw: p.capacity_w / 1000,
  }));

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

          {/* Scope filter */}
          <div className="flex gap-1">
            {(['all', 'global', 'customer'] as ScopeFilter[]).map(s => (
              <Badge key={s} variant={scopeFilter === s ? 'default' : 'outline'} className="cursor-pointer text-xs" onClick={() => setScopeFilter(s)}>
                {s === 'all' ? t('Alla', 'All') : s === 'global' ? t('Globala', 'Global') : t('Kund', 'Customer')}
              </Badge>
            ))}
          </div>

          {/* Type filter chips */}
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

          {/* Device list */}
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
                    <p className="text-xs text-muted-foreground truncate">{d.field_values?.make} {d.field_values?.model}</p>
                  )}
                </div>
                <Badge variant="outline" className="text-xs shrink-0">{d.device_types?.display_name}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* CENTER: Edit Form */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{selected ? t('Redigera enhet', 'Edit Device') : t('Ny enhet', 'New Device')}</CardTitle>
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

          {/* Identification fields */}
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

          {/* Electrical fields */}
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

          {/* Performance fields */}
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

      {/* RIGHT: Profile Panel */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t('COP + Kapacitetskurva', 'COP + Capacity Curve')}</CardTitle>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('Välj en enhet', 'Select a device')}</p>
            ) : profileLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
            ) : !profile ? (
              <div className="text-center py-8 space-y-3">
                <p className="text-sm text-muted-foreground">{t('Ingen kurva uppladdad', 'No curve uploaded')}</p>
                {isStaff && (
                  <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)}>
                    <Upload className="w-4 h-4 mr-2" />{t('Ladda upp kurva', 'Upload curve')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <PerformanceCurveChart
                  title="COP"
                  data={chartData?.map(p => ({ x: p.temp_c, y: p.cop })) || []}
                  xLabel="°C"
                  yLabel="COP"
                  height={180}
                  hideCard
                />
                <PerformanceCurveChart
                  title={t('Kapacitet', 'Capacity')}
                  data={chartData?.map(p => ({ x: p.temp_c, y: p.capacity_kw })) || []}
                  xLabel="°C"
                  yLabel="kW"
                  color="hsl(var(--destructive))"
                  height={180}
                  hideCard
                />

                {/* Metadata */}
                <div className="flex gap-4 text-xs text-muted-foreground">
                  {profile.source && <span>{t('Källa', 'Source')}: {profile.source}</span>}
                  <span>{t('Uppdaterad', 'Updated')}: {new Date(profile.updated_at).toLocaleDateString()}</span>
                </div>

                {/* Actions */}
                {isStaff && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)}>
                      {t('Ersätt kurva', 'Replace curve')}
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <X className="w-3.5 h-3.5 mr-1" />{t('Rensa', 'Clear')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('Rensa kurva?', 'Clear curve?')}</AlertDialogTitle>
                          <AlertDialogDescription>{t('Kurvdata raderas permanent.', 'Curve data will be permanently deleted.')}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
                          <AlertDialogAction onClick={handleClearCurve}>{t('Rensa', 'Clear')}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Upload Modal */}
      {selected && (
        <CurveUploadModal
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          deviceId={selected.id}
          existingProfileId={profile?.id || null}
          onSaved={() => fetchProfile(selected.id)}
        />
      )}
    </div>
  );
};

export default DeviceCatalogTab;
