import React, { useState, useEffect } from 'react';
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
import { simulateDay } from '@/lib/simulate-day';
import LoadCurveChart from './LoadCurveChart';
import EnergyVsTempChart from './EnergyVsTempChart';

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
    annualKwh: number;
    annualCostSek: number;
    annualNetworkCost: number;
    annualEnergyCost: number;
    annualFixedCost: number;
    timeseries: Array<{ time: string; total: number; heating: number; shiftable: number; fixedActive: number; base: number }>;
    sweepData: Array<{ tempC: number; dailyKwh: number }>;
  } | null>(null);

  // Pre-populate slider defaults from energy_home_settings overrides
  useEffect(() => {
    if (!homeId) return;
    const loadDefaults = async () => {
      const { data: settings } = await supabase
        .from('energy_home_settings')
        .select('overrides')
        .eq('home_id', homeId)
        .single();
      if (settings?.overrides && typeof settings.overrides === 'object') {
        const ov = settings.overrides as Record<string, any>;
        if (typeof ov.indoor_temp_c === 'number') setIndoorTemp(ov.indoor_temp_c);
        if (typeof ov.comfort_band_c === 'number') setComfortBand(ov.comfort_band_c);
      }
    };
    loadDefaults();
  }, [homeId]);

  const deltaT = Math.max(0, indoorTemp - outdoorTemp);

  const handleRun = async () => {
    if (!homeId) return;
    setRunning(true);

    // 1. Fetch energy_home_settings
    const { data: settings } = await supabase
      .from('energy_home_settings')
      .select('ua_w_per_k, overrides, tariff_instance_id')
      .eq('home_id', homeId)
      .single();

    // 2. Fetch tariff
    let tariff: { network_price_sek_per_w_month: number; energy_price_sek_per_kwh: number; fixed_monthly_fee_sek: number } | null = null;
    if (settings?.tariff_instance_id) {
      const { data: ti } = await supabase
        .from('tariff_instances')
        .select('network_price_sek_per_w_month, energy_price_sek_per_kwh, fixed_monthly_fee_sek')
        .eq('id', settings.tariff_instance_id)
        .single();
      tariff = ti as any;
    }

    // 3. Fetch annual_kwh from home_answers
    let annualKwhValue: number | null = null;
    const { data: annualQ } = await supabase
      .from('home_questions')
      .select('id')
      .eq('semantic_key', 'annual_kwh')
      .single();
    if (annualQ) {
      const { data: ans } = await supabase
        .from('home_answers')
        .select('answer_value')
        .eq('home_id', homeId)
        .eq('question_id', annualQ.id)
        .single();
      if (ans?.answer_value != null) {
        annualKwhValue = Number(ans.answer_value);
        if (isNaN(annualKwhValue)) annualKwhValue = null;
      }
    }

    // 4. Fetch device assignments
    const { data: assignments } = await supabase
      .from('home_device_assignments')
      .select('quantity, device_instances(id, name, device_type_id, field_values, controllable, shiftable, priority, device_types(key, simulation_model_key))')
      .eq('home_id', homeId);

    // --- Compute aggregates ---
    const UA = settings?.ua_w_per_k ?? 150;
    if (!settings?.ua_w_per_k) console.warn('Simulator fallback: using 150 W/K for UA');

    let baseW: number;
    if (annualKwhValue && annualKwhValue > 0) {
      const avgW = (annualKwhValue * 1000) / 8760;
      baseW = avgW * 0.35;
    } else {
      baseW = 500;
      console.warn('Simulator fallback: using 500W base load');
    }

    const networkPrice = tariff?.network_price_sek_per_w_month ?? 0.045;
    const energyPrice = tariff?.energy_price_sek_per_kwh ?? 1.5;
    const fixedFee = tariff?.fixed_monthly_fee_sek ?? 0;
    if (!tariff) console.warn('Simulator fallback: using default tariff prices (0.045, 1.5, 0)');

    let shiftableW = 0;
    let fixedActiveW = 0;
    const deviceSnapshot = (assignments || []).map((a: any) => {
      const d = a.device_instances;
      const fv = (d.field_values && typeof d.field_values === 'object') ? d.field_values as Record<string, any> : {};
      const power = Number(fv.rated_power_w) || 0;
      const totalPower = power * (a.quantity || 1);

      if (d.shiftable) {
        shiftableW += totalPower;
      } else if (!d.controllable) {
        fixedActiveW += totalPower;
      }

      return {
        instance_id: d.id,
        name: d.name,
        quantity: a.quantity,
        field_values: d.field_values,
        controllable: d.controllable,
        shiftable: d.shiftable,
        priority: d.priority,
        type_key: d.device_types?.key,
        simulation_model_key: d.device_types?.simulation_model_key,
      };
    });

    // --- Run single-day simulation using extracted function ---
    const effectiveOutdoorTemp = mode === 'design' ? outdoorTemp : 0;
    const dayResult = simulateDay({
      indoorTempC: indoorTemp,
      outdoorTempC: effectiveOutdoorTemp,
      UA,
      baseW,
      shiftableW,
      fixedActiveW,
      scenario,
    });

    // --- Temperature sweep (-20 to +20) ---
    const sweepData: Array<{ tempC: number; dailyKwh: number }> = [];
    for (let temp = -20; temp <= 20; temp++) {
      const sweep = simulateDay({
        indoorTempC: indoorTemp,
        outdoorTempC: temp,
        UA,
        baseW,
        shiftableW,
        fixedActiveW,
        scenario,
      });
      sweepData.push({ tempC: temp, dailyKwh: sweep.dailyKwh });
    }

    // --- Compute costs ---
    const peakW = dayResult.peakW;
    const totalKwh = Math.round(dayResult.timeseries.reduce((s, p) => s + p.total, 0) * 365 / 4 / 1000);
    const heatingKwh = Math.round(dayResult.timeseries.reduce((s, p) => s + p.heating, 0) * 365 / 4 / 1000);
    const baseKwh = Math.round(dayResult.timeseries.reduce((s, p) => s + p.base, 0) * 365 / 4 / 1000);
    const shiftableKwh = Math.round(dayResult.timeseries.reduce((s, p) => s + p.shiftable, 0) * 365 / 4 / 1000);
    const fixedActiveKwh = Math.round(dayResult.timeseries.reduce((s, p) => s + p.fixedActive, 0) * 365 / 4 / 1000);

    const annualNetworkCost = Math.round(peakW * networkPrice * 12);
    const annualEnergyCost = Math.round(totalKwh * energyPrice);
    const annualFixedCost = Math.round(fixedFee * 12);
    const annualCostSek = annualNetworkCost + annualEnergyCost + annualFixedCost;

    const inputsSnapshot = {
      indoor_temp_c: indoorTemp,
      outdoor_temp_c: outdoorTemp,
      delta_t_c: deltaT,
      comfort_band_c: comfortBand,
      target_peak_w: targetPeak ? Number(targetPeak) : null,
      home_id: homeId,
      ua_w_per_k: UA,
      base_w: baseW,
      shiftable_w: shiftableW,
      fixed_active_w: fixedActiveW,
    };

    const resultsSummary = {
      peakW, totalKwh, heatingKwh, baseKwh, shiftableKwh, fixedActiveKwh,
      annualNetworkCost, annualEnergyCost, annualFixedCost, annualCostSek,
    };

    const tariffSnapshot = tariff
      ? { network_price_sek_per_w_month: networkPrice, energy_price_sek_per_kwh: energyPrice, fixed_monthly_fee_sek: fixedFee }
      : {};

    await supabase.from('model_runs').insert([{
      customer_id: customerId,
      home_id: homeId,
      mode,
      scenario,
      step_seconds: 900,
      inputs_snapshot: inputsSnapshot as any,
      device_snapshot: deviceSnapshot as any,
      profile_snapshot: {} as any,
      results_summary: resultsSummary as any,
      tariff_snapshot: tariffSnapshot as any,
      timeseries: dayResult.timeseries as any,
    }]);

    setResults({ ...resultsSummary, annualKwh: totalKwh, timeseries: dayResult.timeseries, sweepData });
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
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Årlig kWh', 'Annual kWh')}</span><span className="font-medium">{results.annualKwh.toLocaleString()} kWh</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Nätavgift', 'Network Cost')}</span><span className="font-medium">{results.annualNetworkCost.toLocaleString()} SEK</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Energikostnad', 'Energy Cost')}</span><span className="font-medium">{results.annualEnergyCost.toLocaleString()} SEK</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('Fast avgift', 'Fixed Fee')}</span><span className="font-medium">{results.annualFixedCost.toLocaleString()} SEK</span></div>
              <div className="flex justify-between border-t border-border pt-1"><span className="text-muted-foreground font-medium">{t('Årlig kostnad', 'Annual Cost')}</span><span className="font-medium">{results.annualCostSek.toLocaleString()} SEK</span></div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="lg:col-span-3 space-y-4">
        {results ? (
          <>
            <LoadCurveChart title={t('Lastkurva (15-min)', 'Load Curve (15-min)')} data={results.timeseries} peakW={targetPeak ? Number(targetPeak) : undefined} height={350} />
            <EnergyVsTempChart
              title={t('Energi vs utomhustemperatur', 'Energy vs Outdoor Temperature')}
              data={results.sweepData}
              currentTemp={mode === 'design' ? outdoorTemp : 0}
              height={300}
            />
          </>
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
