import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface CurvePoint {
  temp_c: number;
  cop: number;
  capacity_w: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  existingProfileId?: string | null;
  existingData?: { points: CurvePoint[] } | null;
  onSaved: () => void;
}

function localValidate(data: unknown): { valid: true; points: CurvePoint[] } | { valid: false; error: string } {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as any).points)) {
    return { valid: false, error: 'JSON must contain a "points" array' };
  }
  const points = (data as any).points as CurvePoint[];
  if (points.length < 4) return { valid: false, error: `At least 4 points required, got ${points.length}` };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p.temp_c !== 'number' || p.temp_c < -40 || p.temp_c > 40) return { valid: false, error: `Point ${i}: temp_c invalid` };
    if (typeof p.cop !== 'number' || p.cop <= 0 || p.cop > 15) return { valid: false, error: `Point ${i}: cop invalid` };
    if (typeof p.capacity_w !== 'number' || !Number.isInteger(p.capacity_w) || p.capacity_w < 0 || p.capacity_w > 50000) return { valid: false, error: `Point ${i}: capacity_w invalid` };
    if (i > 0 && p.temp_c <= points[i - 1].temp_c) return { valid: false, error: `Point ${i}: temp_c not strictly increasing` };
  }
  return { valid: true, points };
}

const CurveUploadModal: React.FC<Props> = ({ open, onOpenChange, deviceId, existingProfileId, existingData, onSaved }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [source, setSource] = useState('manufacturer');
  const [notes, setNotes] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [points, setPoints] = useState<CurvePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Pre-populate with existing data when modal opens
  React.useEffect(() => {
    if (open && existingData?.points) {
      const text = JSON.stringify(existingData, null, 2);
      setJsonText(text);
      setPoints(existingData.points);
      setError(null);
    } else if (!open) {
      setJsonText('');
      setPoints(null);
      setError(null);
      setNotes('');
      setSource('manufacturer');
    }
  }, [open, existingData]);

  const validateJson = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setPoints(null);
      setError(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const result = localValidate(parsed);
      if (result.valid) {
        setPoints((result as { valid: true; points: CurvePoint[] }).points);
        setError(null);
      } else {
        setPoints(null);
        setError((result as { valid: false; error: string }).error);
      }
    } catch {
      setPoints(null);
      setError('Invalid JSON syntax');
    }
  };

  const handleSave = async () => {
    if (!points) return;
    setSaving(true);
    try {
      const { data: validation, error: fnError } = await supabase.functions.invoke('validate-device-profile', {
        body: { profile_kind: 'cop_capacity_curve', data: { points } },
      });
      if (fnError) throw fnError;
      if (!validation.valid) {
        setError(validation.error);
        setSaving(false);
        return;
      }

      if (existingProfileId) {
        const { error: upErr } = await supabase.from('device_profiles').update({
          data: { points } as any,
          source,
          notes: notes || null,
        }).eq('id', existingProfileId);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabase.from('device_profiles').insert({
          device_id: deviceId,
          profile_kind: 'cop_capacity_curve',
          data: { points } as any,
          source,
          notes: notes || null,
        });
        if (insErr) throw insErr;
      }

      toast({ title: t('Kurva sparad!', 'Curve saved!') });
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const chartData = points?.map(p => ({ temp_c: p.temp_c, cop: p.cop, capacity_kw: p.capacity_w / 1000 }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('Ladda upp COP + Kapacitetskurva', 'Upload COP + Capacity Curve')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 min-h-0 pr-1">
          <div>
            <Label className="text-sm">{t('JSON-data', 'JSON Data')}</Label>
            <Textarea
              value={jsonText}
              onChange={e => validateJson(e.target.value)}
              placeholder={t(
                'Klistra in JSON här, t.ex. {"points": [{"temp_c": -15, "cop": 2.1, "capacity_w": 4500}, ...]}',
                'Paste JSON here, e.g. {"points": [{"temp_c": -15, "cop": 2.1, "capacity_w": 4500}, ...]}'
              )}
              rows={6}
              className="mt-1 font-mono text-xs"
            />
          </div>

          {error && (
            <Badge variant="destructive" className="text-sm py-1 px-3 whitespace-normal break-words">{error}</Badge>
          )}

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
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
            </div>
          </div>

          {points && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="h-[180px]">
                  <p className="text-xs font-medium mb-1">COP</p>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="temp_c" type="number" label={{ value: '°C', position: 'insideBottom', offset: -5 }} />
                      <YAxis label={{ value: 'COP', angle: -90, position: 'insideLeft' }} />
                      <Tooltip />
                      <Line type="monotone" dataKey="cop" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="h-[180px]">
                  <p className="text-xs font-medium mb-1">{t('Kapacitet', 'Capacity')}</p>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="temp_c" type="number" label={{ value: '°C', position: 'insideBottom', offset: -5 }} />
                      <YAxis label={{ value: 'kW', angle: -90, position: 'insideLeft' }} />
                      <Tooltip />
                      <Line type="monotone" dataKey="capacity_kw" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="max-h-[200px] overflow-y-auto border rounded">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>°C</TableHead>
                      <TableHead>COP</TableHead>
                      <TableHead>Capacity (W)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {points.map((p, i) => (
                      <TableRow key={i}>
                        <TableCell>{p.temp_c}</TableCell>
                        <TableCell>{p.cop}</TableCell>
                        <TableCell>{p.capacity_w}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('Avbryt', 'Cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || !points}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {t('Spara', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CurveUploadModal;
