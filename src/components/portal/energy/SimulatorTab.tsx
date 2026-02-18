import React, { useState } from 'react';
import { Play, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { formatPower } from '@/lib/energy-units';
import LoadCurveChart from './LoadCurveChart';

interface SimulatorTabProps {
  customerId: string;
  homeId: string | null;
}

const SimulatorTab: React.FC<SimulatorTabProps> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const [mode, setMode] = useState<'design' | 'typical' | 'year'>('design');
  const [scenario, setScenario] = useState<'dumb' | 'smart'>('dumb');
  const [outdoorTemp, setOutdoorTemp] = useState(-5);
  const [indoorTemp, setIndoorTemp] = useState(21);
  const [comfortBand, setComfortBand] = useState(2);
  const [targetPeak, setTargetPeak] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<{
    peakW: number;
    effektavgiftPeakW: number;
    annualKwh: number;
    annualCostSek: number;
    savingsSek: number;
    timeseries: Array<{ time: string; total: number; heating: number; ev: number; appliance: number; base: number }>;
  } | null>(null);

  const deltaT = Math.max(0, indoorTemp - outdoorTemp);

  const handleRun = async () => {
    if (!homeId) return;
    setRunning(true);

    // Load device instances for this home
    const { data: devices } = await supabase
      .from('device_instances')
      .select('id, name, device_template_id, quantity, field_values, controllable, shiftable, priority, device_templates(id, display_name, device_kind, device_type_id, device_types(key, simulation_model_key))')
      .eq('home_id', homeId);

    const deviceSnapshot = (devices || []).map((d: any) => ({
      instance_id: d.id,
      device_template_id: d.device_template_id,
      name: d.name,
      quantity: d.quantity,
      field_values: d.field_values,
      controllable: d.controllable,
      shiftable: d.shiftable,
      priority: d.priority,
      type_key: d.device_templates?.device_types?.key,
      simulation_model_key: d.device_templates?.device_types?.simulation_model_key,
      template_display_name: d.device_templates?.display_name,
    }));

    const inputsSnapshot = {
      indoor_temp_c: indoorTemp,
      outdoor_temp_c: outdoorTemp,
      delta_t_c: deltaT,
      comfort_band_c: comfortBand,
      target_peak_w: targetPeak ? Number(targetPeak) : null,
      home_id: homeId,
    };

    // Generate demo timeseries
    const ts = Array.from({ length: 96 }, (_, i) => {
      const hour = Math.floor(i / 4);
      const min = (i % 4) * 15;
      const time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      const base = 500;
      const heating = mode === 'design'
        ? Math.max(0, deltaT * 150 * (1 + 0.3 * Math.sin(Math.PI * (hour - 6) / 12)))
        : Math.max(0, 2000 + 1000 * Math.sin(Math.PI * (hour - 14) / 12));
      const ev = hour >= 17 && hour <= 22 ? 11000 * (scenario === 'smart' ? 0 : 1) : (scenario === 'smart' && hour >= 1 && hour <= 5 ? 11000 : 0);
      const appliance = (hour >= 7 && hour <= 9) || (hour >= 18 && hour <= 20) ? 2000 : 0;
      const total = base + heating + ev + appliance;
      return { time, total, heating, ev, appliance, base };
    });

    const peakW = Math.max(...ts.map(p => p.total));
    const resultsSummary = {
      peakW,
      effektavgiftPeakW: peakW * 0.85,
      annualKwh: Math.round(ts.reduce((s, p) => s + p.total, 0) * 365 / 4 / 1000),
      annualCostSek: Math.round(peakW * 0.045 * 12 + ts.reduce((s, p) => s + p.total, 0) * 365 / 4 / 1000 * 1.5),
      savingsSek: scenario === 'smart' ? Math.round(peakW * 0.045 * 12 * 0.3) : 0,
    };

    // Insert model_run
    await supabase.from('model_runs').insert({
      customer_id: customerId,
      home_id: homeId,
      mode,
      scenario,
      step_seconds: 900,
      inputs_snapshot: inputsSnapshot,
      device_snapshot: deviceSnapshot,
      profile_snapshot: {},
      results_summary: resultsSummary,
      timeseries: ts,
    });

    setResults({ ...resultsSummary, timeseries: ts });
    setRunning(false);
  };

  if (!homeId) {
    return (
      <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
        <p>{t('Välj ett hem för att köra simulering.', 'Select a home to run simulation.')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Inställningar', 'Settings')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm">{t('Läge', 'Mode')}</Label>
              <Select value={mode} onValueChange={v => setMode(v as 'design' | 'typical' | 'year')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="design">{t('Design', 'Design')}</SelectItem>
                  <SelectItem value="typical">{t('Typisk', 'Typical')}</SelectItem>
                  <SelectItem value="year">{t('Helår', 'Full Year')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm">{t('Scenario', 'Scenario')}</Label>
              <div className="flex gap-2 mt-1">
                <Badge variant={scenario === 'dumb' ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setScenario('dumb')}>
                  {t('Dum', 'Dumb')}
                </Badge>
                <Badge variant={scenario === 'smart' ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setScenario('smart')}>
                  {t('Smart', 'Smart')}
                </Badge>
              </div>
            </div>

            {mode === 'design' && (
              <div>
                <Label className="text-sm">{t('Utomhustemp (°C)', 'Outdoor Temp (°C)')}: {outdoorTemp}</Label>
                <Slider value={[outdoorTemp]} onValueChange={v => setOutdoorTemp(v[0])} min={-25} max={15} step={1} />
                <p className="text-xs text-muted-foreground mt-1">ΔT = {deltaT} °C</p>
              </div>
            )}

            <div>
              <Label className="text-sm">{t('Inomhustemp (°C)', 'Indoor Temp (°C)')}: {indoorTemp}</Label>
              <Slider value={[indoorTemp]} onValueChange={v => setIndoorTemp(v[0])} min={15} max={25} step={1} />
            </div>
            <div>
              <Label className="text-sm">{t('Komfortband (°C)', 'Comfort Band (°C)')}: {comfortBand}</Label>
              <Slider value={[comfortBand]} onValueChange={v => setComfortBand(v[0])} min={0} max={5} step={0.5} />
            </div>
            <div>
              <Label className="text-sm">{t('Mål toppeffekt (W)', 'Target Peak (W)')}</Label>
              <Input type="number" value={targetPeak} onChange={e => setTargetPeak(e.target.value)} placeholder="—" />
            </div>
            <Button onClick={handleRun} disabled={running} className="w-full">
              {running ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              {t('Kör simulering', 'Run Simulation')}
            </Button>
          </CardContent>
        </Card>

        {results && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('Resultat', 'Results')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Topp', 'Peak')}</span><span className="font-medium">{formatPower(results.peakW).display}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Effektavgift topp', 'Demand Charge Peak')}</span><span className="font-medium">{formatPower(results.effektavgiftPeakW).display}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Årlig kWh', 'Annual kWh')}</span><span className="font-medium">{results.annualKwh.toLocaleString()} kWh</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Årlig kostnad', 'Annual Cost')}</span><span className="font-medium">{results.annualCostSek.toLocaleString()} SEK</span></div>
              {results.savingsSek > 0 && (
                <div className="flex justify-between text-green-600"><span>{t('Besparing', 'Savings')}</span><span className="font-medium">{results.savingsSek.toLocaleString()} SEK</span></div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="lg:col-span-3 space-y-4">
        {results ? (
          <LoadCurveChart title={t('Lastkurva (15-min)', 'Load Curve (15-min)')} data={results.timeseries} peakW={targetPeak ? Number(targetPeak) : undefined} height={350} />
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center min-h-[350px] text-muted-foreground">
              {t('Kör en simulering för att se resultat', 'Run a simulation to see results')}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default SimulatorTab;
