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
import { Loader2, Plus, RefreshCw, Save, Trash2, TrendingDown } from 'lucide-react';
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
  validateCurve,
  type UtilityCurve,
} from '../../../../supabase/functions/_shared/store-value';
import { WATER_KWH_PER_M3_K } from '../../../../supabase/functions/_shared/store-models';

interface Props {
  customerId: string | null;
  homeId: string | null;
  /** All-in prices from the live plan, so the chart compares like with like. */
  importPriceSekPerKwh?: number | null;
  exportPriceSekPerKwh?: number | null;
  /** Live state, so the chart can mark where the store actually sits. */
  poolTemperatureC?: number | null;
  vehicleRangeKm?: number | null;
}

interface Draft {
  points: { at: string; sek_per_unit: string }[];
  source: 'customer' | 'default';
}

const EDITABLE: ValueStoreKey[] = ['pool', 'ev'];

/**
 * How many physical units one kWh of electricity buys.
 *
 * This is the conversion that makes a curve comparable to a price at all: the
 * curve is in SEK per degree or per kilometre, while every price is in SEK per
 * kWh. A pool degree looks expensive until you notice a kWh only moves 55 m³ of
 * water by about a fourteenth of one.
 *
 * Both figures are the planner's own seeded assumptions — a COP of 4.6 and
 * 0.16 kWh/km — so the chart shows the same arithmetic the planner used rather
 * than a second, prettier one.
 */
const UNITS_PER_KWH: Record<ValueStoreKey, number> = {
  pool: 4.6 / (55 * WATER_KWH_PER_M3_K),
  ev: 0.92 / 0.16,
  hot_water: 1,
};

const UNIT_TEXT: Record<string, { level: [string, string]; per: [string, string] }> = {
  celsius: { level: ['Vattentemperatur (°C)', 'Water temperature (°C)'], per: ['SEK per °C', 'SEK per °C'] },
  km: { level: ['Räckvidd (km)', 'Range (km)'], per: ['SEK per km', 'SEK per km'] },
  litre_degrees: { level: ['Litergrader', 'Litre-degrees'], per: ['SEK per litergrad', 'SEK per litre-degree'] },
};

/** What one kWh of electricity actually buys, in the store's own units. */
const CONVERSION_TEXT: Record<ValueStoreKey, { sv: string; en: string }> = {
  pool: {
    sv: `En kWh el höjer poolen ca ${(UNITS_PER_KWH.pool).toFixed(3)} °C — det krävs alltså ${(1 / UNITS_PER_KWH.pool).toFixed(1)} kWh per grad (55 m³, COP 4,6).`,
    en: `One kWh of electricity raises the pool about ${(UNITS_PER_KWH.pool).toFixed(3)} °C, so a degree takes ${(1 / UNITS_PER_KWH.pool).toFixed(1)} kWh (55 m³, COP 4.6).`,
  },
  ev: {
    sv: `En kWh el ger ca ${(UNITS_PER_KWH.ev).toFixed(1)} km räckvidd (0,16 kWh/km, 92 % laddverkningsgrad).`,
    en: `One kWh of electricity buys about ${(UNITS_PER_KWH.ev).toFixed(1)} km of range (0.16 kWh/km, 92% charging efficiency).`,
  },
  hot_water: { sv: '', en: '' },
};

const toDraft = (curve: UtilityCurve): Draft => ({
  points: curve.points.map(point => ({
    at: String(point.at),
    sek_per_unit: String(point.sek_per_unit),
  })),
  source: 'default',
});

const ValueCurvesTab: React.FC<Props> = ({
  customerId,
  homeId,
  importPriceSekPerKwh,
  exportPriceSekPerKwh,
  poolTemperatureC,
  vehicleRangeKm,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [replanning, setReplanning] = useState(false);

  const load = useCallback(async () => {
    if (!homeId) return;
    setLoading(true);
    const { data } = await supabase
      .from('energy_optimisation_value_curves')
      .select('store_key, unit, points')
      .eq('home_id', homeId);
    const next: Record<string, Draft> = {};
    for (const key of EDITABLE) {
      const row = (data ?? []).find(entry => entry.store_key === key);
      if (row && Array.isArray(row.points)) {
        next[key] = {
          points: (row.points as { at: number; sek_per_unit: number }[]).map(point => ({
            at: String(point.at),
            sek_per_unit: String(point.sek_per_unit),
          })),
          source: 'customer',
        };
      } else {
        next[key] = toDraft(DEFAULT_VALUE_CURVES[key]);
      }
    }
    setDrafts(next);
    setLoading(false);
  }, [homeId]);

  useEffect(() => { void load(); }, [load]);

  const parse = (draft: Draft, key: ValueStoreKey): UtilityCurve | string => {
    const points = draft.points.map(point => ({
      at: Number(point.at),
      sek_per_unit: Number(point.sek_per_unit),
    }));
    if (points.some(point => !Number.isFinite(point.at) || !Number.isFinite(point.sek_per_unit))) {
      return t('Alla fält måste vara tal.', 'Every field must be a number.');
    }
    const curve: UtilityCurve = { unit: DEFAULT_VALUE_CURVES[key].unit, points };
    const rejection = validateCurve(curve);
    if (!rejection) return curve;
    if (rejection.reason === 'not_concave') {
      return t(
        'Värdet måste falla när nivån stiger — en högre nivå kan inte vara värd mer per enhet.',
        'Value must fall as the level rises — a fuller store cannot be worth more per unit.',
      );
    }
    if (rejection.reason === 'unsorted') {
      return t('Nivåerna måste stiga rad för rad.', 'Levels must increase row by row.');
    }
    return t('Kurvan är ogiltig.', 'The curve is invalid.');
  };

  const save = async (key: ValueStoreKey) => {
    if (!homeId || !customerId) return;
    const parsed = parse(drafts[key], key);
    if (typeof parsed === 'string') {
      toast({ title: t('Kunde inte spara', 'Could not save'), description: parsed, variant: 'destructive' });
      return;
    }
    setSaving(key);
    const { error } = await supabase
      .from('energy_optimisation_value_curves')
      .upsert({
        customer_id: customerId,
        home_id: homeId,
        store_key: key,
        unit: parsed.unit,
        points: parsed.points,
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
      // Without this the first failure of this button said nothing at all.
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
      toast({
        title: t('Kunde inte planera om', 'Could not replan'),
        description: detail,
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: t('Planen är omräknad', 'Plan rebuilt'),
      description: `${data?.status ?? ''} · ${new Date(data?.issued_at ?? Date.now()).toLocaleTimeString()}`,
    });
  };

  const editRow = (key: ValueStoreKey, index: number, field: 'at' | 'sek_per_unit', value: string) =>
    setDrafts(current => {
      const next = { ...current };
      const points = [...next[key].points];
      points[index] = { ...points[index], [field]: value };
      next[key] = { ...next[key], points };
      return next;
    });

  const addRow = (key: ValueStoreKey) =>
    setDrafts(current => {
      const next = { ...current };
      const points = [...next[key].points];
      const last = points[points.length - 1];
      // A new row continues the curve rather than starting a fresh argument:
      // one step further along, at half the value, which is already concave and
      // therefore saveable without further editing.
      points.push({
        at: String(Number(last?.at ?? 0) + 1),
        sek_per_unit: String(Math.max(0, Number(last?.sek_per_unit ?? 0) / 2)),
      });
      next[key] = { ...next[key], points };
      return next;
    });

  const removeRow = (key: ValueStoreKey, index: number) =>
    setDrafts(current => {
      const next = { ...current };
      const points = next[key].points.filter((_point, at) => at !== index);
      next[key] = { ...next[key], points };
      return next;
    });

  if (!homeId) {
    return <p className="text-sm text-muted-foreground">{t('Välj ett hem.', 'Select a home.')}</p>;
  }
  if (loading) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  }

  return (
    <div className="space-y-4">
      <Alert>
        <TrendingDown className="w-4 h-4" />
        <AlertTitle>{t('Vad en enhet är värd för dig', 'What a unit is worth to you')}</AlertTitle>
        <AlertDescription className="text-sm">
          {t(
            'Varje rad säger vad en enhet är värd upp till den nivån. Diagrammet räknar om kurvan till kronor per kWh el — det är så planeraren jämför den med köp- och säljpriset. Ligger kurvan över säljpriset lönar det sig att använda solelen här i stället för att sälja den; ligger den över köppriset lönar det sig även att köpa. Värdet måste falla när nivån stiger.',
            'Each row says what one unit is worth up to that level. The chart converts the curve into SEK per kWh of electricity, which is how the planner compares it with the import and export price. Above the export price it pays to use your solar here instead of selling it; above the import price it pays to buy as well. Value must fall as the level rises.',
          )}
        </AlertDescription>
      </Alert>

      <div className="flex justify-end">
        <Button onClick={() => void replan()} disabled={replanning} variant="secondary">
          {replanning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          {t('Planera om nu', 'Replan now')}
        </Button>
      </div>

      {EDITABLE.map(key => {
        const draft = drafts[key];
        if (!draft) return null;
        const unit = DEFAULT_VALUE_CURVES[key].unit;
        const text = UNIT_TEXT[unit];
        const parsed = parse(draft, key);
        const curve = typeof parsed === 'string' ? null : parsed;
        const state = key === 'pool' ? poolTemperatureC : vehicleRangeKm;

        // Sample the curve across its own range so the step shape is visible,
        // converted into the units the prices are quoted in.
        const chart = curve && curve.points.length > 0
          ? Array.from({ length: 80 }, (_value, step) => {
            const first = curve.points[0].at;
            const last = curve.points[curve.points.length - 1].at;
            const span = Math.max(1e-6, last - first);
            const at = first - span * 0.15 + (span * 1.3 * step) / 79;
            return {
              at: Number(at.toFixed(2)),
              sekPerKwh: Number(
                (marginalValue(curve, at) * UNITS_PER_KWH[key]).toFixed(4),
              ),
            };
          })
          : [];

        return (
          <Card key={key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {key === 'pool' ? t('Pool', 'Pool') : t('Elbil', 'Vehicle')}
              </CardTitle>
              <Badge variant={draft.source === 'customer' ? 'secondary' : 'outline'}>
                {draft.source === 'customer' ? t('Egen kurva', 'Your curve') : t('Standard', 'Default')}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {chart.length > 0 && (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="at"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        tick={{ fontSize: 11 }}
                        label={{ value: t(text.level[0], text.level[1]), position: 'insideBottom', offset: -2, fontSize: 11 }}
                      />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        width={56}
                        label={{ value: 'SEK/kWh', angle: -90, position: 'insideLeft', fontSize: 11 }}
                      />
                      <ChartTooltip
                        formatter={(value: number) => [`${value.toFixed(2)} SEK/kWh`, t('Värde', 'Value')]}
                        labelFormatter={(label: number) => `${label} ${unit === 'celsius' ? '°C' : 'km'}`}
                      />
                      <Line type="stepAfter" dataKey="sekPerKwh" stroke="#2563eb" dot={false} strokeWidth={2} />
                      {typeof importPriceSekPerKwh === 'number' && (
                        <ReferenceLine
                          y={importPriceSekPerKwh}
                          stroke="#dc2626"
                          strokeDasharray="4 4"
                          label={{ value: t('Köppris', 'Import'), fontSize: 10, position: 'right' }}
                        />
                      )}
                      {typeof exportPriceSekPerKwh === 'number' && (
                        <ReferenceLine
                          y={exportPriceSekPerKwh}
                          stroke="#059669"
                          strokeDasharray="4 4"
                          label={{ value: t('Säljpris', 'Export'), fontSize: 10, position: 'right' }}
                        />
                      )}
                      {typeof state === 'number' && (
                        <ReferenceLine
                          x={state}
                          stroke="#64748b"
                          label={{ value: t('Nu', 'Now'), fontSize: 10, position: 'top' }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t(CONVERSION_TEXT[key].sv, CONVERSION_TEXT[key].en)}
              </p>
              <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 text-xs text-muted-foreground">
                <span>{t(text.level[0], text.level[1])}</span>
                <span>{t(text.per[0], text.per[1])}</span>
                <span>{t('Motsvarar (SEK/kWh el)', 'Equivalent (SEK/kWh electricity)')}</span>
                <span className="w-9" />
              </div>
              {draft.points.map((point, index) => (
                <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3">
                  <Input
                    value={point.at}
                    inputMode="decimal"
                    aria-label={t(text.level[0], text.level[1])}
                    onChange={event => editRow(key, index, 'at', event.target.value)}
                  />
                  <Input
                    value={point.sek_per_unit}
                    inputMode="decimal"
                    aria-label={t(text.per[0], text.per[1])}
                    onChange={event => editRow(key, index, 'sek_per_unit', event.target.value)}
                  />
                  {/*
                    Read-only, and the whole point of the table: the planner
                    compares this figure with the import and export price, so a
                    value in SEK per °C is otherwise impossible to judge.
                  */}
                  <div className="flex items-center px-3 text-sm tabular-nums text-muted-foreground">
                    {Number.isFinite(Number(point.sek_per_unit))
                      ? `${(Number(point.sek_per_unit) * UNITS_PER_KWH[key]).toFixed(2)} SEK/kWh`
                      : '—'}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('Ta bort punkt', 'Remove point')}
                    disabled={draft.points.length <= 1}
                    onClick={() => removeRow(key, index)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              {typeof parsed === 'string' && (
                <p className="text-sm text-destructive">{parsed}</p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" onClick={() => addRow(key)}>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('Lägg till punkt', 'Add point')}
                </Button>
                <Button onClick={() => void save(key)} disabled={saving === key || typeof parsed === 'string'}>
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

export default ValueCurvesTab;
