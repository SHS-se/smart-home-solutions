import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { actionablePlanningWarnings, type PlanningWarning } from '../../../../supabase/functions/_shared/planner/planning-warnings';

/**
 * What the planner wants known about this plan, on request beside the
 * accuracy figures rather than in a banner over the page. A room's comfort
 * shortfall is left out when the chart already says it beside that room.
 */
export default function PlanningNotesButton({ warnings, charted }: {
  warnings: readonly PlanningWarning[];
  /** Rooms whose comfort note the chart's room temperature panel carries. */
  charted: readonly string[];
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const notes = actionablePlanningWarnings(warnings)
    .filter(warning => !(warning.code === 'comfort_shortfall' && charted.includes(warning.scope)));
  if (!notes.length) return null;
  const error = notes.some(warning => warning.severity === 'error');
  const label = t('Planeringsnoteringar', 'Planning notes');
  return <>
    <Button ref={trigger} variant="ghost" size="sm" className="gap-2 text-xs text-muted-foreground"
      data-testid="planning-notes" onClick={() => setOpen(true)}>
      {label} <span className={`font-semibold tabular-nums ${error ? 'text-red-700 dark:text-red-400' : 'text-yellow-700 dark:text-yellow-400'}`}>{notes.length}</span>
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md" aria-describedby={undefined}
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        <ul className="divide-y" data-testid="planning-warnings">
          {notes.map(warning => <li key={`${warning.scope}:${warning.code}`} className="py-2 text-sm">
            <span className={`font-medium ${warning.severity === 'error' ? 'text-red-700 dark:text-red-400' : ''}`}>{warning.message}</span>{' '}
            <span className="text-muted-foreground">{warning.consequence}</span>
          </li>)}
        </ul>
      </DialogContent>
    </Dialog>
  </>;
}
