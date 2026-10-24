import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { replanAuditReason, replanAuditState } from '@/lib/energy-shift/replan-audit';

export default function ReplanHistory({ homeId }: { homeId: string | null }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: ['energy-replan-history', homeId],
    enabled: open && !!homeId,
    refetchInterval: open ? 15000 : false,
    queryFn: async () => {
      const result = await supabase.from('energy_replan_events')
        .select('id,occurred_at,event,source,reason,details').eq('home_id', homeId!).eq('forced', true)
        .order('sequence', { ascending: false }).limit(40);
      if (result.error) throw result.error;
      return result.data;
    },
  });
  if (!homeId) return null;
  return <details className="basis-full text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer rounded py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      {t('Omplaneringshistorik', 'Replanning history')}
    </summary>
    {open && <div className="rounded-md border p-3">
      {isPending && <p role="status">{t('Hämtar historik…', 'Loading history…')}</p>}
      {error && <p role="alert">{t('Historiken kunde inte hämtas.', 'Could not load history.')}</p>}
      {!isPending && !error && !data?.length && <p>{t('Ingen omplanering är registrerad ännu.', 'No forced replanning has been recorded yet.')}</p>}
      {!!data?.length && <ol className="space-y-4" aria-label={t('Senaste omplaneringshändelser', 'Recent replanning events')}>
        {data.map(row => {
          const details = row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details : {};
          return <li key={row.id} className="space-y-1 break-words">
            <p className="font-medium">{replanAuditState(row.event, t, typeof details.completion_basis === 'string' ? details.completion_basis : undefined)}</p>
            <time className="text-muted-foreground" dateTime={row.occurred_at}>{new Date(row.occurred_at).toLocaleString()}</time>
            <p>{replanAuditReason(row.reason, t)}</p>
            {typeof details.detail === 'string' && <p>{details.detail}</p>}
          </li>;
        })}
      </ol>}
    </div>}
  </details>;
}
