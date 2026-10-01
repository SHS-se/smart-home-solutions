// What the household wants from its pool and its car: one number each.
//
// These are the only comfort inputs for the two stores. The planner works out
// what a degree or a kilometre is worth from them and from each plan's prices,
// solar and weather, so there is nothing about money to set here.

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

/** What a home that has never set its targets is planned for. */
const DEFAULT_TARGETS = { pool_target_c: 30, ev_target_km: 300 };
const LIMITS = { pool_target_c: [10, 40], ev_target_km: [0, 1000] } as const;

type Targets = typeof DEFAULT_TARGETS;

const ComfortTargetsCard: React.FC<{ customerId: string; homeId: string }> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const [stored, setStored] = useState<Targets | null>(null);
  const [draft, setDraft] = useState<Record<keyof Targets, string>>({ pool_target_c: '', ev_target_km: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (targets: Targets) => {
    setStored(targets);
    setDraft({ pool_target_c: String(targets.pool_target_c), ev_target_km: String(targets.ev_target_km) });
  };

  const load = useCallback(async () => {
    const { data, error: readError } = await supabase
      .from('energy_optimisation_comfort_targets')
      .select('pool_target_c, ev_target_km')
      .eq('home_id', homeId)
      .maybeSingle();
    if (readError) { setError(readError.message); return; }
    setError(null);
    show(data ? { pool_target_c: Number(data.pool_target_c), ev_target_km: Number(data.ev_target_km) } : DEFAULT_TARGETS);
  }, [homeId]);
  useEffect(() => { void load(); }, [load]);

  const parsed = (key: keyof Targets): number | null => {
    const value = Number(draft[key].replace(',', '.'));
    const [low, high] = LIMITS[key];
    return draft[key].trim() !== '' && Number.isFinite(value) && value >= low && value <= high ? value : null;
  };
  const pool = parsed('pool_target_c'), car = parsed('ev_target_km');
  const valid = pool !== null && car !== null;
  const changed = stored !== null && valid && (pool !== stored.pool_target_c || car !== stored.ev_target_km);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const next = { pool_target_c: pool, ev_target_km: car };
    const { error: writeError } = await supabase
      .from('energy_optimisation_comfort_targets')
      .upsert({ home_id: homeId, customer_id: customerId, ...next, updated_at: new Date().toISOString() }, { onConflict: 'home_id' });
    setSaving(false);
    if (writeError) { setError(writeError.message); return; }
    setError(null);
    show(next);
  };

  return (
    <Card data-testid="comfort-targets-card">
      <CardHeader>
        <CardTitle className="text-base">{t('Pool och elbil', 'Pool and car')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t(
            'Ange vad du vill ha: poolens temperatur och bilens räckvidd. Planeraren håller dem så billigt som möjligt och räknar själv ut vad det är värt vid dagens priser, sol och väder. Ändringen gäller från nästa plan.',
            'Say what you want: the pool’s temperature and the car’s range. The planner holds them as cheaply as it can and works out for itself what that is worth at the day’s prices, sun and weather. A change applies from the next plan.',
          )}
        </p>
      </CardHeader>
      <CardContent>
        {error && <Alert variant="destructive" className="mb-3"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="comfort-target-pool">{t('Pooltemperatur', 'Pool temperature')}</Label>
            <div className="flex items-center gap-2">
              <Input id="comfort-target-pool" inputMode="decimal" className="w-24" value={draft.pool_target_c} disabled={stored === null || saving}
                aria-invalid={draft.pool_target_c !== '' && pool === null}
                onChange={event => setDraft(current => ({ ...current, pool_target_c: event.target.value }))} />
              <span className="text-sm text-muted-foreground">°C</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="comfort-target-car">{t('Bilens räckvidd', 'Car range')}</Label>
            <div className="flex items-center gap-2">
              <Input id="comfort-target-car" inputMode="decimal" className="w-24" value={draft.ev_target_km} disabled={stored === null || saving}
                aria-invalid={draft.ev_target_km !== '' && car === null}
                onChange={event => setDraft(current => ({ ...current, ev_target_km: event.target.value }))} />
              <span className="text-sm text-muted-foreground">km</span>
            </div>
          </div>
          <Button disabled={!changed || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('Spara', 'Save')}
          </Button>
        </div>
        {stored !== null && !valid && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {t('Ange 10–40 °C och 0–1000 km.', 'Enter 10–40 °C and 0–1000 km.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default ComfortTargetsCard;
