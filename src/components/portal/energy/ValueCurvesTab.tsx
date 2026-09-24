// Planner curves and editable thresholds, replayed against the saved price outlook.
// Values are shown at the solve's initial equipment efficiency.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Loader2, Save, Sparkles, TrendingDown } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import {
  DEFAULT_VALUE_CURVES,
  type ValueStoreKey,
  type DefaultValueStoreKey,
  parseStoredCurve,
  validateBatteryCurve,
} from '../../../../supabase/functions/_shared/value-curves';
import {
  marginalValue,
  curveWithinReach,
  type UtilityCurve,
} from '../../../../supabase/functions/_shared/store-value';
import { WATER_KWH_PER_M3_K } from '../../../../supabase/functions/_shared/store-models';
import {
  curveFromPreference,
  DEFAULT_POOL_PREFERENCE,
  DEFAULT_URGENT_PRICE_MULTIPLIER,
  preferenceFromCurve,
  preferenceWithPriceMode,
  validatePreference,
  vehiclePreference,
  type StorePreference,
} from '../../../../supabase/functions/_shared/value-preferences';
import { balancedBatteryCurve, type OptimisationPlan, type OptimisationSnapshot } from '../../../../supabase/functions/_shared/energy-optimisation';
import { comparePreference, type PreviewComparison } from '@/lib/energy-shift/curve-preview';
import {
  replanState,
  type ReplanRow,
} from '@/lib/energy-shift/replan-request';
import type { BatteryValueCurveDiagnostic } from '@/lib/energy-shift/contracts';
import PointCurveEditor from './PointCurveEditor';

interface Props {
  planSnapshotId?: string;
  customerId: string | null;
  homeId: string | null;
  /** All-in prices from the live plan, so the chart compares like with like. */
  importPriceSekPerKwh?: number | null;
  exportPriceSekPerKwh?: number | null;
  /** The range the customer's own charge limit asks for, anchoring the curve. */
  vehicleTargetRangeKm?: number | null;
  /** Range at 100% SOC, so a kilometre threshold can be read as a percentage. */
  vehicleFullRangeKm?: number | null;
  /** The charge limit the car enforces, as a fraction. */
  vehicleChargeLimitSoc?: number | null;
  /** Exact active curve and automatic alternative published by the current solve. */
  batteryValueCurve?: BatteryValueCurveDiagnostic | null;
  /**
   * The replan columns of the row on file. A request is answered by the house
   * rather than by this button, so its progress is read from shared state and
   * not from anything remembered here.
   */
  replan?: ReplanRow | null;
  /** Re-read the row, so a queued request appears without waiting for a poll. */
  refreshing?: boolean;
}

const EDITABLE: DefaultValueStoreKey[] = ['pool', 'ev'];

interface Draft {
  preference: StorePreference;
  source: 'customer' | 'default';
  edited?: boolean;
}

type BatteryMode = 'custom' | 'price_only' | 'balanced';
interface BatteryDraft {
  curve: UtilityCurve | null;
  mode: BatteryMode;
  edited: boolean;
  comparisonInput?: { snapshot: OptimisationSnapshot; now: string };
}

async function priceOnlyDraft(homeId: string): Promise<BatteryDraft> {
  for (;;) {
    const { data, error } = await supabase.functions.invoke('energy-optimisation-battery-curve', {
      body: { home_id: homeId },
    });
    if (error) {
      const response = (error as { context?: Response }).context;
      if (response) {
        const body = await response.json();
        throw new Error(body.detail ?? body.error ?? error.message);
      }
      throw error;
    }
    if (data?.pending === true) {
      if (!Number.isFinite(data.retry_after_ms) || data.retry_after_ms < 0) {
        throw new Error('The cost curve response has an invalid continuation delay.');
      }
      await new Promise(resolve => setTimeout(resolve, data.retry_after_ms));
      continue;
    }
    const curve = data?.selection?.curve as UtilityCurve | undefined;
    if (!curve || !Array.isArray(curve.points) || validateBatteryCurve(curve)
      || !data?.input?.snapshot || !Number.isFinite(Date.parse(data?.input?.now))) {
      throw new Error('The cost curve response is incomplete. Try generating it again.');
    }
    return { curve, mode: 'price_only', edited: true, comparisonInput: data.input };
  }
}


type Drafts = Partial<Record<ValueStoreKey, Draft>>;

const STEP: Record<DefaultValueStoreKey, number> = { pool: 0.5, ev: 10, hot_water: 100 };

const numeric = (value: string, fallback: number) => {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Keep a text draft so typing a decimal separator does not reset the input. */
export const MultiplierInput = ({ value, onChange }: { value: number; onChange: (value: string) => void }) => {
  const [text, setText] = useState(value.toFixed(1));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(value.toFixed(1)); }, [value, focused]);
  return <Input type="number" min={0} step={0.1} className="h-9" value={text}
    onFocus={() => setFocused(true)}
    onChange={event => {
      const raw = event.target.value;
      const parsed = Number(raw);
      if (raw === '' || !Number.isFinite(parsed)) { setText(raw); return; }
      const rounded = parsed.toFixed(1);
      setText((raw.split('.')[1]?.length ?? 0) > 1 ? rounded : raw);
      onChange(rounded);
    }}
    onBlur={() => { setFocused(false); setText(value.toFixed(1)); }} />;
};

const ValueCurvesTab: React.FC<Props> = ({
  customerId,
  homeId,
  planSnapshotId,
  importPriceSekPerKwh,
  exportPriceSekPerKwh,
  vehicleTargetRangeKm,
  vehicleFullRangeKm,
  vehicleChargeLimitSoc,
  batteryValueCurve,
  replan,
  refreshing = false,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [batteryDraft, setBatteryDraft] = useState<BatteryDraft>({ curve: null, mode: 'balanced', edited: false });
  const [savedBatteryDraft, setSavedBatteryDraft] = useState<BatteryDraft>(batteryDraft);
  const [generatingBattery, setGeneratingBattery] = useState(false);
  const [batteryGenerationError, setBatteryGenerationError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [stored, setStored] = useState<Partial<Record<ValueStoreKey, UtilityCurve>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewComparison | string | null>(null);
  const [snapshot, setSnapshot] = useState<OptimisationSnapshot | null>(null);

  const [sourcePlan, setSourcePlan] = useState<OptimisationPlan | null>(null);
  const [batteryLoadError, setBatteryLoadError] = useState<string | null>(null);
  const [curveError, setCurveError] = useState<string | null>(null);
  const plannedStores = useMemo(() => sourcePlan?.resolved_value_stores ?? [], [sourcePlan]);
  const scales = useMemo(() => Object.fromEntries(plannedStores.map(store => [store.key, {
    units_per_kwh: store.units_per_kwh,
    reference_sek_per_kwh: store.reference_sek_per_kwh,
  }])) as Record<string, { units_per_kwh: number; reference_sek_per_kwh: number }>, [plannedStores]);

  /**
   * What the editor opens on when the stored shape is not one of ours.
   *
   * Stated, never inferred. The vehicle's is scaled to this customer's own
   * charge limit, because an absolute kilometre figure means nothing across
   * vehicles.
   */
  const defaultPreference = useCallback(
    (key: ValueStoreKey): StorePreference =>
      key === 'ev'
        ? vehiclePreference(vehicleTargetRangeKm ?? 400)
        : DEFAULT_POOL_PREFERENCE,
    [vehicleTargetRangeKm],
  );

  const curveOf = useCallback(
    (key: DefaultValueStoreKey, preference: StorePreference) =>
      curveFromPreference({
        ...preference,
        urgent_price_multiplier: preference.max_value_sek_per_kwh != null
          ? null : preference.urgent_price_multiplier ?? DEFAULT_URGENT_PRICE_MULTIPLIER,
      }, DEFAULT_VALUE_CURVES[key].unit, scales[key]),
    [scales],
  );

  const load = useCallback(async () => {
    if (!homeId) return;
    setLoading(true);
    setPreview(null);
    setCurveError(null);
    const { data: source, error: sourceError } = await supabase
      .from('energy_optimisation_current')
      .select('snapshot, plan')
      .eq('home_id', homeId)
      .maybeSingle();
    if (sourceError || !source?.snapshot || !source?.plan) {
      setCurveError(sourceError?.message ?? 'No planner snapshot is available. Replan to see the curves.');
      setLoading(false);
      return;
    }
    setSnapshot(source.snapshot as unknown as OptimisationSnapshot);
    setSourcePlan(source.plan as unknown as OptimisationPlan);
    const { data, error } = await supabase
      .from('energy_optimisation_value_curves')
      .select('store_key, unit, points, max_value_sek_per_kwh, urgent_price_multiplier, generation_mode')
      .eq('home_id', homeId);
    if (error) { setCurveError(error.message); setLoading(false); return; }
    const nextDrafts: Drafts = {};
    const nextStored: Partial<Record<ValueStoreKey, UtilityCurve>> = {};
    for (const key of EDITABLE) {
      const row = (data ?? []).find(entry => entry.store_key === key);
      const curve: UtilityCurve = row && Array.isArray(row.points)
        ? { unit: row.unit, points: row.points as UtilityCurve['points'], max_value_sek_per_kwh: row.max_value_sek_per_kwh, urgent_price_multiplier: row.urgent_price_multiplier }
        : DEFAULT_VALUE_CURVES[key];
      nextStored[key] = curve;
      // Only a curve this editor generated can be read back exactly. Anything
      // else — the shipped defaults included — opens on a stated preference
      // rather than on an inference about what its breakpoints meant.
      const preference = preferenceFromCurve(curve) ?? defaultPreference(key);
      nextDrafts[key] = { preference, source: row ? 'customer' : 'default' };
    }
    const batteryRow = (data ?? []).find(entry => entry.store_key === 'battery');
    const battery = batteryRow ? parseStoredCurve(batteryRow) : null;
    const invalidBattery = typeof battery === 'string' ? battery : battery && validateBatteryCurve(battery);
    setBatteryLoadError(invalidBattery || null);
    const validBattery = typeof battery === 'string' || invalidBattery ? null : battery;
    if (validBattery) nextStored.battery = validBattery;
    const loadedSnapshot = source.snapshot as unknown as OptimisationSnapshot;
    const mode: BatteryMode = batteryRow?.generation_mode ?? (batteryRow ? 'custom' : 'balanced');
    let loadedBattery: BatteryDraft = { curve: mode === 'balanced'
      ? balancedBatteryCurve(loadedSnapshot, new Date((source.plan as unknown as OptimisationPlan).issued_at)) : validBattery, mode, edited: false };
    if (mode === 'price_only' && !invalidBattery) {
      setGeneratingBattery(true);
      setBatteryGenerationError(null);
      try {
        loadedBattery = { ...await priceOnlyDraft(homeId), edited: false };
      } catch (error) {
        loadedBattery.curve = null;
        setBatteryGenerationError(error instanceof Error ? error.message : String(error));
      } finally {
        setGeneratingBattery(false);
      }
    }
    setSavedBatteryDraft(loadedBattery);
    setBatteryDraft(current => current.edited ? current : loadedBattery);
    setStored(nextStored);
    setDrafts(current => Object.fromEntries(EDITABLE.map(key => [key, current[key]?.edited ? current[key] : nextDrafts[key]])));
    setLoading(false);
  }, [defaultPreference, homeId]);

  useEffect(() => { void load(); }, [load, planSnapshotId]);

  const edit = (key: ValueStoreKey, field: keyof StorePreference, value: string) =>
    setDrafts(current => {
      const draft = current[key];
      if (!draft) return current;
      setPreview(null);
      return {
        ...current,
        [key]: {
          ...draft,
          edited: true,
          preference: {
            ...draft.preference,
            [field]: numeric(value, draft.preference[field] ?? 0),
          },
        },
      };
    });

  const changePriceMode = (key: ValueStoreKey, mode: 'absolute' | 'relative') => {
    setPreview(null);
    setDrafts(current => {
      const draft = current[key];
      if (!draft) return current;
      const preference = preferenceWithPriceMode(draft.preference, mode, scales[key].reference_sek_per_kwh);
      if (preference.urgent_price_multiplier != null) {
        preference.urgent_price_multiplier = Number(preference.urgent_price_multiplier.toFixed(1));
      }
      return { ...current, [key]: { ...draft, edited: true, preference } };
    });
  };

  const save = async (key: DefaultValueStoreKey) => {
    if (refreshing || waitingForReplan || generatingBattery) return;
    const draft = drafts[key];
    if (!homeId || !customerId || !draft) return;
    const rejection = validatePreference(draft.preference);
    if (rejection) {
      toast({ title: t('Kunde inte spara', 'Could not save'), description: rejection, variant: 'destructive' });
      return;
    }
    const curve = curveOf(key, draft.preference);
    setSaving(key);
    const { error } = await supabase
      .from('energy_optimisation_value_curves')
      .upsert({
        customer_id: customerId,
        home_id: homeId,
        store_key: key,
        unit: curve.unit,
        points: curve.points,
        max_value_sek_per_kwh: curve.max_value_sek_per_kwh ?? null,
        urgent_price_multiplier: curve.urgent_price_multiplier ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'home_id,store_key' });
    setSaving(null);
    if (error) {
      toast({ title: t('Kunde inte spara', 'Could not save'), description: error.message, variant: 'destructive' });
      return;
    }
    setDrafts(current => ({ ...current, [key]: { ...current[key]!, edited: false } }));
    toast({ title: t('Sparad', 'Saved') });
    void load();
  };

  const reset = async (key: ValueStoreKey) => {
    if (refreshing || waitingForReplan || generatingBattery) return;
    if (!homeId) return;
    setSaving(key);
    const { error } = await supabase
      .from('energy_optimisation_value_curves')
      .delete()
      .eq('home_id', homeId)
      .eq('store_key', key);
    setSaving(null);
    if (error) { toast({ title: t('Kunde inte spara', 'Could not save'), description: error.message, variant: 'destructive' }); return; }
    if (key === 'battery') { setBatteryDraft({ curve: null, mode: 'balanced', edited: false }); setBatteryGenerationError(null); }
    else setDrafts(current => ({ ...current, [key]: { ...current[key]!, edited: false } }));
    toast({ title: t('Återställd till standard', 'Reset to default') });
    void load();
  };

  const generateBattery = async (mode: 'price_only' | 'balanced') => {
    if (!homeId || !snapshot || generatingBattery || saving) return;
    setBatteryGenerationError(null);
    setPreview(null);
    setGeneratingBattery(true);
    try {
      const draft = mode === 'price_only' ? await priceOnlyDraft(homeId) : {
        curve: balancedBatteryCurve(snapshot, new Date(sourcePlan!.issued_at)), mode, edited: true,
      };
      if (!draft.curve) throw new Error(t('Batterimätvärden saknas.', 'Battery measurements are missing.'));
      setBatteryDraft(draft);
    } catch (error) {
      setBatteryGenerationError(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingBattery(false);
    }
  };

  const saveBattery = async () => {
    if (refreshing || waitingForReplan || generatingBattery) return;
    if (!homeId || !customerId || !batteryDraft.curve || validateBatteryCurve(batteryDraft.curve)) return;
    const submitted = batteryDraft;
    setSaving('battery');
    const { error } = await supabase.from('energy_optimisation_value_curves').upsert({
      customer_id: customerId, home_id: homeId, store_key: 'battery', unit: 'kwh',
      points: submitted.curve!.points, generation_mode: submitted.mode,
      max_value_sek_per_kwh: null, urgent_price_multiplier: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'home_id,store_key' });
    setSaving(null);
    if (error) { toast({ title: t('Kunde inte spara', 'Could not save'), description: error.message, variant: 'destructive' }); return; }
    setBatteryDraft(current => current === submitted ? { ...current, edited: false } : current);
    setSavedBatteryDraft({ ...submitted, edited: false });
    toast({ title: t('Sparad för nästa plan', 'Saved for the next plan') });
    void load();
  };

  /** Compare with the same resolved forecast used to construct the charts. */
  const runPreview = async () => {
    if (!snapshot || !sourcePlan || generatingBattery || batteryGenerationError) return;
    setPreviewing(true);
    const edited: Partial<Record<ValueStoreKey, UtilityCurve>> = { ...stored };
    if (batteryDraft.curve) {
      const rejection = validateBatteryCurve(batteryDraft.curve);
      if (rejection) { setPreview(rejection); setPreviewing(false); return; }
      edited.battery = batteryDraft.curve;
    } else delete edited.battery;
    for (const key of EDITABLE) {
      const draft = drafts[key];
      if (draft?.edited && scales[key]) {
        const rejection = validatePreference(draft.preference);
        if (rejection) { setPreview(rejection); setPreviewing(false); return; }
        edited[key] = curveOf(key, draft.preference);
      }
    }
    const input = batteryDraft.comparisonInput;
    const comparisonSnapshot = input?.snapshot ?? snapshot;
    const current = { ...comparisonSnapshot.value_curves,
      ...(batteryValueCurve?.curve ? { battery: batteryValueCurve.curve } : {}),
    };
    setPreview(comparePreference(comparisonSnapshot, current, edited,
      input ? undefined : sourcePlan.price_outlook, input ? new Date(input.now) : undefined));
    setPreviewing(false);
  };

  const waitingForReplan = replanState(replan).status === 'waiting';

  if (!homeId) {
    return <p className="text-sm text-muted-foreground">{t('Välj ett hem.', 'Select a home.')}</p>;
  }
  if (loading) {
    return <div role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 aria-hidden="true" className="w-5 h-5 animate-spin" />
      {generatingBattery ? t('Hämtar den valda elkostnadskurvan…', 'Loading the selected electricity cost curve…') : t('Hämtar kurvor…', 'Loading curves…')}
    </div>;
  }

  if (curveError) return <Alert variant="destructive"><AlertDescription>{curveError}</AlertDescription></Alert>;

  const dirty = batteryDraft.edited || EDITABLE.some(key => {
    const draft = drafts[key];
    const base = stored[key];
    if (!draft || !base) return false;
    const from = preferenceFromCurve(base) ?? defaultPreference(key);
    return (
      from.urgent_below !== draft.preference.urgent_below ||
      from.comfortable !== draft.preference.comfortable ||
      from.indifferent_above !== draft.preference.indifferent_above ||
      from.max_value_sek_per_kwh !== draft.preference.max_value_sek_per_kwh ||
      from.urgent_price_multiplier !== draft.preference.urgent_price_multiplier
    );
  });
  return (
    <div className="space-y-4">
      <Alert>
        <TrendingDown className="w-4 h-4" />
        <AlertTitle>{t('Vad varje tjänst är värd för dig', 'What each service is worth to you')}</AlertTitle>
        <AlertDescription className="text-sm">
          {t(
            'Ange dina gränser och välj ett fast eller prognosrelativt högsta värde. Läs mer i hjälpen under varje kurva.',
            'Set your thresholds and choose a fixed or forecast-relative maximum. Expand the help below each curve for details.',
          )}
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" onClick={() => void runPreview()} disabled={previewing || generatingBattery || !!batteryGenerationError} variant="outline">
          {previewing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
          {t('Vad skulle ändras?', 'What would change?')}
        </Button>
      </div>

      {preview !== null && (
        <PreviewPanel preview={preview} dirty={dirty} />
      )}

      {batteryLoadError && <Alert variant="destructive">
        <AlertTitle>{t('Batterikurvan kan inte användas', 'The battery curve cannot be used')}</AlertTitle>
        <AlertDescription>{batteryLoadError}
          <Button variant="outline" className="ml-3" onClick={() => void reset('battery')}>{t('Ta bort ogiltig kurva och använd automatisk', 'Remove invalid curve and use automatic')}</Button>
        </AlertDescription>
      </Alert>}
      {!batteryLoadError && batteryValueCurve?.automatic_curve && (
        <Card data-testid="battery-curve-card" aria-busy={generatingBattery}>
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">{t('Hembatteriets värdekurva', 'Home battery value curve')}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{t('Ett högre värde gör lagrad energi mer värdefull att behålla. Kurvan anger inget klockslag eller laddningseffekt.', 'A higher value makes stored energy more valuable to retain. The curve does not set a time or charging power.')}</p>
            </div>
            <Badge variant="outline">{batteryDraft.mode === 'custom' ? t('Egen kurva', 'Your curve') : batteryDraft.mode === 'price_only' ? t('Lägsta elkostnad', 'Minimum electricity cost') : t('Kostnad och lagrad energi', 'Cost and stored energy')}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap justify-between gap-3">
              <p className="text-sm">{t('Användbar kapacitet', 'Usable capacity')}: {batteryValueCurve.usable_capacity_kwh.toFixed(3)} kWh</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" disabled={!batteryDraft.edited || generatingBattery || saving === 'battery'} onClick={() => { setBatteryDraft(savedBatteryDraft); setBatteryGenerationError(null); setPreview(null); }}>{t('Ångra ändringar', 'Discard edits')}</Button>
                <Button disabled={refreshing || waitingForReplan || generatingBattery || !batteryDraft.edited || saving === 'battery' || !batteryDraft.curve || !!validateBatteryCurve(batteryDraft.curve)} onClick={() => void saveBattery()}><Save className="mr-2 h-4 w-4" />{t('Spara', 'Save')}</Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="h-auto min-h-11 whitespace-normal" aria-pressed={batteryDraft.mode === 'price_only'} disabled={generatingBattery || saving === 'battery'} onClick={() => void generateBattery('price_only')}>{t('Minimera elkostnaden', 'Minimize electricity cost')}</Button>
              <Button variant="outline" className="h-auto min-h-11 whitespace-normal" aria-pressed={batteryDraft.mode === 'balanced'} disabled={generatingBattery || saving === 'battery'} onClick={() => void generateBattery('balanced')}>{t('Balansera kostnad och lagrad energi', 'Balance cost and stored energy')}</Button>
            </div>
            {generatingBattery && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t('Jämför kurvor med publicerade elpriser…', 'Comparing curves using published electricity prices…')}</p>}
            {batteryGenerationError && <Alert variant="destructive"><AlertTitle>{t('Kunde inte skapa batterikurvan', 'Could not generate the battery curve')}</AlertTitle><AlertDescription>{batteryGenerationError}</AlertDescription></Alert>}
            {batteryDraft.curve && <fieldset disabled={generatingBattery || saving === 'battery'} aria-disabled={generatingBattery || saving === 'battery'}
              className={generatingBattery || saving === 'battery' ? 'pointer-events-none opacity-60' : ''}
              onKeyDownCapture={event => { if ((generatingBattery || saving === 'battery') && event.key !== 'Tab') { event.preventDefault(); event.stopPropagation(); } }}>
              <PointCurveEditor current={batteryValueCurve.curve} next={batteryDraft.curve}
                capacity={batteryValueCurve.usable_capacity_kwh} state={batteryValueCurve.initial_state_kwh}
                onChange={curve => { if (generatingBattery || saving === 'battery') return; setBatteryDraft({ curve, mode: 'custom', edited: true, comparisonInput: batteryDraft.comparisonInput }); setBatteryGenerationError(null); setPreview(null); }} />
            </fieldset>}
            {batteryDraft.curve && validateBatteryCurve(batteryDraft.curve) && <p role="alert" className="text-sm text-destructive">{validateBatteryCurve(batteryDraft.curve)}</p>}
            <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{t('Om kurvvalen', 'About the curve choices')}</summary>
              <p className="mt-2">{t('Minimera elkostnaden väljer den billigaste prövade kurvan enbart efter elräkningen under kvartar med publicerade priser. Den kan lämna mindre energi i batteriet eller minska andra tjänster. Planerarens vanliga utrustnings- och tjänsteregler styr fortfarande varje provkörning. Sökningen garanterar inte ett globalt optimum. Kurvan behålls tills nya eller korrigerade elpriser publiceras.', 'Minimize electricity cost selects the cheapest tested curve by the electricity bill over published-price quarters only. It can leave less energy in the battery or reduce other services. The planner’s ordinary equipment and service rules still govern each trial. The search does not guarantee a global optimum. The curve is retained until new or corrected electricity prices are published.')}</p>
              <p className="mt-2">{t('Balansera kostnad och lagrad energi värderar också energin som finns kvar och beräknar en ny kurva med färska mätvärden för varje plan. Redigering av punkter väljer Egen kurva. Spara och planera om för att använda valet; den blå kurvan visar alltid den nuvarande planen.', 'Balance cost and stored energy also values retained energy and derives a fresh curve from new measurements for every plan. Editing points selects Your curve. Save and replan to apply the selection; the blue curve always shows the current plan.')}</p>
            </details>
          </CardContent>
        </Card>
      )}

      {sourcePlan && !sourcePlan.resolved_value_stores && <Alert><AlertDescription>{t(
        'Planen saknar sparade värdekurvor. Planera om för att visa vad planeraren använder.',
        'This plan has no recorded curve evidence. Replan to display the curves the planner uses.',
      )}</AlertDescription></Alert>}
      {EDITABLE.map(key => {
        const draft = drafts[key];
        if (!draft) return null;
        const plannedStore = plannedStores.find(store => store.key === key);
        if (!snapshot || !sourcePlan) return null;
        const conversion = scales[key]?.units_per_kwh ?? null;
        const canEdit = conversion !== null;
        const baselineCurve = plannedStore?.curve;
        if (!baselineCurve) return null;
        const rejection = validatePreference(draft.preference);
        const candidate = rejection || !canEdit ? null : draft.edited ? curveOf(key, draft.preference) : baselineCurve;
        const editedStore = candidate && plannedStore ? { curve:
          key === 'ev' && plannedStore.max_state !== undefined
            ? curveWithinReach(candidate, plannedStore.max_state) : candidate } : null;
        const isPool = key === 'pool';
        const unitSuffix = isPool ? '°C' : 'km';
        const absolute = draft.preference.max_value_sek_per_kwh != null;
        const multiplier = draft.preference.urgent_price_multiplier ?? DEFAULT_URGENT_PRICE_MULTIPLIER;
        const reference = plannedStore!.reference_sek_per_kwh;
        const state = plannedStore?.initial_state;
        const yUnit = canEdit ? 'SEK/kWh' : `SEK/${unitSuffix}`;
        const seriesName = t('Aktuell plan', 'Current plan');
        const changed = editedStore && JSON.stringify(editedStore.curve.points) !== JSON.stringify(baselineCurve.points);
        const points = [...baselineCurve.points, ...(changed ? editedStore.curve.points : [])];
        const first = Math.min(...points.map(p => p.at));
        const last = Math.max(...points.map(p => p.at));
        const span = Math.max(1, last - first);
        // Keep exact breakpoints, including the drop immediately past a charge limit.
        const positions = [...new Set([...Array.from({ length: 80 }, (_, index) => first - span * 0.15 + span * 1.3 * index / 79), ...points.flatMap(p => [p.at, p.at + 1e-7]), last, last + span * 0.15])].sort((a, b) => a - b);
        const chart = positions.map(at => ({
          at,
          sekPerKwh: marginalValue(baselineCurve, at) * (conversion ?? 1),
          ...(changed ? { editedSekPerKwh: marginalValue(editedStore.curve, at) * conversion! } : {}),
        }));


        const fields: Array<{ field: keyof StorePreference; label: [string, string]; hint: [string, string] }> = [
          {
            field: 'urgent_below',
            label: ['Stort behov under', 'Urgent below'],
            hint: ['Använder ditt högsta värde under denna gräns', 'Uses your maximum value below this threshold'],
          },
          {
            field: 'comfortable',
            label: ['Önskad nivå', 'Preferred level'],
            hint: ['Tar solöverskott och billig el, tackar nej till dyra timmar', 'Takes surplus and cheap grid, declines expensive hours'],
          },
          {
            field: 'indifferent_above',
            label: ['Sluta vid', 'Stop at'],
            hint: ['Värd noll — planeraren slutar bjuda', 'Worth nothing, so the store stops bidding'],
          },
        ];

        return (
          <Card key={key} data-testid={`value-curve-${key}`}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 px-4 py-3">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base">{isPool ? t('Pool', 'Pool') : t('Elbil', 'Vehicle')}</CardTitle>
                <Badge className="hidden sm:inline-flex" variant="outline">{t('I planen', 'In plan')}</Badge>
              </div>
              <div className="flex items-center gap-1">
                {draft.source === 'customer' && <Button size="sm" variant="ghost" onClick={() => void reset(key)} disabled={refreshing || waitingForReplan || generatingBattery || saving === key}>
                  {t('Återställ', 'Reset')}
                </Button>}
                <Button size="sm" onClick={() => void save(key)} disabled={refreshing || waitingForReplan || generatingBattery || !canEdit || saving === key || rejection !== null || !draft.edited}>
                  {saving === key ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                  {t('Spara', 'Save')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 px-4 pb-3">
              <fieldset disabled={!canEdit} className="grid grid-cols-3 gap-x-3 gap-y-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(180px,1.3fr)_minmax(100px,0.7fr)] disabled:opacity-60">
                {fields.map(({ field, label, hint }) => (
                  <label key={field} className="min-w-0 space-y-1" title={t(hint[0], hint[1])}>
                    <span className="block text-xs font-medium">{t(label[0], label[1])}</span>
                    <div className="relative">
                      <Input className="h-9 pr-10" aria-label={`${t(label[0], label[1])} (${unitSuffix})`}
                        value={String(draft.preference[field])} inputMode="decimal" step={STEP[key]} type="number"
                        onChange={event => edit(key, field, event.target.value)} />
                      <span className="pointer-events-none absolute right-3 top-2 text-xs text-muted-foreground">{unitSuffix}</span>
                    </div>
                    {!isPool && vehicleFullRangeKm != null && vehicleFullRangeKm > 0 && (() => {
                      const soc = numeric(String(draft.preference[field]), 0) / vehicleFullRangeKm;
                      const beyond = vehicleChargeLimitSoc != null && soc > vehicleChargeLimitSoc + 1e-9;
                      return <span className={`block text-[10px] tabular-nums ${beyond ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
                        {(soc * 100).toFixed(0)}% SOC{beyond && ` · ${t('över gränsen', 'above limit')} ${(vehicleChargeLimitSoc! * 100).toFixed(0)}%`}
                      </span>;
                    })()}
                  </label>
                ))}
                <label className="col-span-2 min-w-0 space-y-1 xl:col-span-1">
                  <span className="block text-xs font-medium">{t('Prismodell', 'Price basis')}</span>
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={absolute ? 'absolute' : 'relative'}
                    onChange={event => changePriceMode(key, event.target.value as 'absolute' | 'relative')}>
                    <option value="relative">{t('Prognos × faktor', 'Forecast × multiplier')}</option>
                    <option value="absolute">{t('Fast pris', 'Fixed price')}</option>
                  </select>
                </label>
                <label className="min-w-0 space-y-1">
                  <span className="block text-xs font-medium">{absolute ? t('Max SEK/kWh', 'Max SEK/kWh') : t('Faktor', 'Multiplier')}</span>
                  {absolute ? <Input type="number" min={0} step="any" className="h-9"
                    value={draft.preference.max_value_sek_per_kwh}
                    onChange={event => edit(key, 'max_value_sek_per_kwh', event.target.value)} />
                    : <MultiplierInput value={multiplier} onChange={value => edit(key, 'urgent_price_multiplier', value)} />}
                </label>
              </fieldset>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span>{absolute ? `${t('Fast max', 'Fixed maximum')}: ${draft.preference.max_value_sek_per_kwh?.toFixed(2)} SEK/kWh`
                  : `${multiplier.toFixed(1)} × ${reference.toFixed(2)} = ${(multiplier * reference).toFixed(2)} SEK/kWh`}</span>
                <span className="flex gap-3"><span className="text-blue-600">━ {seriesName}</span>{changed && <span className="text-orange-600">━ {t('Nästa plan', 'Next plan')}</span>}</span>
              </div>
              {rejection && <p className="text-xs text-destructive">{rejection}</p>}
              <div className="h-44 min-w-0" data-testid={`value-chart-${key}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 20, right: 48, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={value => Number(value).toFixed(isPool ? 1 : 0)} />
                    <YAxis tick={{ fontSize: 10 }} width={48} label={{ value: yUnit, angle: -90, position: 'insideLeft', fontSize: 10 }} />
                    <ChartTooltip formatter={(value: number, name: string) => [`${value.toFixed(2)} ${yUnit}`, name]}
                      labelFormatter={(label: number) => `${Number(label).toFixed(2)} ${unitSuffix}`} />
                    <Line isAnimationActive={false} type="linear" dataKey="sekPerKwh" name={seriesName} stroke="#2563eb" dot={false} strokeWidth={2} />
                    {changed && <Line isAnimationActive={false} type="linear" dataKey="editedSekPerKwh" name={t('Nästa plan', 'Next plan')} stroke="#ea580c" dot={false} strokeWidth={2} />}
                    {canEdit && typeof importPriceSekPerKwh === 'number' && <ReferenceLine y={importPriceSekPerKwh} stroke="#dc2626" strokeDasharray="4 4" label={{ value: t('Köp', 'Import'), fontSize: 10, fill: '#dc2626', position: 'right' }} />}
                    {canEdit && typeof exportPriceSekPerKwh === 'number' && <ReferenceLine y={exportPriceSekPerKwh} stroke="#059669" strokeDasharray="4 4" label={{ value: t('Sälj', 'Export'), fontSize: 10, fill: '#059669', position: 'right' }} />}
                    {typeof state === 'number' && <ReferenceLine x={state} stroke="#64748b" label={{ value: `${t('Nu', 'Now')} ${state.toFixed(1)} ${unitSuffix}`, fontSize: 10, position: 'top' }} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">{t('Om kurvan och utrustningen', 'About this curve and equipment')}</summary>
                <div className="space-y-1 pt-2">
                  {fields.map(({ field, label, hint }) => <p key={field}><strong>{t(label[0], label[1])}:</strong> {t(hint[0], hint[1])}</p>)}
                  <p>{t('Prognospriset är priset vid den billigaste tiondelen av horisonten. Faktorn räknas om för varje plan; fast pris behåller sitt värde.', 'The forecast reference is the cheapest-tenth price across the horizon. A multiplier is recalculated for every plan; a fixed price keeps its value.')}</p>
                  <p>{t('Raka segment modellerar avtagande värde. SEK/kWh visas vid planens ursprungliga verkningsgrad.', 'Straight segments model diminishing value. SEK/kWh is shown at the plan’s initial equipment efficiency.')}</p>
                  {conversion != null && <p>{isPool
                    ? `${(1 / conversion).toFixed(1)} kWh/°C · ${snapshot.pool?.volume_m3} m³ · COP ${(conversion * (snapshot.pool?.volume_m3 ?? 0) * WATER_KWH_PER_M3_K).toFixed(2)}`
                    : `${conversion.toFixed(1)} km/kWh · ${t('Kurvan slutar vid bilens laddgräns.', 'The curve ends at the vehicle’s charge limit.')}`}</p>}
                </div>
              </details>
            </CardContent>
          </Card>

        );
      })}
    </div>
  );
};

/** The consequence, in the four terms a household can judge. */
const PreviewPanel: React.FC<{ preview: PreviewComparison | string; dirty: boolean }> = ({ preview, dirty }) => {
  const { t } = useLanguage();
  if (typeof preview === 'string') {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t('Kunde inte förhandsräkna', 'Could not preview')}</AlertTitle>
        <AlertDescription className="text-sm">{preview}</AlertDescription>
      </Alert>
    );
  }

  const signed = (value: number, digits: number, unit: string) =>
    `${value > 0 ? '+' : ''}${value.toFixed(digits)} ${unit}`;
  const moved = preview.stores.filter(store =>
    Math.abs(store.runHoursAfter - store.runHoursBefore) > 1e-9 ||
    Math.abs(store.kwhAfter - store.kwhBefore) > 1e-9
  );
  const stateUnit = (unit: string) => (unit === 'celsius' ? '°C' : unit === 'km' ? 'km' : 'kWh');

  return (
    <Card data-testid="curve-preview" className="border-primary/40 bg-primary/[0.03]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('Vad som skulle ändras', 'What would change')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!dirty && (
          <p className="text-sm text-muted-foreground">
            {t(
              'Inget är ändrat ännu — detta är alltså skillnaden mot sig själv. Ändra ett tal och räkna om.',
              'Nothing is edited yet, so this is the difference against itself. Change a number and run it again.',
            )}
          </p>
        )}
        {moved.length === 0 && dirty && (
          <p className="text-sm text-muted-foreground">
            {t(
              'Ingen lagring ändrar beteende med den här ändringen — gränsen ligger inte där beslutet avgörs.',
              'No store changes behaviour with this edit: the threshold is not where the decision turns.',
            )}
          </p>
        )}
        {moved.map(store => (
          <p key={store.key} className="text-sm">
            <span className="font-medium capitalize">{store.key}</span>{': '}
            {signed(store.runHoursAfter - store.runHoursBefore, 1, t('timmar', 'hours'))}
            {', '}
            {signed(store.kwhAfter - store.kwhBefore, 1, 'kWh')}
            {store.endStateAfter !== null && store.endStateBefore !== null && (
              <span className="text-muted-foreground">
                {t(' — slutar på ', ' — ends at ')}
                {store.endStateAfter.toFixed(1)} {stateUnit(store.unit)}
                {t(' i stället för ', ' instead of ')}
                {store.endStateBefore.toFixed(1)} {stateUnit(store.unit)}
              </span>
            )}
          </p>
        ))}
        <div className="flex flex-wrap gap-4 border-t pt-3 text-sm">
          <span>
            <span className="text-muted-foreground">{t('Nätimport ', 'Grid import ')}</span>
            <span className="font-medium tabular-nums">{signed(preview.importDeltaKwh, 1, 'kWh')}</span>
          </span>
          <span>
            <span className="text-muted-foreground">{t('Nätexport ', 'Grid export ')}</span>
            <span className="font-medium tabular-nums">{signed(preview.exportDeltaKwh, 1, 'kWh')}</span>
          </span>
          <span>
            <span className="text-muted-foreground">{t('Nettokostnad ', 'Net cost ')}</span>
            <span className={`font-medium tabular-nums ${preview.costDeltaSek > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
              {signed(preview.costDeltaSek, 2, 'SEK')}
            </span>
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t(
            'Jämförelsen omfattar endast kvartar med publicerade priser, med planerarens egen kod. Energianvändning och slutvärden gäller samma period; prognospriser ingår inte. Spara och planera om för att använda kurvan i hela 72-timmarsplanen.',
            'Compared only over quarters with published prices, using the planner’s own code. Energy use and end states cover that same window; forecast price padding is excluded. Save and replan to apply the curve to the full 72-hour plan.',
          )}
        </p>
      </CardContent>
    </Card>
  );
};

export default ValueCurvesTab;
