import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { editedPeriodEnd, fixedPlanState, type FixedPlanStatus } from '@/lib/energy-shift/fixed-plan';
import type { WorkbenchDraft, WorkbenchModel } from '@/lib/energy-shift/plan-workbench';
import type { DispatchWorkbench } from '../../../../supabase/functions/_shared/energy-optimisation';
import type { DispatchSchedule } from '../../../../supabase/functions/_shared/dispatch-plan';
import { QUARTER_MS } from '../../../../supabase/functions/_shared/fixed-energy-plan';
import { formatHomeDayMonthTime } from '@/lib/energy-shift/home-time';
import { useHomeTimeZone } from './HomeTimeZoneContext';

async function request(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('energy-optimisation-fixed-plan', { body });
  if (error) {
    if (error.context instanceof Response) {
      const payload = await error.context.json();
      throw new Error(payload.error ?? error.message);
    }
    throw error;
  }
  return data;
}

export default function FixedPlanControls({ homeId, bench, manual, model, draft, allowExport }: {
  homeId: string | null; bench: DispatchWorkbench | null; manual: DispatchSchedule | null;
  model: WorkbenchModel | null; draft: WorkbenchDraft; allowExport: boolean[];
}) {
  const { t } = useLanguage();
  const zone = useHomeTimeZone();
  const [status, setStatus] = useState<FixedPlanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refresh = useCallback(async () => {
    if (!homeId) return;
    const next = await request({ home_id: homeId, action: 'status' });
    setStatus(next);
  }, [homeId]);
  useEffect(() => {
    let alive = true;
    setStatus(null);
    const poll = async () => {
      if (!homeId) return;
      try {
        const next = await request({ home_id: homeId, action: 'status' });
        if (alive) { setStatus(next); setNow(Date.now()); }
      } catch (e) { if (alive) { setStatus(null); setError(String(e)); } }
    };
    void poll();
    const timer = setInterval(poll, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [homeId]);
  const end = editedPeriodEnd(model, draft, allowExport);
  const start = (Math.floor(now / QUARTER_MS) + 1) * QUARTER_MS;
  const stamp = (value: number | string) => formatHomeDayMonthTime(typeof value === 'string' ? Date.parse(value) : value, zone);
  const state = status ? fixedPlanState(status, now) : null;
  const hasFixedInterval = status?.fixed_plan && Date.parse(status.fixed_plan.ends_at) > now;
  const labels = {
    failed: t('Planen kunde inte skapas', 'Plan generation failed'),
    waiting: t('Väntar på Home Assistant', 'Waiting for Home Assistant'),
    rejected: t('Home Assistant avvisade planen', 'Home Assistant rejected the plan'),
    expired: t('Planens giltighet har löpt ut', 'Plan execution lease expired'),
    scheduled: t('Home Assistant har accepterat den fasta planen', 'Home Assistant accepted the fixed plan'),
    active: t('Fast plan aktiv', 'Fixed plan active'),
    automatic: t('Automatisk planering', 'Automatic planning'),
  };
  const submit = async (action: 'activate' | 'rescind') => {
    if (!status || !homeId) return;
    setBusy(true); setError(null);
    try {
      await request({ home_id: homeId, action, revision: status.revision,
        ...(action === 'activate' ? { snapshot_id: bench?.snapshot_id, schedule: manual, starts_at: new Date(start).toISOString(), ends_at: new Date(end!).toISOString() } : {}),
      });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setNow(Date.now()); }
  };
  return <Card><CardContent className="pt-4 space-y-3">
    <p className="font-medium" aria-live="polite">{state ? labels[state] : t('Läser planstatus…', 'Loading plan status…')}</p>
    {status?.fixed_plan && <p className="text-sm">{t('Fast intervall', 'Fixed interval')}: {stamp(status.fixed_plan.starts_at)} – {stamp(status.fixed_plan.ends_at)}</p>}
    {end && end > start ? <p className="text-sm">{t('Aktivering låser alla tilldelningar från', 'Activation fixes every allocation from')} {stamp(start)} {t('till', 'until')} {stamp(end)}. {t('Därefter tar automatisk planering över.', 'Automatic planning takes over after that.')}</p> : <p className="text-sm text-muted-foreground">{t('Ändra en framtida period för att aktivera en fast plan.', 'Edit a future period to activate a fixed plan.')}</p>}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !status || !bench || !manual || !end || end <= start} onClick={() => void submit('activate')}>
        {hasFixedInterval ? t('Ersätt fast plan', 'Replace fixed plan') : t('Aktivera fast plan', 'Activate fixed plan')}
      </Button>
      {(hasFixedInterval || status?.generated_fixed_plan_id) && <Button variant="outline" disabled={busy} onClick={() => void submit('rescind')}>
        {t('Återgå till automatisk planering', 'Return to automatic planning')}
      </Button>}
    </div>
    {(error || status?.error || state === 'rejected') && <p role="alert" className="text-sm text-destructive">{error ?? status?.error ?? JSON.stringify(status?.ha_ack_error)}</p>}
  </CardContent></Card>;
}
