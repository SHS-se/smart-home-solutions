import React, { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  flattenTree,
  evaluateVisibility,
  type TreeQuestion,
  type DisplayRule,
  type AnswerMap,
  type QuestionType,
} from '@/lib/questionnaire-engine';
import type { QuestionOption } from './OptionsEditor';

interface QuestionnairePreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questions: TreeQuestion[];
  rules: DisplayRule[];
  options: Record<string, QuestionOption[]>;
}

const QuestionnairePreview: React.FC<QuestionnairePreviewProps> = ({
  open,
  onOpenChange,
  questions,
  rules,
  options,
}) => {
  const { t } = useLanguage();
  const [answers, setAnswers] = useState<AnswerMap>({});

  const activeQuestions = useMemo(
    () => questions.filter(q => q.is_active),
    [questions]
  );

  const flattened = useMemo(() => flattenTree(activeQuestions), [activeQuestions]);

  const setAnswer = (qId: string, value: unknown) => {
    setAnswers(prev => ({ ...prev, [qId]: value }));
  };

  const renderInput = (q: TreeQuestion) => {
    const type = q.question_type as QuestionType;
    const qOptions = options[q.id] || [];

    switch (type) {
      case 'boolean':
        return (
          <div className="flex items-center gap-3">
            <Switch
              checked={answers[q.id] === true}
              onCheckedChange={v => setAnswer(q.id, v)}
            />
            <span className="text-sm text-muted-foreground">
              {answers[q.id] === true ? t('Ja', 'Yes') : t('Nej', 'No')}
            </span>
          </div>
        );

      case 'number':
        return (
          <Input
            type="number"
            value={typeof answers[q.id] === 'number' ? answers[q.id] as number : ''}
            onChange={e => setAnswer(q.id, e.target.value ? Number(e.target.value) : null)}
            placeholder="0"
            className="max-w-[200px]"
          />
        );

      case 'single_choice':
        if (qOptions.length > 0) {
          return (
            <RadioGroup
              value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''}
              onValueChange={v => setAnswer(q.id, v)}
            >
              {qOptions.sort((a, b) => a.order_index - b.order_index).map(opt => (
                <div key={opt.id} className="flex items-center gap-2">
                  <RadioGroupItem value={opt.value} id={`preview-${q.id}-${opt.value}`} />
                  <Label htmlFor={`preview-${q.id}-${opt.value}`} className="text-sm cursor-pointer">
                    {t(opt.label_sv, opt.label_en || opt.label_sv)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          );
        }
        return <Input value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''} onChange={e => setAnswer(q.id, e.target.value)} />;

      case 'multi_choice': {
        const current = Array.isArray(answers[q.id]) ? answers[q.id] as string[] : [];
        if (qOptions.length > 0) {
          return (
            <div className="space-y-2">
              {qOptions.sort((a, b) => a.order_index - b.order_index).map(opt => (
                <div key={opt.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`preview-${q.id}-${opt.value}`}
                    checked={current.includes(opt.value)}
                    onCheckedChange={checked => {
                      const next = checked
                        ? [...current, opt.value]
                        : current.filter(v => v !== opt.value);
                      setAnswer(q.id, next);
                    }}
                  />
                  <Label htmlFor={`preview-${q.id}-${opt.value}`} className="text-sm cursor-pointer">
                    {t(opt.label_sv, opt.label_en || opt.label_sv)}
                  </Label>
                </div>
              ))}
            </div>
          );
        }
        return <Input value={current.join(', ')} onChange={e => setAnswer(q.id, e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />;
      }

      case 'text':
      default:
        return (
          <Textarea
            value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''}
            onChange={e => setAnswer(q.id, e.target.value)}
            placeholder={t('Ditt svar...', 'Your answer...')}
            rows={1}
            className="min-h-[40px] resize-y"
          />
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Förhandsgranskning', 'Preview')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {flattened.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('Inga aktiva frågor.', 'No active questions.')}</p>
          )}
          {flattened.map(q => {
            const visible = evaluateVisibility(q.id, rules, answers, activeQuestions);
            if (!visible) return null;

            return (
              <div key={q.id} className="space-y-2" style={{ paddingLeft: `${q.depth * 24}px` }}>
                <label className="text-sm font-medium">
                  {t((q as any).question_text, (q as any).question_text_en || (q as any).question_text)}
                </label>
                {renderInput(q)}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end pt-4">
          <Button variant="outline" onClick={() => { setAnswers({}); }}>
            {t('Återställ', 'Reset')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuestionnairePreview;
