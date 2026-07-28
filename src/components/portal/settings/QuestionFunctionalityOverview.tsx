import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Link2,
  Plus,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  HOME_QUESTION_FEATURE_LABELS,
  HOME_QUESTION_FUNCTIONALITY,
  type HomeQuestionFunctionality,
} from '@/lib/home-question-functionality';
import type { QuestionType } from '@/lib/questionnaire-engine';

interface FunctionalityQuestion {
  id: string;
  is_active: boolean;
  question_text: string;
  question_type: QuestionType;
  semantic_key: string | null;
}

interface QuestionFunctionalityOverviewProps {
  questions: FunctionalityQuestion[];
  onCreateQuestion: (definition: HomeQuestionFunctionality) => void;
  t: (sv: string, en: string) => string;
}

type FunctionalityStatus = 'missing' | 'inactive' | 'wrong_type' | 'connected';

interface FunctionalityRowProps {
  definition: HomeQuestionFunctionality;
  question: FunctionalityQuestion | null;
  status: FunctionalityStatus;
  onCreateQuestion: (definition: HomeQuestionFunctionality) => void;
  t: (sv: string, en: string) => string;
}

const FunctionalityRow: React.FC<FunctionalityRowProps> = ({
  definition,
  question,
  status,
  onCreateQuestion,
  t,
}) => (
  <div className="rounded-xl border border-border/70 bg-background/80 p-3 shadow-sm">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="font-medium">{t(definition.label.sv, definition.label.en)}</p>
          <Badge
            variant={definition.importance === 'required' ? 'default' : 'outline'}
            className="text-[10px]"
          >
            {definition.importance === 'required'
              ? t('Krävs', 'Required')
              : definition.importance === 'recommended'
                ? t('Rekommenderas', 'Recommended')
                : t('Valfri', 'Optional')}
          </Badge>
          <Badge
            variant={definition.dataUse === 'calculation' ? 'outline' : 'secondary'}
            className={definition.dataUse === 'calculation'
              ? 'border-emerald-300 text-[10px] text-emerald-800 dark:border-emerald-900 dark:text-emerald-200'
              : 'text-[10px]'}
          >
            {definition.dataUse === 'calculation'
              ? t('Används nu', 'Used now')
              : t('Inte i beräkningen ännu', 'Not calculated yet')}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {definition.features.map((feature) => (
            <Badge key={feature} variant="secondary" className="text-[10px]">
              {t(
                HOME_QUESTION_FEATURE_LABELS[feature].sv,
                HOME_QUESTION_FEATURE_LABELS[feature].en,
              )}
            </Badge>
          ))}
        </div>
      </div>
      {status === 'connected' ? (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
      ) : status === 'missing' ? (
        <CircleDashed className="h-5 w-5 shrink-0 text-muted-foreground" />
      ) : (
        <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
      )}
    </div>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
      {t(definition.purpose.sv, definition.purpose.en)}
    </p>
    {definition.dataUse === 'setup_only' && (
      <p className="mt-1 text-[11px] font-medium text-violet-700 dark:text-violet-300">
        {t(
          'Svaret visas i energiinställningarna men påverkar ännu inte simuleringen.',
          'The answer appears in energy setup but does not yet affect the simulation.',
        )}
      </p>
    )}
    <div className="mt-3 flex min-h-8 items-center justify-between gap-2 border-t pt-2">
      {status === 'missing' ? (
        <>
          <span className="text-xs text-muted-foreground">
            {t('Ingen fråga är kopplad', 'No question is connected')}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onCreateQuestion(definition)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('Skapa fråga', 'Create question')}
          </Button>
        </>
      ) : (
        <>
          <span className="truncate text-xs" title={question?.question_text}>
            {question?.question_text}
          </span>
          <Badge
            variant={status === 'connected' ? 'outline' : 'destructive'}
            className="shrink-0 text-[10px]"
          >
            {status === 'connected'
              ? t('Kopplad', 'Connected')
              : status === 'inactive'
                ? t('Inaktiv fråga', 'Inactive question')
                : t('Fel svarstyp', 'Wrong answer type')}
          </Badge>
        </>
      )}
    </div>
  </div>
);

const QuestionFunctionalityOverview: React.FC<QuestionFunctionalityOverviewProps> = ({
  questions,
  onCreateQuestion,
  t,
}) => {
  const [showFutureInputs, setShowFutureInputs] = useState(false);
  const rows = useMemo(() => HOME_QUESTION_FUNCTIONALITY.map((definition) => {
    const question = questions.find((candidate) => candidate.semantic_key === definition.key) ?? null;
    const status: FunctionalityStatus = !question
      ? 'missing'
      : !question.is_active
        ? 'inactive'
        : question.question_type !== definition.type
          ? 'wrong_type'
          : 'connected';
    return { definition, question, status };
  }), [questions]);

  const calculationRows = rows.filter((row) => row.definition.dataUse === 'calculation');
  const calculationReadyCount = calculationRows.filter((row) => row.status === 'connected').length;
  const attentionCount = calculationRows.length - calculationReadyCount;
  const setupOnlyRows = rows.filter((row) => row.definition.dataUse === 'setup_only');
  const setupOnlyConnectedCount = setupOnlyRows.filter((row) => row.status === 'connected').length;
  const informationalCount = questions.filter((question) => !question.semantic_key).length;
  const unknownBindingCount = questions.filter((question) => (
    question.semantic_key
    && !HOME_QUESTION_FUNCTIONALITY.some((definition) => definition.key === question.semantic_key)
  )).length;

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-background to-violet-500/5">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-primary" />
              {t('Kopplingar till webbplatsens funktioner', 'Website functionality connections')}
            </CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {t(
                'En koppling gör att kundens svar används av en namngiven funktion. Frågor utan koppling är fortfarande tillåtna, men är endast informationsfrågor.',
                'A connection makes the customer answer available to a named feature. Unconnected questions are still allowed, but are informational only.',
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-emerald-600 hover:bg-emerald-600">
              {calculationReadyCount}/{calculationRows.length} {t('beräkningskopplingar klara', 'calculation links ready')}
            </Badge>
            {attentionCount > 0 && (
              <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {attentionCount} {t('behöver åtgärd', 'need attention')}
              </Badge>
            )}
            <Badge variant="secondary">
              {setupOnlyConnectedCount}/{setupOnlyRows.length} {t('framtida indata kopplade', 'future inputs connected')}
            </Badge>
            <Badge variant="secondary">
              {informationalCount} {t('fria informationsfrågor', 'free informational questions')}
            </Badge>
            {unknownBindingCount > 0 && (
              <Badge variant="destructive">
                {unknownBindingCount} {t('inaktuell koppling', 'unused binding')}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('Aktiva beräkningar och kontroller', 'Active calculations and checks')}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {calculationRows.map(({ definition, question, status }) => (
            <FunctionalityRow
              key={definition.key}
              definition={definition}
              question={question}
              status={status}
              onCreateQuestion={onCreateQuestion}
              t={t}
            />
          ))}
        </div>

        <div className="mt-4 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between px-2 py-2"
            onClick={() => setShowFutureInputs((current) => !current)}
          >
            <span className="text-left">
              <span className="block text-sm font-medium">
                {t('Framtida simulatorindata', 'Future simulator inputs')}
              </span>
              <span className="block text-xs font-normal text-muted-foreground">
                {t(
                  `${setupOnlyConnectedCount} av ${setupOnlyRows.length} kopplade · samlas in men används inte i beräkningen ännu`,
                  `${setupOnlyConnectedCount} of ${setupOnlyRows.length} connected · collected but not calculated yet`,
                )}
              </span>
            </span>
            {showFutureInputs
              ? <ChevronDown className="h-4 w-4" />
              : <ChevronRight className="h-4 w-4" />}
          </Button>
          {showFutureInputs && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {setupOnlyRows.map(({ definition, question, status }) => (
                <FunctionalityRow
                  key={definition.key}
                  definition={definition}
                  question={question}
                  status={status}
                  onCreateQuestion={onCreateQuestion}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default QuestionFunctionalityOverview;
