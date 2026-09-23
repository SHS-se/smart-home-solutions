import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { replanCompleted, replanState, type ReplanRow } from '@/lib/energy-shift/replan-request';

export default function ReplanControls({ homeId, replan, refreshing, onReplanChanged }: {
  homeId: string | null; replan: ReplanRow | null; refreshing: boolean; onReplanChanged?: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [replanning, setReplanning] = useState(false);
  const [awaitedReplanId, setAwaitedReplanId] = useState<string | null>(null);
  const replanProgress = replanState(replan);
  const waitingForReplan = replanProgress.status === 'waiting';
  const requestReplan = async () => {
    if (refreshing || replanning || waitingForReplan) return;
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
    // Held only to tell this browser's own request from one that was already
    // outstanding when the page loaded; the wait itself is read from the row.
    setAwaitedReplanId(
      typeof data?.replan_request_id === 'string' ? data.replan_request_id : null,
    );
    onReplanChanged?.();
  };

  // The answer arrives through the row on the workspace's own refresh, not
  // through the call that asked for it, so the confirmation is raised here.
  useEffect(() => {
    if (!replanCompleted(replan, awaitedReplanId)) return;
    setAwaitedReplanId(null);
    toast({
      title: t('Planen är omräknad', 'Plan rebuilt'),
      description: t(
        'Hemmet skickade färska mätvärden och planerades om med dina värden.',
        'The house sent fresh measurements and was replanned with your numbers.',
      ),
    });
  }, [awaitedReplanId, replan, t, toast]);


 return <div className="space-y-3">        <Button
          size="sm"
          onClick={() => void requestReplan()}
          disabled={refreshing || replanning || waitingForReplan}
          variant="secondary"
        >
          {replanning || waitingForReplan
            ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            : <RefreshCw className="w-4 h-4 mr-2" />}
          {t('Planera om nu', 'Replan now')}
        </Button>

      {replanProgress.status === 'waiting' && (
        <Alert>
          <RefreshCw className="w-4 h-4" />
          <AlertTitle>{t('Omplanering beställd', 'Replan requested')}</AlertTitle>
          <AlertDescription className="text-sm">
            {t(
              'Hemmet skickar färska mätvärden och planeras om med dina värden. Planen uppdaterar sig själv här när den är klar.',
              'The house is sending fresh measurements and will be replanned with your numbers. The plan updates itself here when it is done.',
            )}
            {replanProgress.overdue && (
              <>
                {' '}
                <span className="font-medium">
                  {t(
                    `Det har gått ${Math.round(replanProgress.waitedMs / 60_000)} minuter utan svar — kontrollera att Home Assistant är igång och uppkopplat.`,
                    `${Math.round(replanProgress.waitedMs / 60_000)} minutes have passed without an answer — check that Home Assistant is running and connected.`,
                  )}
                </span>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {replanProgress.status === 'failed' && (
        <Alert variant="destructive">
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
</div>;
}
