import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import type { PlanningWarning } from '../../../../supabase/functions/_shared/planner/planning-warnings';

export default function PlanningWarningsAlert({ warnings }: { warnings: readonly PlanningWarning[] }) {
  const { t } = useLanguage();
  if (!warnings.length) return null;
  return (
    <Alert role="status" variant={warnings.some(warning => warning.severity === 'error') ? 'destructive' : 'default'} data-testid="planning-warnings">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{t('Planeringen fortsätter med osäkra uppgifter', 'Planning continues with uncertain data')}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-2 pl-5">
          {warnings.map(warning => <li key={`${warning.scope}:${warning.code}`}>
            <span className="font-medium">{warning.message}</span>{' '}{warning.consequence}
          </li>)}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
