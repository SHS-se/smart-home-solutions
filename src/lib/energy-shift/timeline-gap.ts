import { SLOT_MS } from './energy-timeline.ts';

type Translate = (sv: string, en: string) => string;

/** Missing rows describe chart coverage, not proof of lost recorder data.
 * Allow two upload intervals after a quarter ends before calling it an older gap. */
export function timelineGapDescription(startMs: number, nowMs: number, t: Translate) {
  if (startMs > nowMs) {
    return {
      label: t('Ingen plan', 'No plan'),
      detail: t('Ingen plan är tillgänglig för denna kvart.', 'No plan is available for this quarter.'),
    };
  }
  if (nowMs < startMs + SLOT_MS) {
    return {
      label: t('Pågående kvart', 'Quarter in progress'),
      detail: t(
        'Mätvärden blir tillgängliga när kvarten är avslutad och Home Assistant har skickat dem.',
        'Measurements become available after this quarter ends and Home Assistant uploads them.',
      ),
    };
  }
  if (nowMs < startMs + 3 * SLOT_MS) {
    return {
      label: t('Inväntar mätvärden', 'Awaiting measurements'),
      detail: t(
        'Kvarten är avslutad, men mätvärdena har ännu inte nått diagrammet.',
        'This quarter has ended, but its measurements have not reached the chart yet.',
      ),
    };
  }
  return {
    label: t('Inga mätvärden', 'No measurements'),
    detail: t(
      'Inga mätvärden är tillgängliga för denna kvart. De kan fortfarande komma i en senare överföring.',
      'No measurements are available for this quarter. They may still arrive in a later upload.',
    ),
  };
}
