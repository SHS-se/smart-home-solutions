import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const ComfortTargetsCard: React.FC<{ customerId: string; homeId: string }> = ({ customerId, homeId }) => {
  const { t } = useLanguage();
  const [stored, setStored] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (target: number) => {
    setStored(target);
    setDraft(String(target));
  };

  const load = useCallback(async () => {
    const { data, error: readError } = await supabase
      .from('energy_optimisation_comfort_targets')
      .select('pool_target_c')
      .eq('home_id', homeId)
      .maybeSingle();
    if (readError) { setError(readError.message); return; }
    setError(null);
    show(data ? Number(data.pool_target_c) : 30);
  }, [homeId]);
  useEffect(() => { void load(); }, [load]);

  const pool = Number(draft.replace(',', '.'));
  const valid = draft.trim() !== '' && Number.isFinite(pool) && pool >= 10 && pool <= 40;
  const changed = stored !== null && valid && pool !== stored;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const { error: writeError } = await supabase
      .from('energy_optimisation_comfort_targets')
      .upsert({ home_id: homeId, customer_id: customerId, pool_target_c: pool, updated_at: new Date().toISOString() }, { onConflict: 'home_id' });
    setSaving(false);
    if (writeError) { setError(writeError.message); return; }
    setError(null);
    show(pool);
  };

  return (
    <Card data-testid="comfort-targets-card">
      <CardHeader>
        <CardTitle className="text-base">{t('Pool och elbil', 'Pool and car')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t(
            'Pooltemperaturen gäller från nästa plan. Ställ in elbilens laddgräns i bilen.',
            'The pool temperature applies from the next plan. Set the car’s charge limit in the car.',
          )}
        </p>
      </CardHeader>
      <CardContent>
        {error && <Alert variant="destructive" className="mb-3"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="comfort-target-pool">{t('Pooltemperatur', 'Pool temperature')}</Label>
            <div className="flex items-center gap-2">
              <Input id="comfort-target-pool" inputMode="decimal" className="w-24" value={draft} disabled={stored === null || saving}
                aria-invalid={draft !== '' && !valid}
                onChange={event => setDraft(event.target.value)} />
              <span className="text-sm text-muted-foreground">°C</span>
            </div>
          </div>
          <Button disabled={!changed || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('Spara', 'Save')}
          </Button>
        </div>
        {stored !== null && !valid && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {t('Ange 10–40 °C.', 'Enter 10–40 °C.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default ComfortTargetsCard;
