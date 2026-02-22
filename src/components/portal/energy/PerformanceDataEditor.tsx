import React, { useState, useCallback, useEffect } from 'react';
import { Loader2, Plus, Trash2, ArrowUpDown, Clipboard, Sparkles } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  type ProfileKind, type CurvePoint, type SurfacePoint, type ValidationResult,
  validateProfileData, EXAMPLE_CURVE, EXAMPLE_SURFACE,
} from '@/lib/performance-data';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  profileKind: ProfileKind;
  existingProfileId?: string | null;
  existingData?: { points: any[] } | null;
  existingSource?: string | null;
  existingNotes?: string | null;
  onSaved: () => void;
}

const isCurve = (kind: ProfileKind) => kind === 'cop_capacity_curve';

const PerformanceDataEditor: React.FC<Props> = ({
  open, onOpenChange, deviceId, profileKind,
  existingProfileId, existingData, existingSource, existingNotes, onSaved,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [source, setSource] = useState('manufacturer');
  const [notes, setNotes] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [points, setPoints] = useState<any[] | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({ valid: false, error: 'No data' });
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('table');
  const [surfaceIndoorTemp, setSurfaceIndoorTemp] = useState(20);

  // Init on open
  useEffect(() => {
    if (open) {
      if (existingData?.points?.length) {
        const sorted = isCurve(profileKind)
          ? [...existingData.points].sort((a, b) => a.temp_c - b.temp_c)
          : [...existingData.points].sort((a, b) => a.indoor_temp_c - b.indoor_temp_c || a.temp_c - b.temp_c);
        setPoints(sorted);
        setJsonText(JSON.stringify({ points: sorted }, null, 2));
        setValidation(validateProfileData(profileKind, { points: sorted }));
      } else {
        setPoints(null);
        setJsonText('');
        setValidation({ valid: false, error: 'No data' });
      }
      setSource(existingSource || 'manufacturer');
      setNotes(existingNotes || '');
      setActiveTab('table');
    }
  }, [open, existingData, existingSource, existingNotes, profileKind]);

  // Sync JSON → points
  const applyJson = useCallback((text: string) => {
    setJsonText(text);
    if (!text.trim()) { setPoints(null); setValidation({ valid: false, error: 'No data' }); return; }
    try {
      const parsed = JSON.parse(text);
      const result = validateProfileData(profileKind, parsed);
      if (result.valid) {
        setPoints(parsed.points);
      }
      setValidation(result);
    } catch {
      setValidation({ valid: false, error: 'Invalid JSON syntax' });
    }
  }, [profileKind]);

  // Sync points → JSON + validate
  const updatePoints = useCallback((newPoints: any[]) => {
    setPoints(newPoints);
    setJsonText(JSON.stringify({ points: newPoints }, null, 2));
    setValidation(validateProfileData(profileKind, { points: newPoints }));
  }, [profileKind]);

  // Table editing
  const updatePointField = (idx: number, field: string, value: string) => {
    if (!points) return;
    const newPoints = [...points];
    const num = value === '' ? undefined : Number(value);
    newPoints[idx] = { ...newPoints[idx], [field]: num };
    updatePoints(newPoints);
  };

  const addRow = () => {
    const empty = isCurve(profileKind)
      ? { temp_c: 0, cop: 0, capacity_w: 0 }
      : { indoor_temp_c: 20, temp_c: 0, capacity_w: 0, input_power_w: 0 };
    updatePoints([...(points || []), empty]);
  };

  const deleteRow = (idx: number) => {
    if (!points) return;
    updatePoints(points.filter((_, i) => i !== idx));
  };

  const sortByTemp = () => {
    if (!points) return;
    const sorted = isCurve(profileKind)
      ? [...points].sort((a, b) => a.temp_c - b.temp_c)
      : [...points].sort((a, b) => (a.indoor_temp_c - b.indoor_temp_c) || (a.temp_c - b.temp_c));
    updatePoints(sorted);
  };

  const pasteExample = () => {
    const example = isCurve(profileKind) ? EXAMPLE_CURVE : EXAMPLE_SURFACE;
    updatePoints([...example.points]);
  };

  const normalizeKwToW = () => {
    if (!points) return;
    const newPoints = points.map(p => {
      const updated = { ...p };
      if (updated.capacity_w < 100) updated.capacity_w = Math.round(updated.capacity_w * 1000);
      if ('input_power_w' in updated && updated.input_power_w < 100) updated.input_power_w = Math.round(updated.input_power_w * 1000);
      return updated;
    });
    updatePoints(newPoints);
  };

  // TSV paste handler
  const handleTablePaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const rows = text.trim().split('\n').map(r => r.split('\t').map(c => c.trim()));
    if (rows.length < 1) return;

    const newPoints: any[] = [];
    for (const row of rows) {
      const nums = row.map(v => {
        const n = Number(v);
        return isNaN(n) ? null : n;
      }).filter(v => v !== null);

      if (isCurve(profileKind) && nums.length >= 3) {
        newPoints.push({ temp_c: nums[0], cop: nums[1], capacity_w: Math.round(nums[2]) });
      } else if (!isCurve(profileKind) && nums.length >= 4) {
        newPoints.push({ indoor_temp_c: nums[0], temp_c: nums[1], capacity_w: Math.round(nums[2]), input_power_w: Math.round(nums[3]) });
      }
    }
    if (newPoints.length > 0) updatePoints(newPoints);
  };

  // Save
  const handleSave = async () => {
    if (!points || !validation.valid) return;
    setSaving(true);
    try {
      const { data: serverValidation, error: fnError } = await supabase.functions.invoke('validate-device-profile', {
        body: { profile_kind: profileKind, data: { points } },
      });
      if (fnError) throw fnError;
      if (!serverValidation.valid) {
        setValidation({ valid: false, error: serverValidation.error });
        setSaving(false);
        return;
      }

      if (existingProfileId) {
        const { error } = await supabase.from('device_profiles').update({
          data: { points } as any,
          source,
          notes: notes || null,
        }).eq('id', existingProfileId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('device_profiles').insert({
          device_id: deviceId,
          profile_kind: profileKind,
          mode: 'heating',
          data: { points } as any,
          source,
          notes: notes || null,
        });
        if (error) throw error;
      }

      toast({ title: t('Sparad!', 'Saved!') });
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // Chart data
  const curveChartData = isCurve(profileKind) && points
    ? points.filter(p => typeof p.temp_c === 'number').map(p => ({ temp_c: p.temp_c, cop: p.cop, capacity_kw: (p.capacity_w || 0) / 1000 }))
    : null;

  const surfaceIndoorTemps = !isCurve(profileKind) && points
    ? [...new Set(points.map((p: any) => p.indoor_temp_c))].filter(v => typeof v === 'number').sort((a, b) => a - b)
    : [];

  const surfaceChartData = !isCurve(profileKind) && points
    ? points
        .filter((p: any) => p.indoor_temp_c === surfaceIndoorTemp)
        .sort((a: any, b: any) => a.temp_c - b.temp_c)
        .map((p: any) => ({
          temp_c: p.temp_c,
          capacity_kw: (p.capacity_w || 0) / 1000,
          input_power_kw: (p.input_power_w || 0) / 1000,
          cop: p.input_power_w > 0 ? (p.capacity_w / p.input_power_w) : 0,
        }))
    : null;

  const title = isCurve(profileKind)
    ? t('COP + Kapacitetskurva', 'COP + Capacity Curve')
    : t('Värmeprestanda (yta)', 'Heating Performance Surface');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          {/* Top controls */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm">{t('Källa', 'Source')}</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manufacturer">{t('Tillverkare', 'Manufacturer')}</SelectItem>
                  <SelectItem value="measured">{t('Uppmätt', 'Measured')}</SelectItem>
                  <SelectItem value="estimated">{t('Uppskattad', 'Estimated')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm">{t('Anteckningar', 'Notes')}</Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="text-sm" />
            </div>
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="table">{t('Tabell', 'Table')}</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
              <TabsTrigger value="preview">{t('Förhandsvisning', 'Preview')}</TabsTrigger>
            </TabsList>

            {/* TABLE TAB */}
            <TabsContent value="table" className="space-y-3">
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={addRow}>
                  <Plus className="w-3.5 h-3.5 mr-1" />{t('Lägg till rad', 'Add Row')}
                </Button>
                <Button variant="outline" size="sm" onClick={sortByTemp}>
                  <ArrowUpDown className="w-3.5 h-3.5 mr-1" />{t('Sortera temp', 'Sort Temp')}
                </Button>
                <Button variant="outline" size="sm" onClick={normalizeKwToW}>
                  {t('kW→W', 'kW→W')}
                </Button>
                <Button variant="outline" size="sm" onClick={pasteExample}>
                  <Sparkles className="w-3.5 h-3.5 mr-1" />{t('Klistra in exempel', 'Paste Example')}
                </Button>
              </div>

              <div className="max-h-[300px] overflow-y-auto border rounded" onPaste={handleTablePaste}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {!isCurve(profileKind) && <TableHead className="w-24">Indoor °C</TableHead>}
                      <TableHead className="w-24">°C</TableHead>
                      {isCurve(profileKind) && <TableHead className="w-24">COP</TableHead>}
                      <TableHead className="w-28">{t('Kapacitet (W)', 'Capacity (W)')}</TableHead>
                      {!isCurve(profileKind) && <TableHead className="w-28">{t('Ineffekt (W)', 'Input Power (W)')}</TableHead>}
                      {!isCurve(profileKind) && <TableHead className="w-20">COP</TableHead>}
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(points || []).map((p: any, i: number) => (
                      <TableRow key={i}>
                        {!isCurve(profileKind) && (
                          <TableCell>
                            <Input type="number" value={p.indoor_temp_c ?? ''} onChange={e => updatePointField(i, 'indoor_temp_c', e.target.value)} className="h-7 text-xs w-20" />
                          </TableCell>
                        )}
                        <TableCell>
                          <Input type="number" value={p.temp_c ?? ''} onChange={e => updatePointField(i, 'temp_c', e.target.value)} className="h-7 text-xs w-20" />
                        </TableCell>
                        {isCurve(profileKind) && (
                          <TableCell>
                            <Input type="number" step="0.1" value={p.cop ?? ''} onChange={e => updatePointField(i, 'cop', e.target.value)} className="h-7 text-xs w-20" />
                          </TableCell>
                        )}
                        <TableCell>
                          <Input type="number" value={p.capacity_w ?? ''} onChange={e => updatePointField(i, 'capacity_w', e.target.value)} className="h-7 text-xs w-24" />
                        </TableCell>
                        {!isCurve(profileKind) && (
                          <TableCell>
                            <Input type="number" value={p.input_power_w ?? ''} onChange={e => updatePointField(i, 'input_power_w', e.target.value)} className="h-7 text-xs w-24" />
                          </TableCell>
                        )}
                        {!isCurve(profileKind) && (
                          <TableCell className="text-xs text-muted-foreground">
                            {p.input_power_w > 0 ? (p.capacity_w / p.input_power_w).toFixed(2) : '—'}
                          </TableCell>
                        )}
                        <TableCell>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteRow(i)}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">{t('Tips: Klistra in TSV-data (t.ex. från Excel)', 'Tip: Paste TSV data (e.g. from Excel)')}</p>
            </TabsContent>

            {/* JSON TAB */}
            <TabsContent value="json" className="space-y-3">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { try { setJsonText(JSON.stringify(JSON.parse(jsonText), null, 2)); } catch {} }}>
                  {t('Formatera', 'Format')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyJson(jsonText)}>
                  {t('Validera', 'Validate')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => {
                  const example = isCurve(profileKind) ? EXAMPLE_CURVE : EXAMPLE_SURFACE;
                  const text = JSON.stringify(example, null, 2);
                  applyJson(text);
                }}>
                  <Sparkles className="w-3.5 h-3.5 mr-1" />{t('Exempel', 'Example')}
                </Button>
              </div>
              <Textarea
                value={jsonText}
                onChange={e => applyJson(e.target.value)}
                rows={12}
                className="font-mono text-xs"
              />
            </TabsContent>

            {/* PREVIEW TAB */}
            <TabsContent value="preview" className="space-y-4">
              {isCurve(profileKind) && curveChartData && curveChartData.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="h-[200px]">
                    <p className="text-xs font-medium mb-1">COP</p>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={curveChartData}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis dataKey="temp_c" type="number" label={{ value: '°C', position: 'insideBottom', offset: -5 }} />
                        <YAxis label={{ value: 'COP', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Line type="monotone" dataKey="cop" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="h-[200px]">
                    <p className="text-xs font-medium mb-1">{t('Kapacitet', 'Capacity')}</p>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={curveChartData}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis dataKey="temp_c" type="number" label={{ value: '°C', position: 'insideBottom', offset: -5 }} />
                        <YAxis label={{ value: 'kW', angle: -90, position: 'insideLeft' }} />
                        <Tooltip />
                        <Line type="monotone" dataKey="capacity_kw" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {!isCurve(profileKind) && surfaceChartData && (
                <>
                  <div className="flex items-center gap-2">
                    <Label className="text-sm">{t('Inomhustemp', 'Indoor Temp')}:</Label>
                    <Select value={String(surfaceIndoorTemp)} onValueChange={v => setSurfaceIndoorTemp(Number(v))}>
                      <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {surfaceIndoorTemps.map(t => <SelectItem key={t} value={String(t)}>{t}°C</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {surfaceChartData.length > 0 ? (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="h-[180px]">
                        <p className="text-xs font-medium mb-1">{t('Kapacitet', 'Capacity')}</p>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={surfaceChartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis dataKey="temp_c" type="number" />
                            <YAxis />
                            <Tooltip />
                            <Line type="monotone" dataKey="capacity_kw" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="h-[180px]">
                        <p className="text-xs font-medium mb-1">{t('Ineffekt', 'Input Power')}</p>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={surfaceChartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis dataKey="temp_c" type="number" />
                            <YAxis />
                            <Tooltip />
                            <Line type="monotone" dataKey="input_power_kw" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 2 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="h-[180px]">
                        <p className="text-xs font-medium mb-1">COP</p>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={surfaceChartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis dataKey="temp_c" type="number" />
                            <YAxis />
                            <Tooltip />
                            <Line type="monotone" dataKey="cop" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={{ r: 2 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('Ingen data för vald inomhustemp', 'No data for selected indoor temp')}</p>
                  )}
                </>
              )}

              {(!points || points.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-8">{t('Lägg till data för att se förhandsvisning', 'Add data to see preview')}</p>
              )}
            </TabsContent>
          </Tabs>

          {/* Validation summary */}
          {validation.error && (
            <Badge variant="destructive" className="text-sm py-1 px-3 whitespace-normal break-words">{validation.error}</Badge>
          )}
          {validation.warnings?.map((w, i) => (
            <Badge key={i} variant="outline" className="text-sm py-1 px-3 whitespace-normal break-words text-yellow-600 border-yellow-400">{w}</Badge>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || !validation.valid}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {t('Spara', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PerformanceDataEditor;
