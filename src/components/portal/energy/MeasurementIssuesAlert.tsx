import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { describeMeasurementIssue, type MeasurementIssue } from '@/lib/energy-shift/measurement-issues';

/**
 * Devices the current plan leaves out because a reading was impossible or
 * missing.
 * Only those devices are affected; the rest of the home is planned as usual.
 */
export default function MeasurementIssuesAlert({ issues }: { issues: MeasurementIssue[] }) {
  const { t } = useLanguage();
  if (issues.length === 0) return null;
  return (
    <Alert data-testid="measurement-issues">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {t('Utelämnat ur planen: givarvärden kunde inte användas', 'Left out of this plan: sensor readings could not be used')}
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
            'Resten av hemmet planeras som vanligt. Kontrollera givaren; när den visar ett rimligt värde igen rekommenderas en omplanering.',
            'The rest of the home is planned as usual. Check the sensor; once it reports a real value again, a replan is recommended.',
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
