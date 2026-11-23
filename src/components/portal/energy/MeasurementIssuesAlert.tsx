import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { describeMeasurementIssue, type MeasurementIssue } from '@/lib/energy-shift/measurement-issues';

/**
 * Devices whose current readings cannot support a new model projection.
 * Only those devices are affected; the rest of the home is planned as usual.
 */
export default function MeasurementIssuesAlert({ issues }: { issues: MeasurementIssue[] }) {
  const { t } = useLanguage();
  if (issues.length === 0) return null;
  return (
    <Alert data-testid="measurement-issues">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {t('Givarvärden kunde inte användas för ny planering', 'Sensor readings could not be used for new planning')}
      </AlertTitle>
      <AlertDescription className="space-y-2 text-sm">
        <ul className="list-disc pl-5">
          {issues.map((issue) => (
            <li key={`${issue.device}:${issue.field}`}>
              {describeMeasurementIssue(issue, t)}
              {issue.entity_id && <span className="text-muted-foreground"> ({issue.entity_id})</span>}
            </li>
          ))}
        </ul>
        <p>
          {t(
            'Resten av hemmet planeras som vanligt. Accepterade instruktioner behålls där underlaget räcker. Kontrollera givaren; nya prognoser kan beräknas när värdena återkommer.',
            'The rest of the home is planned as usual. Accepted instructions are retained where sufficient evidence remains. Check the sensor; new forecasts can be calculated when readings return.',
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
