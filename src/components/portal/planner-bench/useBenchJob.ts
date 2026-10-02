// What the bench workflow is doing on GitHub Actions, for the bench page: a run
// or a rescore staff just started, or one a push to dev started. The workflow
// has no progress of its own; the page reads that from the results it stores.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface BenchJobRun {
  id: number;
  /** GitHub's run status: queued, in_progress, completed, … */
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  url: string;
}

export type BenchJobKind = 'rescore' | 'run';

/** What staff started from this page: what it is, and how much is left to recompute. */
export interface BenchTask { kind: BenchJobKind; staleAtStart: number }

const FAST_MS = 4_000;
const IDLE_MS = 60_000;
/** The browser's clock and GitHub's differ a little; a run this close before the click is still the click's. */
const CLOCK_SKEW_MS = 15_000;

export function useBenchJob(onFinished: (run: BenchJobRun, task: BenchTask | null) => void) {
  const [task, setTask] = useState<(BenchTask & { startedAt: number }) | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const activeRef = useRef(false);

  const status = useQuery({
    queryKey: ['bench', 'job'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('planner-bench-dispatch', { body: { action: 'status' } });
      if (error) throw new Error(error.message);
      return (data as { run: BenchJobRun | null }).run;
    },
    // Without the GitHub token (anywhere but the test project) there is nothing to show.
    retry: false,
    refetchInterval: () => activeRef.current ? FAST_MS : IDLE_MS,
  });

  const run = status.data ?? null;
  // Right after a click GitHub may still list the run before it, or none yet.
  const starting = task !== null && (!run || Date.parse(run.created_at) < task.startedAt - CLOCK_SKEW_MS);
  const active = starting || (run !== null && run.status !== 'completed');
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [active]);

  const wasActive = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (wasActive.current && !active && run) {
      finished.current(run, task);
      setTask(null);
    }
    wasActive.current = active;
  }, [active, run, task]);

  return {
    run: starting ? null : run,
    active,
    /** Waiting for GitHub to start a run, as opposed to a run that is going. */
    waiting: starting || run?.status === 'queued',
    task,
    elapsedMs: active ? Math.max(0, now - (starting ? task!.startedAt : Date.parse(run!.created_at))) : 0,
    begin: (next: BenchTask) => {
      setTask({ ...next, startedAt: Date.now() });
      setNow(Date.now());
      void status.refetch();
    },
  };
}
