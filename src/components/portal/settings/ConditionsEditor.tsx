import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Json } from '@/integrations/supabase/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  getOperatorsForType,
  OPERATOR_LABELS,
  hasCycle,
  type DisplayRule,
  type TreeQuestion,
  type Operator,
  type QuestionType,
} from '@/lib/questionnaire-engine';
import type { QuestionOption } from './OptionsEditor';

interface ConditionsEditorProps {
  questionId: string;
  rules: DisplayRule[];
  allQuestions: TreeQuestion[];
  allOptions: Record<string, QuestionOption[]>;
  allRules: DisplayRule[];
  onChange: (rules: DisplayRule[]) => void;
}

const ConditionsEditor: React.FC<ConditionsEditorProps> = ({
  questionId,
  rules,
  allQuestions,
  allOptions,
  allRules,
  onChange,
}) => {
  const { toast } = useToast();
  const { t } = useLanguage();
  const hasRules = rules.length > 0;

  const handleToggle = async (enabled: boolean) => {
    if (!enabled && rules.length > 0) {
      // Delete all rules for this question
      const { error } = await supabase
        .from('home_question_display_rules')
        .delete()
        .eq('question_id', questionId);
      if (error) {
        toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
        return;
      }
      onChange([]);
    }
  };

  const handleAddRule = async () => {
    // Find a valid question to depend on (not self)
    const available = allQuestions.filter(q => q.id !== questionId);
    if (available.length === 0) return;

    const dependsOn = available[0];
    const operators = getOperatorsForType(dependsOn.question_type as QuestionType);
    const defaultOp = operators[0] || 'equals';
    const maxGroup = rules.length > 0 ? Math.max(...rules.map(r => r.logic_group)) : 0;

    // Cycle check
    const candidateRule: DisplayRule = {
      id: 'temp',
      question_id: questionId,
      depends_on_question_id: dependsOn.id,
      logic_group: maxGroup,
      operator: defaultOp,
      compare_value: null,
    };
    const testRules = [...allRules, candidateRule];
    if (hasCycle(testRules)) {
      toast({ title: t('Cykel upptäckt', 'Cycle detected'), description: t('Denna regel skulle skapa en cirkulär referens.', 'This rule would create a circular reference.'), variant: 'destructive' });
      return;
    }

    const { data, error } = await supabase.from('home_question_display_rules').insert({
      question_id: questionId,
      depends_on_question_id: dependsOn.id,
      logic_group: maxGroup,
      operator: defaultOp,
      compare_value: null,
    }).select().single();

    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }
    onChange([...rules, data as DisplayRule]);
  };

  const handleDeleteRule = async (ruleId: string) => {
    const { error } = await supabase.from('home_question_display_rules').delete().eq('id', ruleId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }
    onChange(rules.filter(r => r.id !== ruleId));
  };

  const handleUpdateRule = async (ruleId: string, updates: Partial<DisplayRule>) => {
    // Cycle check if changing depends_on
    if (updates.depends_on_question_id) {
      const updated = allRules.map(r => r.id === ruleId ? { ...r, ...updates } : r);
      if (hasCycle(updated)) {
        toast({ title: t('Cykel upptäckt', 'Cycle detected'), description: t('Denna ändring skulle skapa en cirkulär referens.', 'This change would create a circular reference.'), variant: 'destructive' });
        return;
      }
    }

    // Cast compare_value to Json for supabase compatibility
    const dbUpdates: Record<string, unknown> = { ...updates };
    if ('compare_value' in dbUpdates) {
      dbUpdates.compare_value = dbUpdates.compare_value as Json;
    }

    const { error } = await supabase.from('home_question_display_rules').update(dbUpdates as any).eq('id', ruleId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }
    onChange(rules.map(r => r.id === ruleId ? { ...r, ...updates } : r));
  };

  const renderValueInput = (rule: DisplayRule) => {
    const depQuestion = allQuestions.find(q => q.id === rule.depends_on_question_id);
    if (!depQuestion) return null;
    const type = depQuestion.question_type as QuestionType;

    if (rule.operator === 'is_true' || rule.operator === 'is_false') return null;

    if ((type === 'single_choice' || type === 'multi_choice') &&
      (rule.operator === 'equals' || rule.operator === 'not_equals' ||
        rule.operator === 'is_any_of' || rule.operator === 'is_not_any_of' ||
        rule.operator === 'contains' || rule.operator === 'not_contains')) {
      const opts = allOptions[rule.depends_on_question_id] || [];
      if (opts.length > 0) {
        return (
          <Select
            value={typeof rule.compare_value === 'string' ? rule.compare_value : ''}
            onValueChange={v => handleUpdateRule(rule.id, { compare_value: v as unknown })}
          >
            <SelectTrigger className="w-[140px] text-xs">
              <SelectValue placeholder={t('Välj...', 'Select...')} />
            </SelectTrigger>
            <SelectContent>
              {opts.map(o => (
                <SelectItem key={o.id} value={o.value}>{t(o.label_sv, o.label_en || o.label_sv)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
    }

    if (type === 'number') {
      return (
        <Input
          type="number"
          value={typeof rule.compare_value === 'number' ? rule.compare_value : ''}
          onChange={e => handleUpdateRule(rule.id, { compare_value: e.target.value ? Number(e.target.value) : null })}
          className="w-24 text-xs"
          placeholder="#"
        />
      );
    }

    return (
      <Input
        value={typeof rule.compare_value === 'string' ? rule.compare_value : ''}
        onChange={e => handleUpdateRule(rule.id, { compare_value: e.target.value || null })}
        className="w-32 text-xs"
        placeholder={t('Värde...', 'Value...')}
      />
    );
  };

  return (
    <div className="space-y-3 pl-4 border-l-2 border-primary/20">
      <div className="flex items-center gap-3">
        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t('Synlighetsvillkor', 'Visibility Conditions')}
        </Label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{hasRules ? t('Villkorlig', 'Conditional') : t('Alltid synlig', 'Always visible')}</span>
          <Switch checked={hasRules} onCheckedChange={handleToggle} />
        </div>
      </div>

      {hasRules && (
        <div className="space-y-2">
          {rules.map((rule, idx) => {
            const depQuestion = allQuestions.find(q => q.id === rule.depends_on_question_id);
            const operators = depQuestion ? getOperatorsForType(depQuestion.question_type as QuestionType) : [];
            const prevGroup = idx > 0 ? rules[idx - 1].logic_group : rule.logic_group;

            return (
              <React.Fragment key={rule.id}>
                {idx > 0 && rule.logic_group !== prevGroup && (
                  <Badge variant="outline" className="text-[10px]">{t('ELLER', 'OR')}</Badge>
                )}
                {idx > 0 && rule.logic_group === prevGroup && (
                  <span className="text-[10px] text-muted-foreground px-1">{t('OCH', 'AND')}</span>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <Select
                    value={rule.depends_on_question_id}
                    onValueChange={v => handleUpdateRule(rule.id, { depends_on_question_id: v })}
                  >
                    <SelectTrigger className="w-[200px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {allQuestions.filter(q => q.id !== questionId).map(q => (
                        <SelectItem key={q.id} value={q.id}>
                          {(q as any).question_text?.substring(0, 40) || q.id.substring(0, 8)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={rule.operator}
                    onValueChange={v => handleUpdateRule(rule.id, { operator: v as Operator })}
                  >
                    <SelectTrigger className="w-[150px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map(op => (
                        <SelectItem key={op} value={op}>
                          {t(OPERATOR_LABELS[op].sv, OPERATOR_LABELS[op].en)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {renderValueInput(rule)}

                  <Input
                    type="number"
                    value={rule.logic_group}
                    onChange={e => handleUpdateRule(rule.id, { logic_group: Number(e.target.value) || 0 })}
                    className="w-16 text-xs"
                    title={t('Logikgrupp (ELLER mellan grupper)', 'Logic group (OR between groups)')}
                  />

                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDeleteRule(rule.id)}>
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}

      <Button size="sm" variant="outline" onClick={handleAddRule} className="text-xs">
        <Plus className="w-3.5 h-3.5 mr-1" /> {t('Lägg till villkor', 'Add condition')}
      </Button>
    </div>
  );
};

export default ConditionsEditor;
