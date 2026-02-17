import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Loader2, Home, ChevronDown, ChevronUp, Plus, Pencil, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import DeviceAddEditDialog from './DeviceAddEditDialog';

const ENERGY_SEMANTIC_KEYS = [
  'dwelling_type', 'year_built', 'heated_area_m2', 'occupants',
  'heating_types', 'hot_water_type', 'has_ev', 'ev_charger_power_kw',
  'annual_kwh', 'annual_peak_kw', 'contract_type', 'has_solar', 'has_battery',
];

const SEMANTIC_LABELS: Record<string, { sv: string; en: string }> = {
  dwelling_type: { sv: 'Bostadstyp', en: 'Dwelling Type' },
  year_built: { sv: 'Byggnadsår', en: 'Year Built' },
  heated_area_m2: { sv: 'Uppvärmd yta (m²)', en: 'Heated Area (m²)' },
  occupants: { sv: 'Antal boende', en: 'Occupants' },
  heating_types: { sv: 'Uppvärmningstyp', en: 'Heating Types' },
  hot_water_type: { sv: 'Varmvattentyp', en: 'Hot Water Type' },
  has_ev: { sv: 'Har elbil', en: 'Has EV' },
  ev_charger_power_kw: { sv: 'Laddareffekt', en: 'EV Charger Power' },
  annual_kwh: { sv: 'Årlig förbrukning (kWh)', en: 'Annual Consumption (kWh)' },
  annual_peak_kw: { sv: 'Toppeffekt', en: 'Peak Power' },
  contract_type: { sv: 'Elavtal', en: 'Electricity Contract' },
  has_solar: { sv: 'Solpaneler', en: 'Solar Panels' },
  has_battery: { sv: 'Batterilagring', en: 'Battery Storage' },
};

const BOOLEAN_KEYS = ['has_ev', 'has_solar', 'has_battery'];
const NUMBER_KEYS = ['year_built', 'heated_area_m2', 'occupants', 'ev_charger_power_kw', 'annual_kwh', 'annual_peak_kw'];
const READONLY_KEYS = ['heating_types']; // complex multi-select, keep read-only

function estimateUA(heatedArea: number, yearBuilt: number, dwellingType: string): number {
  let uFactor: number;
  if (yearBuilt < 1960) uFactor = 1.5;
  else if (yearBuilt < 1980) uFactor = 1.0;
  else if (yearBuilt < 2000) uFactor = 0.6;
  else uFactor = 0.4;
  let formFactor = 1.0;
  if (dwellingType === 'apartment') formFactor = 0.7;
  else if (dwellingType === 'terraced' || dwellingType === 'radhus') formFactor = 0.85;
  return heatedArea * uFactor * formFactor;
}

function estimateThermalClass(yearBuilt: number, dwellingType: string): string {
  if (dwellingType === 'apartment') return 'heavy';
  if (yearBuilt < 1960) return 'light';
  if (yearBuilt < 2000) return 'medium';
  return 'medium';
}

interface DeviceWithTemplate {
  id: string;
  name: string;
  device_template_id: string;
  quantity: number;
  max_power_override_w: number | null;
  controllable: boolean;
  shiftable: boolean;
  priority: number;
  device_templates: {
    display_name: string;
    make: string;
    model: string;
    device_kind: string;
    max_electrical_power_w: number;
  };
}

interface HouseSetupTabProps {
  customerId: string;
  homeId: string | null;
}

const HouseSetupTab: React.FC<HouseSetupTabProps> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [profileValues, setProfileValues] = useState<Record<string, unknown>>({});
  const [questionMap, setQuestionMap] = useState<Record<string, string>>({}); // semantic_key -> question_id
  const [profileOpen, setProfileOpen] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number | null>>({
    indoor_temp_c: null, comfort_band_c: null, ua_w_per_k: null,
    ev_charger_power_w: null, annual_kwh_override: null,
  });
  const [settings, setSettings] = useState<{ id: string; ua_w_per_k: number | null; thermal_capacity_class: string | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const [devices, setDevices] = useState<DeviceWithTemplate[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceWithTemplate | null>(null);

  useEffect(() => {
    if (!customerId) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const { data: questions } = await supabase
          .from('home_questions')
          .select('id, semantic_key, question_text, question_text_en, question_type')
          .in('semantic_key', ENERGY_SEMANTIC_KEYS);
        const answersQuery = homeId
          ? supabase.from('home_answers').select('question_id, answer_text, answer_value').eq('home_id', homeId)
          : supabase.from('home_answers').select('question_id, answer_text, answer_value').eq('customer_id', customerId);
        const { data: answers } = await answersQuery;
        const values: Record<string, unknown> = {};
        const qMap: Record<string, string> = {};
        if (questions && answers) {
          for (const q of questions) {
            if (!q.semantic_key) continue;
            qMap[q.semantic_key] = q.id;
            const answer = answers.find(a => a.question_id === q.id);
            if (answer) values[q.semantic_key] = answer.answer_value ?? answer.answer_text;
          }
        }
        setProfileValues(values);
        setQuestionMap(qMap);

        if (homeId) {
          let { data: existingSettings } = await supabase
            .from('energy_home_settings')
            .select('id, ua_w_per_k, thermal_capacity_class, overrides')
            .eq('home_id', homeId)
            .maybeSingle();
          if (!existingSettings) {
            const area = typeof values.heated_area_m2 === 'number' ? values.heated_area_m2 : 100;
            const year = typeof values.year_built === 'number' ? values.year_built : 1980;
            const dwelling = typeof values.dwelling_type === 'string' ? values.dwelling_type : 'house';
            const ua = estimateUA(area, year, dwelling);
            const thermalClass = estimateThermalClass(year, dwelling);
            const { data: newSettings } = await supabase
              .from('energy_home_settings')
              .insert({ customer_id: customerId, home_id: homeId, ua_w_per_k: ua, thermal_capacity_class: thermalClass, derived: { ua_w_per_k: ua, thermal_capacity_class: thermalClass } })
              .select('id, ua_w_per_k, thermal_capacity_class, overrides')
              .single();
            existingSettings = newSettings;
          }
          if (existingSettings) {
            setSettings({ id: existingSettings.id, ua_w_per_k: existingSettings.ua_w_per_k, thermal_capacity_class: existingSettings.thermal_capacity_class });
            const savedOverrides = existingSettings.overrides as Record<string, number | null> | null;
            if (savedOverrides && typeof savedOverrides === 'object') setOverrides(prev => ({ ...prev, ...savedOverrides }));
          }
        }
      } catch (err) {
        console.error('Error loading home setup:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [customerId, homeId]);

  const fetchDevices = useCallback(async () => {
    if (!homeId) { setDevices([]); return; }
    setDevicesLoading(true);
    const { data } = await supabase
      .from('energy_devices')
      .select('id, name, device_template_id, quantity, max_power_override_w, controllable, shiftable, priority, device_templates(display_name, make, model, device_kind, max_electrical_power_w)')
      .eq('home_id', homeId)
      .order('priority');
    if (data) setDevices(data as unknown as DeviceWithTemplate[]);
    setDevicesLoading(false);
  }, [homeId]);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  const handleDeleteDevice = async (deviceId: string) => {
    if (!confirm(t('Ta bort enhet?', 'Delete device?'))) return;
    await supabase.from('energy_devices').delete().eq('id', deviceId);
    fetchDevices();
  };

  const handleProfileValueChange = useCallback(async (key: string, newValue: unknown) => {
    setProfileValues(prev => ({ ...prev, [key]: newValue }));
    const questionId = questionMap[key];
    if (!questionId) return;
    try {
      const answerValue = newValue;
      const answerText = String(newValue ?? '');
      if (homeId) {
        // Use home_id scoped upsert
        const { data: existing } = await supabase
          .from('home_answers')
          .select('id')
          .eq('home_id', homeId)
          .eq('question_id', questionId)
          .maybeSingle();
        if (existing) {
          await supabase.from('home_answers').update({ answer_value: answerValue as any, answer_text: answerText }).eq('id', existing.id);
        } else {
          await supabase.from('home_answers').insert({ customer_id: customerId, home_id: homeId, question_id: questionId, answer_value: answerValue as any, answer_text: answerText });
        }
      } else {
        const { data: existing } = await supabase
          .from('home_answers')
          .select('id')
          .eq('customer_id', customerId)
          .eq('question_id', questionId)
          .maybeSingle();
        if (existing) {
          await supabase.from('home_answers').update({ answer_value: answerValue as any, answer_text: answerText }).eq('id', existing.id);
        } else {
          await supabase.from('home_answers').insert({ customer_id: customerId, home_id: homeId || '', question_id: questionId, answer_value: answerValue as any, answer_text: answerText } as any);
        }
      }
    } catch (err) {
      console.error('Failed to sync profile value:', err);
    }
  }, [customerId, homeId, questionMap]);

  const effectiveUA = overrides.ua_w_per_k ?? settings?.ua_w_per_k ?? 200;

  const chartData = useMemo(() => {
    const points = [];
    for (let dt = 0; dt <= 40; dt += 2) points.push({ deltaT: dt, demand: effectiveUA * dt });
    return points;
  }, [effectiveUA]);

  const handleSaveOverrides = async () => {
    if (!settings?.id) return;
    setSaving(true);
    try {
      const { error } = await supabase.from('energy_home_settings').update({ overrides: overrides as any }).eq('id', settings.id);
      if (error) throw error;
      toast({ title: t('Sparat!', 'Saved!') });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const formatValue = (key: string, value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (key === 'ev_charger_power_kw' && typeof value === 'number') return formatPower(value * 1000).display;
    if (key === 'annual_peak_kw' && typeof value === 'number') return formatPower(value * 1000).display;
    if (typeof value === 'boolean') return value ? 'Ja / Yes' : 'Nej / No';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };

  const renderEditableField = (key: string, value: unknown) => {
    if (READONLY_KEYS.includes(key)) {
      return <span className="text-sm text-muted-foreground">{formatValue(key, value)}</span>;
    }
    if (BOOLEAN_KEYS.includes(key)) {
      return (
        <Switch
          checked={!!value}
          onCheckedChange={(checked) => handleProfileValueChange(key, checked)}
        />
      );
    }
    if (NUMBER_KEYS.includes(key)) {
      return (
        <Input
          type="number"
          className="w-28 h-8 text-sm text-right"
          value={value != null ? String(value) : ''}
          onChange={e => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            setProfileValues(prev => ({ ...prev, [key]: v }));
          }}
          onBlur={() => handleProfileValueChange(key, profileValues[key])}
          onKeyDown={e => { if (e.key === 'Enter') handleProfileValueChange(key, profileValues[key]); }}
        />
      );
    }
    // text fields
    return (
      <Input
        className="w-36 h-8 text-sm text-right"
        value={String(value ?? '')}
        onChange={e => setProfileValues(prev => ({ ...prev, [key]: e.target.value }))}
        onBlur={() => handleProfileValueChange(key, profileValues[key])}
        onKeyDown={e => { if (e.key === 'Enter') handleProfileValueChange(key, profileValues[key]); }}
      />
    );
  };

  if (!homeId) {
    return (
      <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
        <p>{t('Välj eller skapa ett hem för att komma igång.', 'Select or create a home to get started.')}</p>
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          {/* Home Profile - Collapsible */}
          <Collapsible open={profileOpen} onOpenChange={setProfileOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer">
                  <CardTitle className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Home className="w-5 h-5" />
                      {t('Hemprofil', 'Home Profile')}
                    </span>
                    {profileOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </CardTitle>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-4">
                  {ENERGY_SEMANTIC_KEYS.map(key => {
                    const value = profileValues[key];
                    if (value === undefined && !questionMap[key]) return null;
                    const label = SEMANTIC_LABELS[key];
                    return (
                      <div key={key} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                        <div>
                          <span className="text-sm font-medium">{t(label.sv, label.en)}</span>
                          <Badge variant="outline" className="ml-2 text-xs">{t('Källa: Hemprofil', 'Source: Home Profile')}</Badge>
                        </div>
                        {renderEditableField(key, value)}
                      </div>
                    );
                  })}
                  {settings && (
                    <>
                      <div className="flex items-center justify-between py-2 border-b border-border">
                        <div>
                          <span className="text-sm font-medium">UA (W/K)</span>
                          <Badge variant="secondary" className="ml-2 text-xs">{t('Beräknat', 'Computed')}</Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">{effectiveUA.toFixed(0)} W/K</span>
                      </div>
                      <div className="flex items-center justify-between py-2">
                        <div>
                          <span className="text-sm font-medium">{t('Termisk klass', 'Thermal Class')}</span>
                          <Badge variant="secondary" className="ml-2 text-xs">{t('Beräknat', 'Computed')}</Badge>
                        </div>
                        <span className="text-sm text-muted-foreground capitalize">{settings.thermal_capacity_class || '—'}</span>
                      </div>
                    </>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Overrides - Collapsible */}
          <Collapsible open={overridesOpen} onOpenChange={setOverridesOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer">
                  <CardTitle className="flex items-center justify-between text-base">
                    {t('Överskridanden', 'Overrides')}
                    {overridesOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </CardTitle>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-sm">{t('Inomhustemperatur (°C)', 'Indoor Temp (°C)')}</Label>
                      <Input type="number" value={overrides.indoor_temp_c ?? ''} onChange={e => setOverrides(prev => ({ ...prev, indoor_temp_c: e.target.value ? Number(e.target.value) : null }))} placeholder="21" />
                    </div>
                    <div>
                      <Label className="text-sm">{t('Komfortband (°C)', 'Comfort Band (°C)')}</Label>
                      <Input type="number" value={overrides.comfort_band_c ?? ''} onChange={e => setOverrides(prev => ({ ...prev, comfort_band_c: e.target.value ? Number(e.target.value) : null }))} placeholder="2" />
                    </div>
                    <div>
                      <Label className="text-sm">UA (W/K)</Label>
                      <Input type="number" value={overrides.ua_w_per_k ?? ''} onChange={e => setOverrides(prev => ({ ...prev, ua_w_per_k: e.target.value ? Number(e.target.value) : null }))} placeholder={String(settings?.ua_w_per_k?.toFixed(0) || '200')} />
                    </div>
                    <div>
                      <Label className="text-sm">{t('Årlig kWh (överskr.)', 'Annual kWh (override)')}</Label>
                      <Input type="number" value={overrides.annual_kwh_override ?? ''} onChange={e => setOverrides(prev => ({ ...prev, annual_kwh_override: e.target.value ? Number(e.target.value) : null }))} placeholder="—" />
                    </div>
                  </div>
                  <Button onClick={handleSaveOverrides} disabled={saving} size="sm">
                    {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                    {t('Spara överskridanden', 'Save Overrides')}
                  </Button>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>

        {/* Right: Heat Demand chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('Värmebehov vs ΔT', 'Heat Demand vs ΔT')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="deltaT" label={{ value: 'ΔT (°C)', position: 'insideBottom', offset: -5 }} className="text-xs" />
                <YAxis tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)} kW` : `${v} W`} label={{ value: t('Effekt', 'Power'), angle: -90, position: 'insideLeft' }} className="text-xs" />
                <Tooltip formatter={(value: number) => [formatPower(value).display, t('Värmebehov', 'Heat Demand')]} labelFormatter={v => `ΔT: ${v} °C`} />
                <Line type="monotone" dataKey="demand" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
            <p className="text-xs text-muted-foreground mt-2">
              UA = {effectiveUA.toFixed(0)} W/K · {t('Värmebehov = UA × ΔT', 'Heat Demand = UA × ΔT')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Devices assigned to this home */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('Enheter i detta hem', 'Devices in This Home')}</CardTitle>
            <Button size="sm" onClick={() => { setEditingDevice(null); setDialogOpen(true); }}>
              <Plus className="w-4 h-4 mr-1" /> {t('Lägg till', 'Add')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {devicesLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : devices.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm">
              {t('Inga enheter tillagda ännu. Lägg till från enhetskatalogen.', 'No devices added yet. Add from the device catalog.')}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Namn', 'Name')}</TableHead>
                  <TableHead>{t('Mall', 'Template')}</TableHead>
                  <TableHead className="text-right">{t('Effekt', 'Power')}</TableHead>
                  <TableHead className="text-center">{t('Antal', 'Qty')}</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map(d => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{d.device_templates.display_name}</TableCell>
                    <TableCell className="text-right">{formatPower(d.max_power_override_w ?? d.device_templates.max_electrical_power_w).display}</TableCell>
                    <TableCell className="text-center">{d.quantity}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditingDevice(d); setDialogOpen(true); }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteDevice(d.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {homeId && (
        <DeviceAddEditDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          homeId={homeId}
          device={editingDevice}
          onSaved={fetchDevices}
        />
      )}
    </div>
  );
};

export default HouseSetupTab;
