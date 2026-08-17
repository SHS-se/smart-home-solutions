import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Save, TrendingDown } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import {
  DEFAULT_VALUE_CURVES,
  type ValueStoreKey,
} from '../../../../supabase/functions/_shared/value-curves';
import {
  validateCurve,
  type UtilityCurve,
} from '../../../../supabase/functions/_shared/store-value';

interface Props {
  customerId: string | null;
  homeId: string | null;
}

interface Draft {
  points: { at: string; sek_per_unit: string }[];
  source: 'customer' | 'default';
}

const EDITABLE: ValueStoreKey[] = ['pool', 'ev'];

const UNIT_LABEL: Record<string, { sv: string; en: string }> = {
  celsius: { sv: 'Vattentemperatur (°C)', en: 'Water temperature (°C)' },
  km: { sv: 'Räckvidd (km)', en: 'Range (km)' },
  litre_degrees: { sv: 'Litergrader', en: 'Litre-degrees' },
};

const toDraft = (curve: UtilityCurve): Draft => ({
  points: curve.points.map(point => ({
    at: String(point.at),
    sek_per_unit: String(point.sek_per_unit),
  })),
  source: 'default',
});

const ValueCurvesTab: React.FC<Props> = ({ customerId, homeId }) => {
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
    // The concavity rule is the one a customer will hit, so it is explained
    // rather than named: a rising value would let the planner justify filling a
    // store without limit, which is why it cannot be stored at all.
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
      toast({
        title: t('Kunde inte planera om', 'Could not replan'),
        // The usual cause is an aged snapshot, and the remedy is simply to wait
        // for the next push, so the reason is shown rather than swallowed.
        description: error.message,
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: t('Planen är omräknad', 'Plan rebuilt'),
      description: `${data?.status ?? ''} · ${new Date(data?.issued_at ?? Date.now()).toLocaleTimeString()}`,
    });
  };

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
            'Varje rad säger vad en enhet är värd upp till den nivån. Planeraren köper energi när värdet överstiger priset, så en lägre siffra betyder att lagret oftare får vänta på gratis solel. Värdet måste falla när nivån stiger.',
            'Each row says what one unit is worth up to that level. The planner buys energy when the value beats the price, so a lower figure means the store waits for free solar more often. Value must fall as the level rises.',
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
        const label = UNIT_LABEL[unit] ?? { sv: unit, en: unit };
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
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                <span>{t(label.sv, label.en)}</span>
                <span>{t('Värde (SEK per enhet)', 'Value (SEK per unit)')}</span>
              </div>
              {draft.points.map((point, index) => (
                <div key={index} className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="sr-only">{t('Nivå', 'Level')}</Label>
                    <Input
                      value={point.at}
                      inputMode="decimal"
                      onChange={event => setDrafts(current => {
                        const next = { ...current };
                        const points = [...next[key].points];
                        points[index] = { ...points[index], at: event.target.value };
                        next[key] = { ...next[key], points };
                        return next;
                      })}
                    />
                  </div>
                  <div>
                    <Label className="sr-only">{t('Värde', 'Value')}</Label>
                    <Input
                      value={point.sek_per_unit}
                      inputMode="decimal"
                      onChange={event => setDrafts(current => {
                        const next = { ...current };
                        const points = [...next[key].points];
                        points[index] = { ...points[index], sek_per_unit: event.target.value };
                        next[key] = { ...next[key], points };
                        return next;
                      })}
                    />
                  </div>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <Button onClick={() => void save(key)} disabled={saving === key}>
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
