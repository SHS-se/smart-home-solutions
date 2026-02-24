import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, Globe, User, Upload, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
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
import type { DeviceRow, DeviceType } from './DeviceEditorForm';
import LoadCurveChart from './LoadCurveChart';
import EnergyVsTempChart from './EnergyVsTempChart';

type ScopeFilter = 'all' | 'global' | 'customer';
type PreviewCategory = 'base' | 'heating' | 'shiftable' | 'fixedActive';

const MODEL_LABELS: Record<string, string> = {
  fixed_baseload: 'Fixed baseload',
  electric_resistive_thermostat: 'Electric heater thermostat',
  air_to_air_heat_pump_inverter: 'Air-to-air heat pump (inverter)',
  fridge_freezer_compressor: 'Fridge/freezer compressor',
  event_appliance: 'Event appliance',
};

function isHeatingModel(modelKey?: string | null): boolean {
  return modelKey === 'electric_resistive_thermostat' || modelKey === 'air_to_air_heat_pump_inverter';
}

function classifyDevice(modelKey?: string | null, shiftable?: boolean | null): PreviewCategory {
  if (modelKey === 'fixed_baseload') return 'base';
  if (isHeatingModel(modelKey)) return 'heating';
  if (shiftable) return 'shiftable';
  return 'fixedActive';
}

function runtimeRoomKey(device: DeviceRuntime): string {
  const params = (device.params && typeof device.params === 'object') ? device.params as Record<string, unknown> : {};
  if (typeof params.roomKey === 'string' && params.roomKey) return params.roomKey;
  if (typeof params.ambientRoomKey === 'string' && params.ambientRoomKey) return params.ambientRoomKey;
  return 'default_room';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface CalibrationImportSummary {
  fileName: string;
  schema: string;
  deviceClass: string;
  rows: number;
  intervalMinutes: number | null;
  timeStartUtc: string | null;
  timeEndUtc: string | null;
  energyKwhEstimated: number | null;
  avgPowerW: number | null;
  peakPowerW: number | null;
  validationPass: boolean | null;
  validationIssues: string[];
}

interface DevicePreviewState {
  runtime: DeviceRuntime | null;
  warnings: DeviceBindingWarning[];
  originalModelKey: string | null;
  mappedModelKey: string | null;
  category: PreviewCategory | null;
  timeseries: Array<{ time: string; total: number; heating: number; shiftable: number; fixedActive: number; base: number }>;
  sweepData: Array<{ tempC: number; dailyKwh: number }>;
  currentDailyKwh: number;
  currentPeakW: number;
}

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

const DeviceModelsTab: React.FC = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const calibrationFileInputRef = useRef<HTMLInputElement | null>(null);

  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceTypes, setDeviceTypes] = useState<DeviceType[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeviceRow | null>(null);

  const [indoorTempC, setIndoorTempC] = useState(21);
  const [outdoorTempC, setOutdoorTempC] = useState(-5);
  const [uaWPerK, setUaWPerK] = useState(20);
  const [importedCalibration, setImportedCalibration] = useState<CalibrationImportSummary | null>(null);
  const [heatPumpProfileByDeviceId, setHeatPumpProfileByDeviceId] = useState<Record<string, {
    copCapacityCurvePoints?: CurvePoint[];
    heatingPerformanceSurfacePoints?: SurfacePoint[];
  }>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [{ data: devs }, { data: types }] = await Promise.all([
      supabase
        .from('device_instances')
        .select('id, name, customer_id, device_type_id, field_values, controllable, shiftable, priority, performance_data_device_id, include_in_standard_home, device_types(key, display_name, field_schema, simulation_model_key)')
        .order('name'),
      supabase.from('device_types').select('*').order('display_name'),
    ]);
    if (devs) {
      const rows = devs as unknown as DeviceRow[];
      setDevices(rows);
      if (!selected && rows.length > 0) setSelected(rows[0]);
    }
    if (types) {
      setDeviceTypes(types.map(t => ({ ...t, field_schema: t.field_schema as any, supported_profile_kinds: (t.supported_profile_kinds || []) as string[] })) as DeviceType[]);
    }
    setLoading(false);
  }, [selected]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = devices.filter(d => {
    if (scopeFilter === 'global' && d.customer_id !== null) return false;
    if (scopeFilter === 'customer' && d.customer_id === null) return false;
    if (typeFilter && d.device_type_id !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.name.toLowerCase().includes(q) ||
        `${d.device_types?.display_name || ''}`.toLowerCase().includes(q) ||
        `${d.device_types?.key || ''}`.toLowerCase().includes(q) ||
        `${d.field_values?.make || ''}`.toLowerCase().includes(q) ||
        `${d.field_values?.model || ''}`.toLowerCase().includes(q);
    }
    return true;
  });

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelected(filtered[0]);
    if (selected && !devices.some(d => d.id === selected.id)) setSelected(filtered[0] || null);
  }, [filtered, devices, selected]);

  useEffect(() => {
    let cancelled = false;
    if (!selected) return;

    const modelKey = (selected.device_types as any)?.simulation_model_key ?? '';
    const isHpLike = typeof modelKey === 'string' && /heat_pump|air_to_air/i.test(modelKey);
    if (!isHpLike) return;

    (async () => {
      const [curveRes, surfaceRes] = await Promise.all([
        resolveProfile(selected.id, 'manufacturer', 'cop_capacity_curve'),
        resolveProfile(selected.id, 'manufacturer', 'heating_performance_surface'),
      ]);
      if (cancelled) return;
      const curvePoints = asCurvePoints((curveRes.profile as any)?.data?.points);
      const surfacePoints = asSurfacePoints((surfaceRes.profile as any)?.data?.points);
      setHeatPumpProfileByDeviceId(prev => ({
        ...prev,
        [selected.id]: {
          copCapacityCurvePoints: curvePoints,
          heatingPerformanceSurfacePoints: surfacePoints,
        },
      }));
    })();

    return () => { cancelled = true; };
  }, [selected]);

  useEffect(() => {
    setImportedCalibration(null);
    if (calibrationFileInputRef.current) calibrationFileInputRef.current.value = '';
  }, [selected?.id]);

  const preview = useMemo<DevicePreviewState | null>(() => {
    if (!selected) return null;

    const assignment: SimulatorAssignmentRow = {
      quantity: 1,
      device_instances: {
        id: selected.id,
        name: selected.name,
        field_values: selected.field_values,
        controllable: selected.controllable,
        shiftable: selected.shiftable,
        priority: selected.priority,
        device_types: {
          key: selected.device_types?.key,
          simulation_model_key: (selected.device_types as any)?.simulation_model_key ?? null,
        },
      },
    };

    const binding = buildDeviceRuntimesFromAssignments([assignment], {
      defaultSetpointC: indoorTempC,
      heatPumpProfilesByDeviceId: heatPumpProfileByDeviceId,
    });
    const runtime = binding.devices[0] ?? null;
    const mappedModelKey = runtime?.modelKey ?? null;
    const originalModelKey = (selected.device_types as any)?.simulation_model_key ?? null;
    const category = classifyDevice(mappedModelKey, selected.shiftable);

    if (!runtime) {
      return {
        runtime: null,
        warnings: binding.warnings,
        originalModelKey,
        mappedModelKey,
        category: null,
        timeseries: [],
        sweepData: [],
        currentDailyKwh: 0,
        currentPeakW: 0,
      };
    }

    const categorizer = {
      getCategory: () => category,
      getHeatRoomKey: (device: DeviceRuntime) => runtimeRoomKey(device),
    };

    const occupancySchedule = [
      { startMinute: 0, endMinute: 7 * 60, occupancy: 'sleep' as const },
      { startMinute: 7 * 60, endMinute: 23 * 60, occupancy: 'home' as const },
      { startMinute: 23 * 60, endMinute: 0, occupancy: 'sleep' as const },
    ];

    const day = simulateDeviceDay({
      devices: [runtime],
      outdoorTempC,
      initialIndoorTempC: indoorTempC,
      uaWPerK,
      dtSeconds: 300,
      outputStepSeconds: 900,
      seed: 11,
      occupancySchedule,
      categorizer,
    });

    const sweepData: Array<{ tempC: number; dailyKwh: number }> = [];
    for (let temp = -20; temp <= 20; temp++) {
      const sweep = simulateDeviceDay({
        devices: [runtime],
        outdoorTempC: temp,
        initialIndoorTempC: indoorTempC,
        uaWPerK,
        dtSeconds: 300,
        outputStepSeconds: 900,
        seed: 1000 + temp,
        occupancySchedule,
        categorizer,
      });
      sweepData.push({ tempC: temp, dailyKwh: sweep.dailyKwh });
    }

    return {
      runtime,
      warnings: binding.warnings,
      originalModelKey,
      mappedModelKey,
      category,
      timeseries: day.timeseries,
      sweepData,
      currentDailyKwh: day.dailyKwh,
      currentPeakW: day.peakW,
    };
  }, [selected, indoorTempC, outdoorTempC, uaWPerK, heatPumpProfileByDeviceId]);

  const handleCalibrationImport = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const root = asRecord(parsed);
      if (!root) throw new Error('JSON root must be an object');

      const schema = typeof root.schema === 'string' ? root.schema : '';
      if (schema !== 'measured_device_sample_v1') {
        throw new Error(`Unsupported schema: ${schema || '(missing)'}`);
      }

      const deviceClass = typeof root.device_class === 'string' ? root.device_class : '';
      const series = Array.isArray(root.series) ? root.series : null;
      if (!series) throw new Error('Missing series array');
      if (series.length === 0) throw new Error('Series array is empty');

      const preprocessing = asRecord(root.preprocessing);
      const derivedSummary = asRecord(root.derived_summary);
      const validation = asRecord(preprocessing?.validation);
      const source = asRecord(root.source);
      const timeRange = asRecord(source?.time_range_utc);

      const validationIssues: string[] = [];
      const energyConsistency = asRecord(validation?.energy_consistency);
      const timestampValidation = asRecord(validation?.timestamp_validation);
      const requiredKeys = asRecord(validation?.required_keys);
      const powerCoverage = asRecord(validation?.power_coverage);

      if (energyConsistency && energyConsistency.pass === false) validationIssues.push('energy_consistency');
      if (timestampValidation && timestampValidation.pass === false) validationIssues.push('timestamp_validation');
      if (requiredKeys && requiredKeys.pass === false) validationIssues.push('required_keys');
      if (powerCoverage && powerCoverage.pass === false) validationIssues.push('power_coverage');

      const summary: CalibrationImportSummary = {
        fileName: file.name,
        schema,
        deviceClass,
        rows: series.length,
        intervalMinutes: typeof preprocessing?.interval_minutes === 'number' ? preprocessing.interval_minutes : null,
        timeStartUtc: typeof timeRange?.start === 'string' ? timeRange.start : null,
        timeEndUtc: typeof timeRange?.end === 'string' ? timeRange.end : null,
        energyKwhEstimated: typeof derivedSummary?.energy_kwh_estimated === 'number' ? derivedSummary.energy_kwh_estimated : null,
        avgPowerW: typeof derivedSummary?.avg_power_w === 'number' ? derivedSummary.avg_power_w : null,
        peakPowerW: typeof derivedSummary?.peak_power_w === 'number' ? derivedSummary.peak_power_w : null,
        validationPass: validationIssues.length === 0 ? true : false,
        validationIssues,
      };

      const selectedModelKey = preview?.mappedModelKey ?? null;
      const classMismatch =
        (selectedModelKey === 'electric_resistive_thermostat' && deviceClass !== 'electric_resistive_heater') ||
        (selectedModelKey === 'air_to_air_heat_pump_inverter' && deviceClass !== 'air_to_air_heat_pump');

      setImportedCalibration(summary);

      if (classMismatch) {
        toast({
          title: t('Kalibrering importerad med varning', 'Calibration imported with warning'),
          description: t(
            'Filens device_class matchar inte vald enhetsmodell.',
            'The file device_class does not match the selected device model.',
          ),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('Kalibrering importerad', 'Calibration imported'),
          description: t(
            'JSON-filen lästes in och validerades för förhandsgranskning.',
            'JSON file loaded and validated for preview.',
          ),
        });
      }
    } catch (error) {
      setImportedCalibration(null);
      toast({
        title: t('Fel vid import', 'Import error'),
        description: error instanceof Error ? error.message : t('Kunde inte läsa JSON-fil.', 'Could not read JSON file.'),
        variant: 'destructive',
      });
    }
  }, [preview?.mappedModelKey, t, toast]);

  const onCalibrationFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void handleCalibrationImport(file);
  }, [handleCalibrationImport]);

  const heatingPreviewEnabled = isHeatingModel(preview?.mappedModelKey ?? null);

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <div className="lg:col-span-1 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Enheter', 'Devices')}</CardTitle>
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

            <div className="space-y-1 max-h-[560px] overflow-y-auto">
              {filtered.map(d => (
                <div
                  key={d.id}
                  className={`p-2 rounded cursor-pointer flex items-center gap-2 ${selected?.id === d.id ? 'bg-muted' : 'hover:bg-muted/50'}`}
                  onClick={() => setSelected(d)}
                >
                  {d.customer_id === null ? <Globe className="w-3.5 h-3.5 text-primary shrink-0" /> : <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{d.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{d.device_types?.display_name} • {(d.device_types as any)?.simulation_model_key || '—'}</p>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">{t('Inga enheter hittades.', 'No devices found.')}</p>}
            </div>
          </CardContent>
        </Card>

        {heatingPreviewEnabled ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('Förhandsvisning', 'Preview')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">{t('Inomhus (°C)', 'Indoor (°C)')}</label>
                  <Input type="number" value={indoorTempC} onChange={e => setIndoorTempC(Number(e.target.value) || 0)} className="h-8" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">{t('Utomhus (°C)', 'Outdoor (°C)')}</label>
                  <Input type="number" value={outdoorTempC} onChange={e => setOutdoorTempC(Number(e.target.value) || 0)} className="h-8" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('Zonens UA (W/K)', 'Zone UA (W/K)')}</label>
                <Input type="number" value={uaWPerK} onChange={e => setUaWPerK(Number(e.target.value) || 0)} className="h-8" />
              </div>
              {preview && (
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Daglig energi', 'Daily energy')}</span><span>{preview.currentDailyKwh.toFixed(1)} kWh</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Toppeffekt', 'Peak')}</span><span>{formatPower(preview.currentPeakW).display}</span></div>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('Temperaturpreview', 'Temperature Preview')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t(
                  'UA- och temperaturbaserad preview visas endast för värmeenheter (t.ex. luft-luftvärmepump och elradiator).',
                  'UA- and temperature-based preview is only shown for heating devices (e.g. air-to-air heat pump and electric heater).',
                )}
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('Kalibreringsimport', 'Calibration Import')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <input
              ref={calibrationFileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={onCalibrationFileChange}
            />
            <Button
              variant="outline"
              className="w-full"
              onClick={() => calibrationFileInputRef.current?.click()}
              disabled={!selected}
            >
              <Upload className="w-4 h-4 mr-2" />
              {t('Importera kalibrerings-JSON', 'Import Calibration JSON')}
            </Button>

            {importedCalibration ? (
              <div className="rounded border p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{importedCalibration.fileName}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {importedCalibration.schema} • {importedCalibration.deviceClass}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      setImportedCalibration(null);
                      if (calibrationFileInputRef.current) calibrationFileInputRef.current.value = '';
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Rader', 'Rows')}</span><span>{importedCalibration.rows}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Intervall', 'Interval')}</span><span>{importedCalibration.intervalMinutes ? `${importedCalibration.intervalMinutes} min` : '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Energi', 'Energy')}</span><span>{importedCalibration.energyKwhEstimated != null ? `${importedCalibration.energyKwhEstimated.toFixed(2)} kWh` : '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Medel effekt', 'Avg power')}</span><span>{importedCalibration.avgPowerW != null ? formatPower(importedCalibration.avgPowerW).display : '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Toppeffekt', 'Peak power')}</span><span>{importedCalibration.peakPowerW != null ? formatPower(importedCalibration.peakPowerW).display : '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('Validering', 'Validation')}</span><span className={importedCalibration.validationPass ? 'text-emerald-600' : 'text-amber-600'}>{importedCalibration.validationPass ? t('OK', 'OK') : t('Varningar', 'Warnings')}</span></div>
                </div>

                {(importedCalibration.timeStartUtc || importedCalibration.timeEndUtc) && (
                  <div className="text-[11px] text-muted-foreground">
                    {importedCalibration.timeStartUtc || '—'} → {importedCalibration.timeEndUtc || '—'}
                  </div>
                )}

                {importedCalibration.validationIssues.length > 0 && (
                  <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                    <div className="font-medium mb-1">{t('Valideringsproblem', 'Validation issues')}</div>
                    <div className="space-y-0.5">
                      {importedCalibration.validationIssues.map(issue => (
                        <div key={issue} className="font-mono">{issue}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t(
                  'Importera en förprocessad mätfil (measured_device_sample_v1) för vald enhet. Detta används för kalibrering och jämförelse i nästa steg.',
                  'Import a preprocessed measured sample (measured_device_sample_v1) for the selected device. This will be used for calibration and comparison in the next step.',
                )}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-3 space-y-4">
        {!selected || !preview ? (
          <Card><CardContent className="min-h-[300px] flex items-center justify-center text-muted-foreground">{t('Välj en enhet', 'Select a device')}</CardContent></Card>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('Modellbindning', 'Model Binding')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">{t('Original modellnyckel', 'Original model key')}</div>
                    <div className="font-mono text-xs mt-1 break-all">{preview.originalModelKey || '—'}</div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">{t('Mappad archetype', 'Mapped archetype')}</div>
                    <div className="font-medium text-xs mt-1">{preview.mappedModelKey ? `${MODEL_LABELS[preview.mappedModelKey] || preview.mappedModelKey}` : '—'}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{preview.mappedModelKey || ''}</div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">{t('Kategori i preview', 'Preview category')}</div>
                    <div className="font-medium mt-1">{preview.category || '—'}</div>
                  </div>
                </div>

                {preview.warnings.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                    <div className="text-sm font-medium mb-2">{t('Bindningsvarningar', 'Binding warnings')}</div>
                    <div className="space-y-1 text-xs">
                      {preview.warnings.map((w, i) => (
                        <div key={`${w.code}-${i}`}><span className="font-mono mr-2">{w.code}</span>{w.message}</div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-xs text-muted-foreground mb-1">{t('Lösta parametrar (används i simuleringen)', 'Resolved parameters (used by simulator)')}</div>
                  <pre className="rounded bg-muted p-3 overflow-auto text-[11px] leading-relaxed">
{JSON.stringify(preview.runtime?.params ?? null, null, 2)}
                  </pre>
                </div>
              </CardContent>
            </Card>

            <LoadCurveChart
              title={t('Enhetsbeteende (24h, 15-min)', 'Device Behavior (24h, 15-min)')}
              data={preview.timeseries}
              height={320}
            />

            {heatingPreviewEnabled ? (
              <EnergyVsTempChart
                title={t('Enhetsenergi vs utomhustemperatur', 'Device Energy vs Outdoor Temperature')}
                data={preview.sweepData}
                currentTemp={outdoorTempC}
                height={300}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};

export default DeviceModelsTab;
