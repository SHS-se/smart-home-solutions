import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  HOME_QUESTION_FEATURE_LABELS,
  HOME_QUESTION_FUNCTIONALITY,
  type HomeQuestionFunctionality,
} from '@/lib/home-question-functionality';

interface BoundQuestion {
  id: string;
  semantic_key: string | null;
}

interface QuestionFunctionalitySelectProps {
  value: string | null;
  questions: BoundQuestion[];
  currentQuestionId?: string;
  onChange: (definition: HomeQuestionFunctionality | null) => void;
  t: (sv: string, en: string) => string;
  className?: string;
}

const QuestionFunctionalitySelect: React.FC<QuestionFunctionalitySelectProps> = ({
  value,
  questions,
  currentQuestionId,
  onChange,
  t,
  className,
}) => (
  <Select
    value={value ?? '__none__'}
    onValueChange={(nextValue) => {
      const definition = nextValue === '__none__'
        ? null
        : HOME_QUESTION_FUNCTIONALITY.find((candidate) => candidate.key === nextValue) ?? null;
      onChange(definition);
    }}
  >
    <SelectTrigger className={className}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="__none__">
        {t('Ingen – endast informationsfråga', 'None – informational question only')}
      </SelectItem>
      {HOME_QUESTION_FUNCTIONALITY.map((definition) => {
        const usedByAnotherQuestion = questions.some((question) => (
          question.semantic_key === definition.key && question.id !== currentQuestionId
        ));
        const featureNames = definition.features.map((feature) => t(
          HOME_QUESTION_FEATURE_LABELS[feature].sv,
          HOME_QUESTION_FEATURE_LABELS[feature].en,
        )).join(' + ');
        return (
          <SelectItem
            key={definition.key}
            value={definition.key}
            disabled={usedByAnotherQuestion}
          >
            {t(definition.label.sv, definition.label.en)} · {featureNames}
          </SelectItem>
        );
      })}
    </SelectContent>
  </Select>
);

export default QuestionFunctionalitySelect;
