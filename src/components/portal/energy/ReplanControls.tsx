import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { replanCompleted, replanProgressStage, replanState, type ReplanRow, type ReplanStage } from '@/lib/energy-shift/replan-request';
import type { PlanDisplayTrace } from '@/lib/energy-shift/plan-display-trace';

export default function ReplanControls({ homeId, replan, refreshing, trace, onReplanChanged, onBusyChange }: {
  homeId: string | null;
  replan: (ReplanRow & { plan_id: string | null }) | null;
  refreshing: boolean;
  trace: PlanDisplayTrace;
  onReplanChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [replanning, setReplanning] = useState(false);
  const [awaitedReplanId, setAwaitedReplanId] = useState<string | null>(null);
  const [requestBaselineId, setRequestBaselineId] = useState<string | null>(null);
  const replanProgress = replanState(replan);
  const waitingForReplan = replanProgress.status === 'waiting';
  const awaitingRow = awaitedReplanId !== null && (replan?.replan_request_id ?? null) === requestBaselineId
    && !replanCompleted(replan, awaitedReplanId);
  const busy = replanning || waitingForReplan || awaitingRow;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  // The stage is read from the server while a replan is under way: rooms refit
  // first when the learner changed, then the house measures and the plan is made.
  const [stage, setStage] = useState<ReplanStage | null>(null);
  const waiting = waitingForReplan || awaitingRow;
  useEffect(() => {
    if (!homeId || !waiting) { setStage(null); return; }
    let cancelled = false;
    const read = async () => {
      const { data, error } = await supabase.rpc('get_energy_replan_progress', { p_home_id: homeId });
      if (!cancelled) setStage(error ? null : replanProgressStage(data));
    };
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [homeId, waiting]);
  const words: Record<ReplanStage | 'requesting', string> = {
    requesting: t('Begär', 'Requesting'),
    refitting: t('Anpassar', 'Refitting'),
    measuring: t('Mäter', 'Measuring'),
    planning: t('Planerar', 'Planning'),
  };
  const word = replanning ? words.requesting : words[stage ?? 'measuring'];
  const requestReplan = async () => {
    if (refreshing || busy) return;
    if (!homeId) return;
    setRequestBaselineId(replan?.replan_request_id ?? null);
    setReplanning(true);
    trace.record({ event: 'replan_clicked', displayed_plan_id: replan?.plan_id ?? null });
    const { data, error } = await supabase.functions.invoke('energy-optimisation-replan', {
      body: { home_id: homeId },
    });
    const requestId = typeof data?.replan_request_id === 'string' ? data.replan_request_id : null;
    trace.record({ event: 'replan_response', replan_request_id: requestId, queued: !error && requestId !== null });
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
    // Held only to tell this browser's own request from one that was already
    // outstanding when the page loaded; the wait itself is read from the row.
    setAwaitedReplanId(requestId);
    onReplanChanged?.();
  };

  // The answer arrives through the row on the workspace's own refresh, not
  // through the call that asked for it, so the confirmation is raised here.
  useEffect(() => {
    if (!awaitedReplanId || !replanCompleted(replan, awaitedReplanId)) return;
    trace.record({ event: 'replan_completed', replan_request_id: awaitedReplanId, displayed_plan_id: replan?.plan_id ?? null });
    setAwaitedReplanId(null);
    toast({
      title: t('Planen är omräknad', 'Plan rebuilt'),
      description: t(
        'Hemmet skickade färska mätvärden och planerades om med dina värden.',
        'The house sent fresh measurements and was replanned with your numbers.',
      ),
    });
  }, [awaitedReplanId, replan, t, toast, trace]);


  // A fragment, so the host lays out the button and the failure separately: the
  // button keeps its place beside the plan heading and a long error message
  // takes a full, left-aligned row of its own instead of dragging the button.
  return <>
        <Button
          size="sm"
          onClick={() => void requestReplan()}
          disabled={!homeId || refreshing || busy}
          aria-busy={busy}
          aria-label={busy ? `${t('Planera om nu', 'Replan now')} – ${word}` : undefined}
          className="min-h-11 min-w-36"
          variant="secondary"
          data-testid="replan-button"
        >
          {busy
            ? <Loader2 aria-hidden="true" className="w-4 h-4 mr-2 animate-spin motion-reduce:animate-none" />
            : <RefreshCw aria-hidden="true" className="w-4 h-4 mr-2" />}
          {busy
            // Keyed by the word, so each new stage fades in where the last one was.
            ? <span key={word} aria-hidden="true" data-testid="replan-stage"
              className="animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none">{word}</span>
            : t('Planera om nu', 'Replan now')}
        </Button>

      {!busy && replanProgress.status === 'failed' && (
        <Alert variant="destructive" className="basis-full">
          <AlertTitle>{t('Hemmet kunde inte planera om', 'The house could not replan')}</AlertTitle>
          <AlertDescription className="text-sm">
            {replanProgress.detail}
            {' '}
            {t(
              'Kontrollera felet och begär sedan en ny omplanering här.',
              'Resolve the error, then request another replan here.',
            )}
          </AlertDescription>
        </Alert>
      )}
  </>;
}
