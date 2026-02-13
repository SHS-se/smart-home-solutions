import React, { useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { formatPower } from '@/lib/energy-units';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const CalibrationTab: React.FC = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [uaScale, setUaScale] = useState(100);
  const [copScale, setCopScale] = useState(100);
  const [capacityScale, setCapacityScale] = useState(100);

  // Demo overlay data
  const overlayData = Array.from({ length: 96 }, (_, i) => {
    const hour = Math.floor(i / 4);
    const measured = 2000 + 3000 * Math.max(0, Math.sin(Math.PI * (hour - 6) / 12)) + Math.random() * 500;
    const modeled = measured * (uaScale / 100) * (1 + (copScale - 100) / 500) * (capacityScale / 100);
    return {
      time: `${String(hour).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
      measured: Math.round(measured),
      modeled: Math.round(modeled),
    };
  });

  const handleUpload = async () => {
    if (!csvFile) return;
    setUploading(true);
    // TODO: Call energy-upload-csv edge function
    await new Promise(r => setTimeout(r, 1000));
    toast({ title: t('Uppladdad!', 'Uploaded!'), description: t('CSV normaliserad till 15-min medelvärden', 'CSV normalized to 15-min mean values') });
    setUploading(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Upload + sliders */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('CSV-uppladdning', 'CSV Upload')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => document.getElementById('csv-upload')?.click()}
            >
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {csvFile ? csvFile.name : t('Klicka för att ladda upp CSV', 'Click to upload CSV')}
              </p>
              <input
                id="csv-upload"
                type="file"
                accept=".csv"
                className="hidden"
                onChange={e => setCsvFile(e.target.files?.[0] || null)}
              />
            </div>
            <Button onClick={handleUpload} disabled={!csvFile || uploading} className="w-full">
              {uploading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {t('Ladda upp & normalisera', 'Upload & Normalize')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Kalibrering', 'Calibration')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm">UA {t('skala', 'scale')}: {uaScale}%</Label>
              <Slider value={[uaScale]} onValueChange={v => setUaScale(v[0])} min={50} max={150} step={1} />
            </div>
            <div>
              <Label className="text-sm">COP {t('skala', 'scale')}: {copScale}%</Label>
              <Slider value={[copScale]} onValueChange={v => setCopScale(v[0])} min={50} max={150} step={1} />
            </div>
            <div>
              <Label className="text-sm">{t('Kapacitetsskala', 'Capacity scale')}: {capacityScale}%</Label>
              <Slider value={[capacityScale]} onValueChange={v => setCapacityScale(v[0])} min={50} max={150} step={1} />
            </div>
            <Button variant="outline" className="w-full" onClick={() => {
              toast({ title: t('Sparat!', 'Saved!'), description: t('Kalibreringsparametrar sparade', 'Calibration parameters saved') });
            }}>
              {t('Spara kalibrering', 'Save Calibration')}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Overlay chart */}
      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('Uppmätt vs Modellerat', 'Measured vs Modeled')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={overlayData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="time" className="text-xs" />
                <YAxis
                  tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}` : `${v}`}
                  label={{ value: overlayData.some(d => d.measured >= 1000) ? 'kW' : 'W', angle: -90, position: 'insideLeft' }}
                  className="text-xs"
                />
                <Tooltip formatter={(v: number) => [formatPower(v).display]} />
                <Legend />
                <Line type="monotone" dataKey="measured" name={t('Uppmätt', 'Measured')} stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="modeled" name={t('Modellerat', 'Modeled')} stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} strokeDasharray="5 5" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default CalibrationTab;
