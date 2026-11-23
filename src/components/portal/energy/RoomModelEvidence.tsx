import { roomMeasuredEvidence, roomRunEvidence, roomTransitionEvidence } from '@/lib/energy-shift/room-run-evidence';
import { z } from 'zod';
import { useLanguage } from '@/contexts/LanguageContext';
import { THERMAL_REJECTION_EN, THERMAL_REJECTION_SV } from './plan/types';

export function FittedRoomWarnings({ warnings }: { warnings: string[] | undefined }) {
  const { t } = useLanguage();
  if (!warnings?.length) return null;
  const message = (code: string) => code === 'insufficient_samples'
    ? t('Den här responsen anpassades till begränsad historik.', 'This response was fitted with limited observed history.')
    : code === 'insufficient_heating'
      ? t('Den här responsen anpassades till begränsade uppvärmningsobservationer.', 'This response was fitted with limited observed heating.')
      : THERMAL_REJECTION_EN[code] ? t(THERMAL_REJECTION_SV[code], THERMAL_REJECTION_EN[code])
        : t(`Sparad varning: ${code}`, `Stored warning: ${code}`);
  return <div className="space-y-1 text-sm" data-testid="room-fit-warnings">
    <p className="font-medium">{t('Varningar för vald anpassning', 'Warnings for the selected fit')}</p>
    <ul className="list-disc space-y-1 pl-5">{[...new Set(warnings)].map(code => <li key={code}>{message(code)}</li>)}</ul>
  </div>;
}

const counts = z.object({ inferred: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(), unverified: z.number().int().nonnegative() });
const sourceAttempt = z.object({ source_freshness: z.object({ room: counts, house: counts }) });

/** Attempt diagnostics are not provenance of whichever revision is selected. */
export function LatestRoomSourceEvidence({ attempt }: { attempt: unknown }) {
  const { language, t } = useLanguage();
  const parsed = sourceAttempt.safeParse(attempt);
  return <details className="border-t pt-1 text-xs" data-testid="room-source-evidence">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      {t('Senast sparade kontroll av givarrapportering', 'Latest stored source-reporting checks')}
    </summary>
    {!parsed.success ? <p className="pb-3 text-muted-foreground">{t(
      'Sparade uppgifter om givarrapportering är inte tillgängliga. Rapporteringens status är okänd.',
      'Stored source-reporting diagnostics are unavailable. Reporting status is unknown.',
    )}</p> : <div className="space-y-3 pb-3">
      <p className="text-muted-foreground">{t(
        'Kontrollerna kommer från senast sparade inlärningsdiagnostik och kan gälla ett annat temperaturintervall än vald anpassning.',
        'These checks come from the latest stored learning diagnostics and may describe a different temperature range from the selected fit.',
      )}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['room', 'house'] as const).map(scope => <section key={scope} data-testid={`source-evidence-${scope}`}>
          <h4 className="mb-1 font-medium">{scope === 'room' ? t('Rumstemperatur', 'Room temperature') : t('Husets temperatur', 'House temperature')}</h4>
          <dl className="space-y-1">
            {([
              ['inferred', t('Antaget rapporteringsstopp', 'Inferred reporting freeze')],
              ['unavailable', t('Rapporterad som otillgänglig', 'Reported unavailable')],
              ['unverified', t('Givarunderlag som inte kunde matchas', 'Unmatched source evidence')],
            ] as const).map(([kind, label]) => <div key={kind} className="flex justify-between gap-3">
              <dt>{label}</dt><dd className="tabular-nums">{parsed.data.source_freshness[scope][kind].toLocaleString(language)}</dd>
            </div>)}
          </dl>
        </section>)}
      </div>
      <p className="text-muted-foreground">{t(
        'Antal registrerade intervall, inte timmar. Kategorierna kan överlappa och betyder inte att alla temperaturvärden har uteslutits. Ett antaget rapporteringsstopp är inte ett bekräftat givarfel. Saknat rapporteringsunderlag är fortfarande okänt.',
        'Counts are recorded intervals, not hours; categories may overlap and do not mean every temperature was discarded. An inferred reporting freeze is not a confirmed sensor fault. Missing reporting evidence remains unknown.',
      )}</p>
    </div>}
  </details>;
}

const runAttempt = z.object({ learning: z.object({
  run_calibration: roomRunEvidence.optional(), transition_calibration: roomTransitionEvidence.optional(), measured_runs: roomMeasuredEvidence.optional(),
}) });

/** Latest attempt evidence is shown separately from the selected stored fit. */
export function LatestRoomRunEvidence({ attempt }: { attempt: unknown }) {
  const { language, t } = useLanguage();
  const parsed = runAttempt.safeParse(attempt);
  if (!parsed.success) return null;
  const { run_calibration: run, transition_calibration: transitions, measured_runs: measured } = parsed.data.learning;
  if (!run && !transitions && !measured) return null;
  return <section className="space-y-1 border-t pt-3 text-xs" data-testid="latest-room-run-evidence">
    <h4 className="text-sm font-medium">{t('Senaste anpassningsförsök', 'Latest fitting attempt')}</h4>
    {measured && <p>{measured.observed_runs.toLocaleString(language)} {t('observerade förlopp', 'observed runs')}
      {' · '}{measured.flagged_runs.toLocaleString(language)} {t('flaggade efter anpassningen', 'flagged after fitting')}
      {' · '}{measured.unmeasured_runs.toLocaleString(language)} {t('utan mätbart punktvärde', 'without a measurable point')}</p>}
    {!measured && transitions && <p>{t('Anpassade övergångar', 'Fitted transitions')}{' · '}{transitions.fitted_transitions.toLocaleString(language)}</p>}
    {!measured && !transitions && run && <p>{run.fitted_runs.toLocaleString(language)} {t('jämförbara förlopp', 'comparable runs')}
      {' · '}{run.suspect_runs.toLocaleString(language)} {t('misstänkta förlopp uteslutna', 'suspect runs excluded')}
      {' · '}{run.provisional_runs.toLocaleString(language)} {t('preliminära förlopp', 'provisional runs')}</p>}
    {!measured && !transitions && <p className="text-muted-foreground">{t(
      'Det senaste försöket kan gälla ett annat temperaturintervall. Underlaget för vald publicerad modell visas ovan.',
      'The latest attempt may concern another temperature range. Evidence for the selected published model appears above.',
    )}</p>}
  </section>;
}
