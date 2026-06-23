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
import {
  resolveProfile,
  type CurvePoint,
  type SurfacePoint,
} from '@/lib/performance-data';
import {
  buildDeviceRuntimesFromAssignments,
  simulateDeviceDay,
  type DeviceBindingWarning,
  type DeviceRuntime,
  type SimulatorAssignmentRow,
} from '@/lib/simulator';
import LoadCurveChart from './LoadCurveChart';
import EnergyVsTempChart from './EnergyVsTempChart';

interface SimulatorTabProps {
  customerId: string;
  homeId: string | null;
}

type DeviceModelDiagnosticsRow = {
  instanceId: string;
  name: string;
  quantity: number;
  typeKey?: string | null;
  simulationModelKey?: string | null;
  bound: boolean;
  boundModelKey?: string;
  nominalPowerW?: number;
  params?: Record<string, unknown>;
  warnings: DeviceBindingWarning[];
};

function asCurvePoints(value: unknown): CurvePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points = value.filter((p): p is CurvePoint => {
    const r = p as any;
    return r && typeof r.temp_c === 'number' && typeof r.cop === 'number' && typeof r.capacity_w === 'number';
  });
  return points.length >= 2 ? points : undefined;
}

function asSurfacePoints(value: unknown): SurfacePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points = value.filter((p): p is SurfacePoint => {
    const r = p as any;
    return r &&
      typeof r.indoor_temp_c === 'number' &&
      typeof r.temp_c === 'number' &&
      typeof r.capacity_w === 'number' &&
      typeof r.input_power_w === 'number';
  });
  return points.length >= 2 ? points : undefined;
}

type SimulatorResults = {
  peakW: number;
  annualKwh: number;
  annualCostSek: number;
  annualNetworkCost: number;
  annualEnergyCost: number;
  annualFixedCost: number;
  timeseries: Array<{ time: string; total: number; heating: number; shiftable: number; fixedActive: number; base: number }>;
  sweepData: Array<{ tempC: number; dailyKwh: number }>;
  deviceModelDiagnostics: {
    totalAssignedDevices: number;
    boundDevices: number;
    warningCount: number;
    modelCounts: Array<{ modelKey: string; count: number }>;
    rows: DeviceModelDiagnosticsRow[];
    warnings: DeviceBindingWarning[];
    aggregateInputs: { baseW: number; fixedActiveW: number; shiftableW: number; baseSource: 'models' };
  };
};

const MODEL_LABELS: Record<string, string> = {
  fixed_baseload: 'Fixed baseload',
  electric_resistive_thermostat: 'Electric heater thermostat',
  air_to_air_heat_pump_inverter: 'Air-to-air heat pump (inverter)',
  fridge_freezer_compressor: 'Fridge/freezer compressor',
  event_appliance: 'Event appliance',
};

function displayModelKey(modelKey?: string | null): string {
  if (!modelKey) return 'None';
  return MODEL_LABELS[modelKey] ? `${MODEL_LABELS[modelKey]} (${modelKey})` : modelKey;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readRuntimeNominalPowerW(modelKey: string | undefined, params: Record<string, unknown> | undefined): number | undefined {
  if (!modelKey || !params) return undefined;
  const getNum = (key: string) => {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  if (modelKey === 'fixed_baseload') return getNum('powerW');
  if (modelKey === 'electric_resistive_thermostat') return getNum('ratedPowerW');
  if (modelKey === 'air_to_air_heat_pump_inverter') return getNum('ratedInputPowerW');
  if (modelKey === 'fridge_freezer_compressor') return getNum('ratedPowerW');
  if (modelKey === 'event_appliance') {
    const cycle = Array.isArray(params.cycle) ? params.cycle : [];
    const stagePowers = cycle
      .map(s => (s && typeof s === 'object' && typeof (s as any).powerW === 'number' ? Number((s as any).powerW) : 0))
      .filter(n => Number.isFinite(n) && n >= 0);
    if (stagePowers.length > 0) return Math.max(...stagePowers);
  }
  return undefined;
}

function isSpaceHeatingModel(modelKey?: string): boolean {
  return modelKey === 'electric_resistive_thermostat' || modelKey === 'air_to_air_heat_pump_inverter';
}

function getDevicePowerCategory(modelKey: string | undefined, shiftable: boolean | null | undefined): 'base' | 'heating' | 'shiftable' | 'fixedActive' {
  if (modelKey === 'fixed_baseload') return 'base';
  if (isSpaceHeatingModel(modelKey)) return 'heating';
  if (shiftable) return 'shiftable';
  return 'fixedActive';
}

function getRuntimeRoomKey(device: DeviceRuntime): string {
  const params = (device.params && typeof device.params === 'object') ? device.params as Record<string, unknown> : {};
  if (typeof params.roomKey === 'string' && params.roomKey) return params.roomKey;
  if (typeof params.ambientRoomKey === 'string' && params.ambientRoomKey) return params.ambientRoomKey;
  return 'default_room';
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
  const [results, setResults] = useState<SimulatorResults | null>(null);

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
    try {
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

      // 3. Fetch device assignments
      const { data: assignments } = await supabase
        .from('home_device_assignments')
        .select('quantity, device_instances(id, name, device_type_id, field_values, controllable, shiftable, priority, device_types(key, simulation_model_key))')
        .eq('home_id', homeId);

      const typedAssignments = ((assignments || []) as unknown[]) as SimulatorAssignmentRow[];
      const heatPumpDevices = typedAssignments
        .map(a => a.device_instances)
        .filter((d): d is NonNullable<typeof d> => !!d)
        .filter(d => {
          const key = (d.device_types?.simulation_model_key || '').toLowerCase();
          return key.includes('heat_pump') || key.includes('air_to_air');
        });

      const heatPumpProfilesByDeviceIdEntries = await Promise.all(
        heatPumpDevices.map(async d => {
          const [curveRes, surfaceRes] = await Promise.all([
            resolveProfile(d.id, 'manufacturer', 'cop_capacity_curve'),
            resolveProfile(d.id, 'manufacturer', 'heating_performance_surface'),
          ]);
          return [d.id, {
            copCapacityCurvePoints: asCurvePoints((curveRes.profile as any)?.data?.points),
            heatingPerformanceSurfacePoints: asSurfacePoints((surfaceRes.profile as any)?.data?.points),
          }] as const;
        }),
      );
      const heatPumpProfilesByDeviceId = Object.fromEntries(heatPumpProfilesByDeviceIdEntries);

      const binding = buildDeviceRuntimesFromAssignments(typedAssignments, {
        defaultSetpointC: indoorTemp,
        heatPumpProfilesByDeviceId,
      });
      const warningsByDeviceId = new Map<string, DeviceBindingWarning[]>();
      for (const warning of binding.warnings) {
        const list = warningsByDeviceId.get(warning.deviceId) || [];
        list.push(warning);
        warningsByDeviceId.set(warning.deviceId, list);
      }
      const runtimeByDeviceId = new Map(binding.devices.map(d => [d.id, d] as const));

      // --- Compute aggregates ---
      const UA = settings?.ua_w_per_k ?? 150;
      if (!settings?.ua_w_per_k) console.warn('Simulator fallback: using 150 W/K for UA');

      const baseSource: SimulatorResults['deviceModelDiagnostics']['aggregateInputs']['baseSource'] = 'models';
      let baseWFromModels = 0;
      for (const runtime of binding.devices) {
        if (runtime.modelKey !== 'fixed_baseload') continue;
        const params = asRecord(runtime.params);
        const powerW = params && typeof params.powerW === 'number' ? params.powerW : 0;
        if (Number.isFinite(powerW) && powerW > 0) baseWFromModels += powerW;
      }

      const baseW = baseWFromModels;

      const networkPrice = tariff?.network_price_sek_per_w_month ?? 0.045;
      const energyPrice = tariff?.energy_price_sek_per_kwh ?? 1.5;
      const fixedFee = tariff?.fixed_monthly_fee_sek ?? 0;
      if (!tariff) console.warn('Simulator fallback: using default tariff prices (0.045, 1.5, 0)');

      let shiftableW = 0;
      let fixedActiveW = 0;
      const deviceCategoryById = new Map<string, 'base' | 'heating' | 'shiftable' | 'fixedActive'>();

      const diagnosticsRows: DeviceModelDiagnosticsRow[] = (typedAssignments || []).flatMap((assignment) => {
        const d = assignment.device_instances;
        if (!d) return [];
        const qty = Math.max(1, Number(assignment.quantity || 1));
        const runtime = runtimeByDeviceId.get(d.id);
        const runtimeParams = asRecord(runtime?.params);
        const nominalPowerW = readRuntimeNominalPowerW(runtime?.modelKey, runtimeParams);
        const fv = (d.field_values && typeof d.field_values === 'object') ? d.field_values as Record<string, any> : {};
        const fallbackPower = (Number(fv.rated_power_w) || Number(fv.power_w) || 0) * qty;
        const contributionW = nominalPowerW ?? fallbackPower;

        const category = getDevicePowerCategory(runtime?.modelKey, d.shiftable);
        if (runtime?.id) deviceCategoryById.set(runtime.id, category);
        if (category === 'shiftable') shiftableW += contributionW;
        if (category === 'fixedActive') fixedActiveW += contributionW;

        return [{
          instanceId: d.id,
          name: d.name || 'Unnamed device',
          quantity: qty,
          typeKey: d.device_types?.key,
          simulationModelKey: d.device_types?.simulation_model_key,
          bound: !!runtime,
          boundModelKey: runtime?.modelKey,
          nominalPowerW: contributionW > 0 ? contributionW : undefined,
          params: runtimeParams,
          warnings: warningsByDeviceId.get(d.id) || [],
        }];
      });

      const modelCounts = Array.from(
        diagnosticsRows.reduce((map, row) => {
          if (!row.boundModelKey) return map;
          map.set(row.boundModelKey, (map.get(row.boundModelKey) || 0) + 1);
          return map;
        }, new Map<string, number>()),
      )
        .map(([modelKey, count]) => ({ modelKey, count }))
        .sort((a, b) => b.count - a.count || a.modelKey.localeCompare(b.modelKey));

      const deviceSnapshot = (typedAssignments || []).map((a) => {
        const d = a.device_instances;
        const runtime = d ? runtimeByDeviceId.get(d.id) : null;
        const runtimeParams = asRecord(runtime?.params);
        return {
          instance_id: d?.id,
          name: d?.name,
          quantity: a.quantity,
          field_values: d?.field_values,
          controllable: d?.controllable,
          shiftable: d?.shiftable,
          priority: d?.priority,
          type_key: d?.device_types?.key,
          simulation_model_key: d?.device_types?.simulation_model_key,
          bound_model_key: runtime?.modelKey ?? null,
          bound_runtime_params: runtimeParams ?? null,
          binding_warnings: d ? (warningsByDeviceId.get(d.id) || []).map(w => ({ code: w.code, message: w.message })) : [],
        };
      });

      const occupancySchedule = [
        { startMinute: 0, endMinute: 7 * 60, occupancy: 'sleep' as const },
        { startMinute: 7 * 60, endMinute: 23 * 60, occupancy: 'home' as const },
        { startMinute: 23 * 60, endMinute: 0, occupancy: 'sleep' as const },
      ];

      // --- Run single-day simulation (device-driven) ---
      const effectiveOutdoorTemp = mode === 'design' ? outdoorTemp : 0;
      const dayResult = simulateDeviceDay({
        devices: binding.devices,
        outdoorTempC: effectiveOutdoorTemp,
        initialIndoorTempC: indoorTemp,
        uaWPerK: UA,
        dtSeconds: 300,
        outputStepSeconds: 900,
        seed: 42,
        occupancySchedule,
        categorizer: {
          getCategory: (deviceId, modelKey) => deviceCategoryById.get(deviceId) ?? getDevicePowerCategory(modelKey, false),
          getHeatRoomKey: device => getRuntimeRoomKey(device),
        },
      });

      // --- Temperature sweep (-20 to +20) ---
      const sweepData: Array<{ tempC: number; dailyKwh: number }> = [];
      for (let temp = -20; temp <= 20; temp++) {
        const sweep = simulateDeviceDay({
          devices: binding.devices,
          outdoorTempC: temp,
          initialIndoorTempC: indoorTemp,
          uaWPerK: UA,
          dtSeconds: 300,
          outputStepSeconds: 900,
          seed: 42 + (temp + 20),
          occupancySchedule,
          categorizer: {
            getCategory: (deviceId, modelKey) => deviceCategoryById.get(deviceId) ?? getDevicePowerCategory(modelKey, false),
            getHeatRoomKey: device => getRuntimeRoomKey(device),
          },
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
        simulation_engine: 'device_models_v1',
        base_w: baseW,
        base_w_source: baseSource,
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
        profile_snapshot: {
          device_binding: {
            warnings: binding.warnings,
            model_counts: modelCounts,
          },
        } as any,
        results_summary: resultsSummary as any,
        tariff_snapshot: tariffSnapshot as any,
        timeseries: dayResult.timeseries as any,
      }]);

      setResults({
        ...resultsSummary,
        annualKwh: totalKwh,
        timeseries: dayResult.timeseries,
        sweepData,
        deviceModelDiagnostics: {
          totalAssignedDevices: diagnosticsRows.length,
          boundDevices: diagnosticsRows.filter(r => r.bound).length,
          warningCount: binding.warnings.length,
          modelCounts,
          rows: diagnosticsRows.sort((a, b) => a.name.localeCompare(b.name)),
          warnings: binding.warnings,
          aggregateInputs: { baseW, fixedActiveW, shiftableW, baseSource },
        },
      });
    } finally {
      setRunning(false);
    }
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

        {results && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('Modellbindning', 'Model Binding')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">{t('Bundna enheter', 'Bound devices')}</div>
                  <div className="font-medium">{results.deviceModelDiagnostics.boundDevices}/{results.deviceModelDiagnostics.totalAssignedDevices}</div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs text-muted-foreground">{t('Varningar', 'Warnings')}</div>
                  <div className="font-medium">{results.deviceModelDiagnostics.warningCount}</div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">{t('Aggregerade ingångar (nuvarande simulator)', 'Aggregated inputs (current simulator)')}</div>
                <div className="flex justify-between"><span>{t('Baslast', 'Baseload')}</span><span className="font-medium">{formatPower(results.deviceModelDiagnostics.aggregateInputs.baseW).display}</span></div>
                <div className="flex justify-between"><span>{t('Fast aktiv', 'Fixed active')}</span><span className="font-medium">{formatPower(results.deviceModelDiagnostics.aggregateInputs.fixedActiveW).display}</span></div>
                <div className="flex justify-between"><span>{t('Flyttbar', 'Shiftable')}</span><span className="font-medium">{formatPower(results.deviceModelDiagnostics.aggregateInputs.shiftableW).display}</span></div>
                <div className="text-xs text-muted-foreground">
                  {t('Baslastkälla', 'Baseload source')}: {results.deviceModelDiagnostics.aggregateInputs.baseSource}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {results.deviceModelDiagnostics.modelCounts.length > 0 ? results.deviceModelDiagnostics.modelCounts.map(({ modelKey, count }) => (
                  <Badge key={modelKey} variant="outline" className="text-xs">
                    {count} × {MODEL_LABELS[modelKey] || modelKey}
                  </Badge>
                )) : (
                  <span className="text-xs text-muted-foreground">{t('Inga enheter bundna till modeller ännu.', 'No devices bound to models yet.')}</span>
                )}
              </div>
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
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t('Enhetsmodeller (diagnostik)', 'Device Models (Diagnostics)')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {results.deviceModelDiagnostics.warnings.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                    <div className="text-sm font-medium mb-2">{t('Bindningsvarningar', 'Binding warnings')}</div>
                    <div className="space-y-1 text-xs">
                      {results.deviceModelDiagnostics.warnings.map((w, i) => (
                        <div key={`${w.deviceId}-${w.code}-${i}`} className="flex gap-2">
                          <span className="font-mono text-muted-foreground">{w.code}</span>
                          <span>{w.deviceName || w.deviceId}: {w.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  {results.deviceModelDiagnostics.rows.map(row => (
                    <details key={row.instanceId} className="rounded-md border p-3">
                      <summary className="cursor-pointer list-none">
                        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between pr-5">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{row.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {row.typeKey || 'unknown_type'} • {displayModelKey(row.simulationModelKey)}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <Badge variant={row.bound ? 'default' : 'outline'}>
                              {row.bound ? t('Bunden', 'Bound') : t('Obunden', 'Unbound')}
                            </Badge>
                            {row.nominalPowerW !== undefined && (
                              <span className="text-muted-foreground">{formatPower(row.nominalPowerW).display}</span>
                            )}
                          </div>
                        </div>
                      </summary>
                      <div className="mt-3 space-y-2 text-xs">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div><span className="text-muted-foreground">{t('Kvantitet', 'Quantity')}:</span> {row.quantity}</div>
                          <div><span className="text-muted-foreground">{t('Modell', 'Model')}:</span> {row.boundModelKey || '—'}</div>
                          <div><span className="text-muted-foreground">{t('Nominell effekt', 'Nominal power')}:</span> {row.nominalPowerW ? formatPower(row.nominalPowerW).display : '—'}</div>
                        </div>
                        {row.warnings.length > 0 && (
                          <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 space-y-1">
                            {row.warnings.map((w, i) => (
                              <div key={`${row.instanceId}-warn-${i}`}><span className="font-mono mr-2">{w.code}</span>{w.message}</div>
                            ))}
                          </div>
                        )}
                        {row.params && (
                          <pre className="rounded bg-muted p-2 overflow-auto text-[11px] leading-relaxed">
{JSON.stringify(row.params, null, 2)}
                          </pre>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </CardContent>
            </Card>
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
