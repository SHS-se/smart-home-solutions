// What each service is worth, stated as three thresholds instead of a curve.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §8.3 and §8.10. The previous editor here
// asked for the curve directly — a table of "at this level, one unit is worth
// this many kronor" — and nobody can hold that opinion. The shipped pool curve
// values a degree at 80 SEK falling to zero, and knowing whether 80 is sane
// requires knowing first that a 55 m³ pool takes about 14 kWh per degree. That
// is arithmetic, not taste, and asking a household for it guarantees either an
// untouched default or a number picked at random.
//
// So the editor asks for the three thresholds people actually hold — really
// want it below here, would like it around here, do not care above here — and
// `value-preferences.ts` supplies the levels from the physics. And because a
// threshold is still abstract until you see what it does, the panel re-solves
// the persisted snapshot with the edited curve and reports the difference in
// hours, kilowatt-hours, kronor and where the store ends up.

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
import { Loader2, RefreshCw, Save, Sparkles, TrendingDown } from 'lucide-react';
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
} from '../../../../supabase/functions/_shared/value-curves';
import {
  marginalValue,
  type UtilityCurve,
} from '../../../../supabase/functions/_shared/store-value';
import { WATER_KWH_PER_M3_K } from '../../../../supabase/functions/_shared/store-models';
import {
  curveFromPreference,
  DEFAULT_POOL_PREFERENCE,
  DEFAULT_REFERENCE_SEK_PER_KWH,
  preferenceFromCurve,
  validatePreference,
  vehiclePreference,
  type StorePreference,
} from '../../../../supabase/functions/_shared/value-preferences';
import type { OptimisationSnapshot } from '../../../../supabase/functions/_shared/energy-optimisation';
import { comparePreference, type PreviewComparison } from '@/lib/energy-shift/curve-preview';
import type { BatteryValueCurveDiagnostic } from '@/lib/energy-shift/contracts';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import { formatHomeStamp, formatHomeTimeWithSeconds } from '@/lib/energy-shift/home-time';

interface Props {
  customerId: string | null;
  homeId: string | null;
  /** All-in prices from the live plan, so the chart compares like with like. */
  importPriceSekPerKwh?: number | null;
  exportPriceSekPerKwh?: number | null;
  /** Live state, so the chart can mark where the store actually sits. */
  poolTemperatureC?: number | null;
  vehicleRangeKm?: number | null;
  /** The range the customer's own charge limit asks for, anchoring the curve. */
  vehicleTargetRangeKm?: number | null;
  /** Range at 100% SOC, so a kilometre threshold can be read as a percentage. */
  vehicleFullRangeKm?: number | null;
  /** The charge limit the car enforces, as a fraction. */
  vehicleChargeLimitSoc?: number | null;
  /** Reviewed installation figures, so the physics is this home's own. */
  poolVolumeM3?: number | null;
  vehicleChargeEfficiency?: number | null;
  /** Exact read-only curve published by the current planner solve. */
  batteryValueCurve?: BatteryValueCurveDiagnostic | null;
}

const EDITABLE: ValueStoreKey[] = ['pool', 'ev'];

/** Seeded until a fitted figure exists, matching the planner's own assumptions. */
const SEEDED_POOL_COP = 4.6;
const SEEDED_VEHICLE_KWH_PER_KM = 0.16;

interface Draft {
  preference: StorePreference;
  source: 'customer' | 'default';
}

type Drafts = Partial<Record<ValueStoreKey, Draft>>;

const STEP: Record<ValueStoreKey, number> = { pool: 0.5, ev: 10, hot_water: 100 };

const numeric = (value: string, fallback: number) => {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ValueCurvesTab: React.FC<Props> = ({
  customerId,
  homeId,
  importPriceSekPerKwh,
  exportPriceSekPerKwh,
  poolTemperatureC,
  vehicleRangeKm,
  vehicleTargetRangeKm,
  vehicleFullRangeKm,
  vehicleChargeLimitSoc,
  poolVolumeM3,
  vehicleChargeEfficiency,
  batteryValueCurve,
}) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [stored, setStored] = useState<Partial<Record<ValueStoreKey, UtilityCurve>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [replanning, setReplanning] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewComparison | string | null>(null);
  const [snapshot, setSnapshot] = useState<OptimisationSnapshot | null>(null);

  /**
   * How many physical units one kWh of electricity buys, on this home's kit.
   *
   * The conversion that makes a threshold comparable to a price at all, and the
   * reason the customer never has to state a level: they say where the
   * threshold is, this says what it is worth.
   */
  const scales = useMemo(() => {
    const reference = typeof importPriceSekPerKwh === 'number' && importPriceSekPerKwh > 0
      ? importPriceSekPerKwh
      : DEFAULT_REFERENCE_SEK_PER_KWH;
    const volume = poolVolumeM3 && poolVolumeM3 > 0 ? poolVolumeM3 : 55;
    return {
      pool: {
        units_per_kwh: SEEDED_POOL_COP / (volume * WATER_KWH_PER_M3_K),
        reference_sek_per_kwh: reference,
      },
      ev: {
        units_per_kwh: (vehicleChargeEfficiency ?? 0.9) / SEEDED_VEHICLE_KWH_PER_KM,
        reference_sek_per_kwh: reference,
      },
    } as const;
  }, [importPriceSekPerKwh, poolVolumeM3, vehicleChargeEfficiency]);

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
    (key: ValueStoreKey, preference: StorePreference) =>
      curveFromPreference(preference, DEFAULT_VALUE_CURVES[key].unit, scales[key]),
    [scales],
  );

  const load = useCallback(async () => {
    if (!homeId) return;
    setLoading(true);
    setPreview(null);
    const { data } = await supabase
      .from('energy_optimisation_value_curves')
      .select('store_key, unit, points')
      .eq('home_id', homeId);
    const nextDrafts: Drafts = {};
    const nextStored: Partial<Record<ValueStoreKey, UtilityCurve>> = {};
    for (const key of EDITABLE) {
      const row = (data ?? []).find(entry => entry.store_key === key);
      const curve: UtilityCurve = row && Array.isArray(row.points)
        ? { unit: row.unit, points: row.points as UtilityCurve['points'] }
        : DEFAULT_VALUE_CURVES[key];
      nextStored[key] = curve;
      // Only a curve this editor generated can be read back exactly. Anything
      // else — the shipped defaults included — opens on a stated preference
      // rather than on an inference about what its breakpoints meant.
      const preference = preferenceFromCurve(curve) ?? defaultPreference(key);
      nextDrafts[key] = { preference, source: row ? 'customer' : 'default' };
    }
    setStored(nextStored);
    setDrafts(nextDrafts);
    setLoading(false);
  }, [defaultPreference, homeId]);

  useEffect(() => { void load(); }, [load]);

  const edit = (key: ValueStoreKey, field: keyof StorePreference, value: string) =>
    setDrafts(current => {
      const draft = current[key];
      if (!draft) return current;
      setPreview(null);
      return {
        ...current,
        [key]: {
          ...draft,
          preference: {
            ...draft.preference,
            [field]: numeric(value, draft.preference[field]),
          },
        },
      };
    });

  const save = async (key: ValueStoreKey) => {
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
        updated_at: new Date().toISOString(),
      }, { onConflict: 'home_id,store_key' });
    setSaving(null);
    if (error) {
      toast({ title: t('Kunde inte spara', 'Could not save'), description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: t('Sparad', 'Saved') });
    void load();
  };

  const reset = async (key: ValueStoreKey) => {
    if (!homeId) return;
    setSaving(key);
    await supabase
      .from('energy_optimisation_value_curves')
      .delete()
      .eq('home_id', homeId)
      .eq('store_key', key);
    setSaving(null);
    toast({ title: t('Återställd till standard', 'Reset to default') });
    void load();
  };

  /**
   * Re-solve the persisted snapshot with the edited thresholds.
   *
   * The snapshot is fetched only when asked for: it carries 288 slots plus the
   * device and zone models, and loading that on every page view to support a
   * button most visits never press would be a poor trade.
   */
  const runPreview = async () => {
    if (!homeId) return;
    setPreviewing(true);
    let source = snapshot;
    if (!source) {
      const { data, error } = await supabase
        .from('energy_optimisation_current')
        .select('snapshot')
        .eq('home_id', homeId)
        .maybeSingle();
      if (error || !data?.snapshot) {
        setPreviewing(false);
        setPreview(t(
          'Ingen sparad ögonblicksbild att räkna om mot.',
          'No stored snapshot to re-solve against.',
        ));
        return;
      }
      source = data.snapshot as unknown as OptimisationSnapshot;
      setSnapshot(source);
    }
    const edited: Partial<Record<ValueStoreKey, UtilityCurve>> = { ...stored };
    for (const key of EDITABLE) {
      const draft = drafts[key];
      if (draft) edited[key] = curveOf(key, draft.preference);
    }
    setPreview(comparePreference(source, stored, edited));
    setPreviewing(false);
  };

  const replan = async () => {
    if (!homeId) return;
    setReplanning(true);
    const { data, error } = await supabase.functions.invoke('energy-optimisation-replan', {
      body: { home_id: homeId },
    });
    setReplanning(false);
    if (error) {
      // supabase-js reports only "non-2xx status code" for a failed call, so
      // the function's own explanation has to be read off the response body.
      let detail = error.message;
      const response = (error as { context?: Response }).context;
      if (response && typeof response.json === 'function') {
        try {
          const body = await response.json();
          detail = body?.detail ?? body?.error ?? detail;
        } catch {
          // Keep the generic message rather than replacing it with a parse error.
        }
      }
      toast({ title: t('Kunde inte planera om', 'Could not replan'), description: detail, variant: 'destructive' });
      return;
    }
    toast({
      title: t('Planen är omräknad', 'Plan rebuilt'),
      description: `${data?.status ?? ''} · ${formatHomeTimeWithSeconds(data?.issued_at ?? Date.now(), homeTimeZone)}`,
    });
  };

  if (!homeId) {
    return <p className="text-sm text-muted-foreground">{t('Välj ett hem.', 'Select a home.')}</p>;
  }
  if (loading) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  }

  const dirty = EDITABLE.some(key => {
    const draft = drafts[key];
    const base = stored[key];
    if (!draft || !base) return false;
    const from = preferenceFromCurve(base) ?? defaultPreference(key);
    return (
      from.urgent_below !== draft.preference.urgent_below ||
      from.comfortable !== draft.preference.comfortable ||
      from.indifferent_above !== draft.preference.indifferent_above
    );
  });
  const batteryChart = batteryValueCurve?.curve.points.length
    ? [
      {
        at: 0,
        sekPerStoredKwh: batteryValueCurve.curve.points[0].sek_per_unit,
      },
      ...batteryValueCurve.curve.points.map(point => ({
        at: point.at,
        sekPerStoredKwh: point.sek_per_unit,
      })),
    ]
    : [];
  const coveringStart = batteryValueCurve?.covering_window.find(
    slice => slice.residual_load_ac_kwh > 0,
  )?.start ?? null;
  const coveringEndStart = [...(batteryValueCurve?.covering_window ?? [])]
    .reverse()
    .find(slice => slice.residual_load_ac_kwh > 0)?.start ?? null;

  return (
    <div className="space-y-4">
      <Alert>
        <TrendingDown className="w-4 h-4" />
        <AlertTitle>{t('Vad varje tjänst är värd för dig', 'What each service is worth to you')}</AlertTitle>
        <AlertDescription className="text-sm">
          {t(
            'Tre tal per tjänst, i den enhet du själv tänker i. Planeraren räknar om dem till kronor per kWh el med husets egen fysik, och jämför sedan mot köp- och säljpriset. Du behöver aldrig ange ett värde per grad eller per kilometer.',
            'Three numbers per service, in the unit you think in. The planner converts them into SEK per kWh of electricity using your own equipment, then compares that with the import and export price. You never state a value per degree or per kilometre.',
          )}
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => void runPreview()} disabled={previewing} variant="outline">
          {previewing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
          {t('Vad skulle ändras?', 'What would change?')}
        </Button>
        <Button onClick={() => void replan()} disabled={replanning} variant="secondary">
          {replanning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          {t('Planera om nu', 'Replan now')}
        </Button>
      </div>

      {preview !== null && (
        <PreviewPanel preview={preview} dirty={dirty} />
      )}

      {batteryValueCurve && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">
                {t('Hembatteriets härledda värdekurva', 'Derived home-battery value curve')}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  'Tillståndet är användbar lagrad energi över minsta SOC. Varje punkt i diagrammet är en exakt brytpunkt ur den aktuella planen — håll muspekaren över den för att läsa av den.',
                  'State is usable stored energy above minimum SOC. Every dot on the chart is an exact breakpoint from the current plan — hover one to read it off.',
                )}
              </p>
            </div>
            <Badge variant="outline">{t('Skrivskyddad', 'Read-only')}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">{t('Starttillstånd', 'Initial state')}</div>
                <div className="font-semibold tabular-nums">{batteryValueCurve.initial_state_kwh.toFixed(3)} kWh</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">{t('Användbar kapacitet', 'Usable capacity')}</div>
                <div className="font-semibold tabular-nums">{batteryValueCurve.usable_capacity_kwh.toFixed(3)} kWh</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">{t('Dimensionerande underskott', 'Covering requirement')}</div>
                <div className="font-semibold tabular-nums">{batteryValueCurve.curve_input.expected_draw_kwh.toFixed(3)} kWh</div>
                {coveringStart && coveringEndStart && (
                  <div className="text-[10px] text-muted-foreground">
                    {formatHomeStamp(coveringStart, homeTimeZone)} – {formatHomeStamp(Date.parse(coveringEndStart) + 15 * 60_000, homeTimeZone)}
                  </div>
                )}
              </div>
              <div className="rounded-md border p-2">
                <div className="text-muted-foreground">{t('Kurvans antaganden', 'Curve inputs')}</div>
                <div className="font-semibold tabular-nums">
                  {(batteryValueCurve.curve_input.discharge_efficiency * 100).toFixed(1)}% {t('urladdningsverkningsgrad', 'discharge efficiency')}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {batteryValueCurve.curve_input.future_surplus_kwh.toFixed(2)} kWh {t('prognostiserat överskott', 'forecast surplus')} · {batteryValueCurve.curve_input.degradation_sek_per_kwh.toFixed(3)} SEK/kWh {t('slitage', 'degradation')}
                </div>
              </div>
            </div>

            {batteryChart.length > 0 ? (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={batteryChart} margin={{ top: 12, right: 16, bottom: 12, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis
                      dataKey="at"
                      type="number"
                      domain={[0, batteryValueCurve.usable_capacity_kwh]}
                      tick={{ fontSize: 11 }}
                      label={{ value: t('Användbar lagrad energi (kWh)', 'Usable stored energy (kWh)'), position: 'insideBottom', offset: -8, fontSize: 11 }}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      width={60}
                      label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }}
                    />
                    <ChartTooltip
                      formatter={(value: number) => [`${value.toFixed(4)} SEK/kWh`, t('Behållet värde', 'Retained value')]}
                      labelFormatter={(label: number) => `${Number(label).toFixed(4)} kWh`}
                    />
                    <ReferenceLine
                      x={batteryValueCurve.initial_state_kwh}
                      stroke="#64748b"
                      strokeDasharray="4 4"
                      label={{ value: t('Start', 'Initial'), fontSize: 10, position: 'top' }}
                    />
                    <Line
                      type="linear"
                      dataKey="sekPerStoredKwh"
                      name={t('Behållet värde', 'Retained value')}
                      stroke="#7c3aed"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: '#7c3aed' }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('Planeraren kunde inte härleda någon batterivärdekurva.', 'The planner could not derive a battery value curve.')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {EDITABLE.map(key => {
        const draft = drafts[key];
        if (!draft) return null;
        const rejection = validatePreference(draft.preference);
        const curve = rejection ? null : curveOf(key, draft.preference);
        const isPool = key === 'pool';
        const unitSuffix = isPool ? '°C' : 'km';
        const state = isPool ? poolTemperatureC : vehicleRangeKm;
        const perUnitKwh = 1 / scales[key].units_per_kwh;

        // Sampled across the curve's own range so the shape is visible, in the
        // units the prices are quoted in — the only footing on which a
        // threshold and a tariff can be compared.
        const chart = curve
          ? Array.from({ length: 80 }, (_value, step) => {
            const first = curve.points[0].at;
            const last = curve.points[curve.points.length - 1].at;
            const span = Math.max(1e-6, last - first);
            const at = first - span * 0.15 + (span * 1.3 * step) / 79;
            return {
              at: Number(at.toFixed(2)),
              sekPerKwh: Number(
                (marginalValue(curve, at) * scales[key].units_per_kwh).toFixed(4),
              ),
            };
          })
          : [];

        const fields: Array<{ field: keyof StorePreference; label: [string, string]; hint: [string, string] }> = [
          {
            field: 'urgent_below',
            label: isPool ? ['Under detta vill jag ha värme', 'Below this I really want heat'] : ['Under detta vill jag alltid ladda', 'Below this I always want to charge'],
            hint: ['Planeraren köper el även dyrt', 'The planner buys energy even when it is dear'],
          },
          {
            field: 'comfortable',
            label: isPool ? ['Så varm vill jag ha den', 'This is where I want it'] : ['Så mycket räckvidd vill jag ha', 'This is the range I want'],
            hint: ['Tar solöverskott och billig el, tackar nej till dyra timmar', 'Takes surplus and cheap grid, declines expensive hours'],
          },
          {
            field: 'indifferent_above',
            label: isPool ? ['Över detta behövs inget mer', 'Above this, do not bother'] : ['Över detta behövs ingen mer laddning', 'Above this, no more charging is needed'],
            hint: ['Värd noll — planeraren slutar bjuda', 'Worth nothing, so the store stops bidding'],
          },
        ];

        return (
          <Card key={key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {isPool ? t('Pool', 'Pool') : t('Elbil', 'Vehicle')}
              </CardTitle>
              <Badge variant={draft.source === 'customer' ? 'secondary' : 'outline'}>
                {draft.source === 'customer' ? t('Egna inställningar', 'Your settings') : t('Standard', 'Default')}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                {fields.map(({ field, label, hint }) => (
                  <label key={field} className="space-y-1">
                    <span className="block text-sm font-medium">{t(label[0], label[1])}</span>
                    <div className="flex items-center gap-2">
                      <Input
                        value={String(draft.preference[field])}
                        inputMode="decimal"
                        step={STEP[key]}
                        type="number"
                        onChange={event => edit(key, field, event.target.value)}
                      />
                      <span className="text-sm text-muted-foreground">{unitSuffix}</span>
                    </div>
                    {!isPool && vehicleFullRangeKm !== null && vehicleFullRangeKm > 0 && (() => {
                      // The hardware enforces a state of charge; the curve is
                      // stated in kilometres. A threshold beyond the charge
                      // limit is one the car can never reach, so the store
                      // never stops bidding — and in kilometres alone that is
                      // invisible.
                      const soc = numeric(String(draft.preference[field]), 0) / vehicleFullRangeKm;
                      const beyond = vehicleChargeLimitSoc !== null &&
                        soc > vehicleChargeLimitSoc + 1e-9;
                      return (
                        <span className={`block text-[11px] tabular-nums ${
                          beyond ? 'text-destructive font-medium' : 'text-muted-foreground'
                        }`}>
                          {`= ${(soc * 100).toFixed(0)}% SOC`}
                          {beyond && ` · ${t('över laddgränsen', 'past the charge limit')} ${
                            ((vehicleChargeLimitSoc ?? 0) * 100).toFixed(0)}%`}
                        </span>
                      );
                    })()}
                    <span className="block text-[11px] text-muted-foreground">{t(hint[0], hint[1])}</span>
                  </label>
                ))}
              </div>

              {rejection && (
                <p className="text-sm text-destructive">{rejection}</p>
              )}

              <p className="text-xs text-muted-foreground">
                {isPool
                  ? t(
                    `Din pool tar ca ${perUnitKwh.toFixed(1)} kWh per grad (${(poolVolumeM3 ?? 55)} m³, COP ${SEEDED_POOL_COP}). Det är därför en grad är värd mer här än i en liten pool — du anger bara gränserna.`,
                    `Your pool takes about ${perUnitKwh.toFixed(1)} kWh per degree (${(poolVolumeM3 ?? 55)} m³, COP ${SEEDED_POOL_COP}). That is why a degree is worth more here than in a small pool — you only state the thresholds.`,
                  )
                  : t(
                    `En kWh el ger ca ${scales.ev.units_per_kwh.toFixed(1)} km räckvidd. På vintern räcker samma laddning kortare, så samma gränser gör bilen viktigare utan att du ändrar något.`,
                    `One kWh of electricity buys about ${scales.ev.units_per_kwh.toFixed(1)} km of range, and a full battery is about ${(vehicleFullRangeKm ?? 0).toFixed(0)} km — so ${vehicleChargeLimitSoc !== null ? `your ${(vehicleChargeLimitSoc * 100).toFixed(0)}% charge limit is about ${((vehicleFullRangeKm ?? 0) * vehicleChargeLimitSoc).toFixed(0)} km. ` : ''}A threshold above that is one the car can never reach, so it never stops being worth charging. In winter the same charge goes less far, so the same thresholds make the car matter more without you changing anything.`,
                  )}
              </p>

              {chart.length > 0 && (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 20, right: 60, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="at"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis tick={{ fontSize: 11 }} width={56} label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                      <ChartTooltip
                        formatter={(value: number) => [`${value.toFixed(2)} SEK/kWh`, t('Värde', 'Value')]}
                        labelFormatter={(label: number) => `${label} ${unitSuffix}`}
                      />
                      <Line type="linear" dataKey="sekPerKwh" stroke="#2563eb" dot={false} strokeWidth={2} />
                      {typeof importPriceSekPerKwh === 'number' && (
                        <ReferenceLine y={importPriceSekPerKwh} stroke="#dc2626" strokeDasharray="4 4" label={{ value: t('Köppris', 'Import'), fontSize: 11, fill: '#dc2626', position: 'right' }} />
                      )}
                      {typeof exportPriceSekPerKwh === 'number' && (
                        <ReferenceLine y={exportPriceSekPerKwh} stroke="#059669" strokeDasharray="4 4" label={{ value: t('Säljpris', 'Export'), fontSize: 11, fill: '#059669', position: 'right' }} />
                      )}
                      {typeof state === 'number' && (
                        <ReferenceLine x={state} stroke="#64748b" label={{ value: `${t('Nu', 'Now')} ${state.toFixed(1)} ${unitSuffix}`, fontSize: 11, fill: '#475569', position: 'top' }} />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <Button onClick={() => void save(key)} disabled={saving === key || rejection !== null}>
                  {saving === key ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  {t('Spara', 'Save')}
                </Button>
                {draft.source === 'customer' && (
                  <Button variant="ghost" onClick={() => void reset(key)} disabled={saving === key}>
                    {t('Återställ standard', 'Reset to default')}
                  </Button>
                )}
              </div>
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
    <Card className="border-primary/40 bg-primary/[0.03]">
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
            'Räknat över hela planens 72 timmar med samma väder och priser som den sparade ögonblicksbilden, med planerarens egen kod. Spara och planera om för att verkligen använda ändringen.',
            'Solved over the plan’s full 72 hours against the stored snapshot’s own weather and prices, using the planner’s own code. Save and replan to actually apply the change.',
          )}
        </p>
      </CardContent>
    </Card>
  );
};

export default ValueCurvesTab;
