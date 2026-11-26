// The plan, its inputs, and the call that reproduces it, as one file.
//
// This used to be a full quarter ledger: every accepted bid, the battery's
// comparison, the exact grid balance and the all-in prices, rendered as a
// 2720-pixel table. It was built to answer "why did the plan choose that?" by
// showing recorded evidence rather than reconstructing a story from the final
// power flows — and the columns did answer it, for anyone willing to read
// across twenty of them.
//
// Nobody was. The same evidence is in the replay bundle below, next to the
// snapshot it was derived from and the entrypoint that turns one back into the
// other, where a debugger can query it instead of scrolling it. So the table is
// gone and the download it lived beside is not.
//
// The button sits at the end of the chart's score section (QuarterScoreDetail),
// where the planner bench has its own download of the chart it shows.

import React from 'react';
import { FileJson, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { PlannedSlot } from '@/lib/energy-shift/contracts';
import type { TimelineRange, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import type { PlanModel } from './usePlanModel';
import { useHomeTimeZone } from '../HomeTimeZoneContext';
import { formatHomeStamp } from '@/lib/energy-shift/home-time';
import { replayDescription, replayExecution, replayHistory, replayPlanSelection } from '@/lib/energy-shift/plan-replay';
import { downloadJson } from '@/lib/download-json';

const PlanReplayDownload: React.FC<{
  model: PlanModel;
  /** The same timeline window the chart above is showing, so the two agree. */
  rows: TimelineRow[];
  range: TimelineRange;
  /**
   * The quarter clicked on the chart, if any. The bundle carries the whole
   * plan either way; this only sets the quarter it points the reader at.
   */
  selectedStart?: string | null;
}> = ({ model, rows: timeline, range, selectedStart }) => {
  const { t } = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const { toast } = useToast();
  const [replayLoading, setReplayLoading] = React.useState(false);
  const windowRows = React.useMemo(
    () => timeline.slice(range.from, range.to),
    [range.from, range.to, timeline],
  );
  const inWindow = React.useMemo(() => {
    const first = windowRows[0]?.startMs;
    const last = windowRows.at(-1)?.startMs;
    if (first === undefined || last === undefined) return [];
    return model.active.slots.filter(slot => {
      const at = Date.parse(slot.start);
      return at >= first && at <= last;
    });
  }, [model.active.slots, windowRows]);
  // A historical selection is recorded in history; the replay bookmark must
  // still point to a planned quarter, including on a history-only chart day.
  const replaySlot = React.useMemo(() => {
    const chosen = selectedStart
      ? inWindow.find(slot => Date.parse(slot.start) === Date.parse(selectedStart))
      : undefined;
    return (chosen ?? inWindow[0] ?? model.active.slots[0]) as PlannedSlot | undefined;
  }, [inWindow, selectedStart, model.active.slots]);

  const canReplay = Boolean(
    model.current.home_id &&
    model.current.generation_request_id &&
    Array.isArray(model.plan.price_outlook.shadow_import_sek_per_kwh) &&
    model.plan.price_outlook.shadow_import_sek_per_kwh.length === model.active.slots.length,
  );

  const downloadReplay = async (slot: PlannedSlot) => {
    if (!model.current.home_id || !model.current.generation_request_id || !canReplay) return;
    setReplayLoading(true);
    try {
      // Full inputs stay lazy and are pinned to the selected published run,
      // even if the current plan is replaced while this request is in flight.
      const { data, error } = await supabase
        .rpc('get_energy_planning_replay', {
          p_home_id: model.current.home_id,
          p_plan_id: model.plan.plan_id,
        });
      if (error || !data) {
        throw new Error(error?.message ?? t(
          'Planens arkiverade indata är inte tillgängliga.',
          'The plan’s archived inputs are unavailable.',
        ));
      }
      const capturedPlan = model.current.plan;
      const bundle = {
        format: 'shs-energy-optimisation-quarter-replay',
        schema_version: 3,
        ...replayExecution(data),
        generation_request_id: model.current.generation_request_id,
        ...replayPlanSelection(capturedPlan, model.active.key, slot.start),
        history: replayHistory(timeline, range, homeTimeZone, selectedStart),
      };
      downloadJson(`plan-replay-${model.plan.plan_id}-${slot.start.replace(/[:.]/g, '-')}.json`, bundle);
    } catch (error) {
      toast({
        title: t('Kunde inte skapa replayfilen', 'Could not create replay file'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setReplayLoading(false);
    }
  };

  // A replay needs a plan, but its selected chart window can be all history.
  if (!replaySlot) return null;

  const quarter = formatHomeStamp(replaySlot.start, homeTimeZone);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!canReplay || replayLoading}
      title={!canReplay
        ? t('Nästa plan kommer att innehålla exakta replaydata.', 'The next plan will contain exact replay data.')
        : `${replayDescription(t)} ${t(`Pekar ut kvarten ${quarter}. Klicka i grafen för att välja en annan.`,
          `Points at the quarter ${quarter}. Click the chart to pick another.`)}`}
      onClick={() => void downloadReplay(replaySlot)}
    >
      {replayLoading
        ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
        : <FileJson className="mr-1.5 h-4 w-4" />}
      {t('Ladda ned repris (JSON)', 'Download replay (JSON)')}
    </Button>
  );
};

export default PlanReplayDownload;
