// Why a quarter scored what it did: the rules that fired in it, and the points
// each gave or took. Shown under the score strip of the plan chart (PlanPanels),
// so the strip and its explanation read as one section on the live plan.
// The section ends with the replay bundle download.

import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { scoreColour, signedPoints } from './quarter-score';

export interface QuarterScoreLine {
  key: string;
  points: number;
  /** What the rule is, with any evidence for this quarter. */
  label: React.ReactNode;
}

export interface QuarterScoreExplanation {
  score: number;
  /** When the quarter starts, already localised. */
  when: string;
  /** Import price of the quarter, SEK/kWh, and what kind of price it is. */
  price: number | null;
  priceNote?: string;
  lines: QuarterScoreLine[];
}

const QuarterScoreDetail: React.FC<{
  id?: string;
  quarter: QuarterScoreExplanation | null;
  /** Said while no quarter is picked; a plan without a score says what the download holds instead. */
  empty?: React.ReactNode;
  /** The download of what the chart shows, at the end of the section. */
  action?: React.ReactNode;
}> = ({ id, quarter, empty, action }) => {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div id={id} className="min-h-[2.5rem] min-w-0 flex-1 basis-64" aria-live="polite">
        {!quarter
          ? <span className="text-muted-foreground">{empty ?? t('Klicka på en kvart i diagrammet för att se varför den fick sin poäng.', 'Click a quarter in the chart to see why it scored what it did.')}</span>
          : (
            <div className="space-y-1">
              <div>
                <span className="font-mono font-semibold" style={{ color: scoreColour(quarter.score) }}>{signedPoints(quarter.score)}</span>{' '}
                <span className="font-medium">{quarter.when}</span>
                {quarter.price !== null && <>{' '}<span className="text-muted-foreground">· {quarter.price.toFixed(2)} kr/kWh{quarter.priceNote ? ` ${quarter.priceNote}` : ''}</span></>}
              </div>
              {quarter.lines.length
                ? <ul className="text-xs space-y-0.5">{quarter.lines.map(line =>
                  <li key={line.key} className="font-mono">{signedPoints(line.points)} {line.label}</li>)}</ul>
                : <div className="text-xs text-muted-foreground">{t('Ingen regel slog till.', 'No rule fired.')}</div>}
            </div>
          )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
};

export default QuarterScoreDetail;
