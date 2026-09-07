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
  const indexByStart = React.useMemo(
    () => new Map(model.active.slots.map((slot, index) => [Date.parse(slot.start), index])),
    [model.active.slots],
  );
  // Falling back to the first quarter on screen keeps the file downloadable
  // before anything has been clicked: the plan is the payload, and the quarter
  // is a bookmark into it.
  const replaySlot = React.useMemo(() => {
    const chosen = selectedStart
      ? inWindow.find(slot => Date.parse(slot.start) === Date.parse(selectedStart))
      : undefined;
    return (chosen ?? inWindow[0]) as PlannedSlot | undefined;
  }, [inWindow, selectedStart]);

  const canReplay = Boolean(
    model.current.home_id &&
    model.current.generation_request_id &&
    Array.isArray(model.plan.price_outlook.shadow_import_sek_per_kwh) &&
    model.plan.price_outlook.shadow_import_sek_per_kwh.length === model.active.slots.length,
  );

  const downloadReplay = async (slot: PlannedSlot, slotIndex: number) => {
    if (!model.current.home_id || !model.current.generation_request_id || !canReplay) return;
    setReplayLoading(true);
    try {
      // Snapshot is deliberately lazy: it and the plan are the two large JSON
      // values, and the workspace otherwise polls every 30 seconds.
      const { data, error } = await supabase
        .from('energy_optimisation_current')
        .select('snapshot, input_hash, plan_id')
        .eq('home_id', model.current.home_id)
        .eq('plan_id', model.plan.plan_id)
        .eq('generation_request_id', model.current.generation_request_id)
        .maybeSingle();
      if (error || !data?.snapshot) {
        throw new Error(error?.message ?? t(
          'Planen ersattes innan replaydata kunde hämtas.',
          'The plan was replaced before its replay data could be fetched.',
        ));
      }
      const { thermal_projection: thermalProjection, ...plannerOutput } = model.plan;
      const bundle = {
        format: 'shs-energy-optimisation-quarter-replay',
        schema_version: 1,
        entrypoint: {
          module: 'supabase/functions/_shared/energy-optimisation.ts',
          export: 'generateOptimisationPlan',
          argument_order: ['snapshot', 'now', 'price_archive', 'resolved_price_outlook'],
          invocation: 'generateOptimisationPlan(arguments.snapshot, new Date(arguments.now), arguments.price_archive, arguments.resolved_price_outlook)',
          arguments: {
            snapshot: data.snapshot,
            now: model.plan.issued_at,
            price_archive: [],
            resolved_price_outlook: model.plan.price_outlook,
          },
        },
        input_hash: data.input_hash,
        generation_request_id: model.current.generation_request_id,
        selection: {
          scenario: model.active.key,
          quarter_index: slotIndex,
          quarter_start: slot.start,
        },
        expected: {
          planner_output: plannerOutput,
          thermal_projection: thermalProjection ?? null,
          selected_quarter: slot,
        },
      };
      const url = URL.createObjectURL(new Blob(
        [`${JSON.stringify(bundle, null, 2)}\n`],
        { type: 'application/json;charset=utf-8' },
      ));
      const link = document.createElement('a');
      link.href = url;
      link.download = `plan-replay-${model.plan.plan_id}-${slot.start.replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
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

  // The chart shows measurements before the plan begins. There is no plan to
  // download for that stretch, and saying so would only restate the chart.
  if (!replaySlot) return null;

  const quarter = formatHomeStamp(replaySlot.start, homeTimeZone);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">
        {t(
          'Hela planen med de mätvärden och priser den byggdes av, och anropet som återskapar den.',
          'The whole plan with the measurements and prices it was built from, and the call that reproduces it.',
        )}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canReplay || replayLoading}
        title={!canReplay
          ? t('Nästa plan kommer att innehålla exakta replaydata.', 'The next plan will contain exact replay data.')
          : t(`Pekar ut kvarten ${quarter}. Klicka i grafen för att välja en annan.`,
            `Points at the quarter ${quarter}. Click the chart to pick another.`)}
        onClick={() => void downloadReplay(
          replaySlot,
          indexByStart.get(Date.parse(replaySlot.start)) ?? 0,
        )}
      >
        {replayLoading
          ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          : <FileJson className="mr-1.5 h-4 w-4" />}
        {t('Ladda ned repris (JSON)', 'Download replay (JSON)')}
      </Button>
    </div>
  );
};

export default PlanReplayDownload;
