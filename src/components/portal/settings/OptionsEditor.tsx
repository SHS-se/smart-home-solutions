import React, { useState } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

export interface QuestionOption {
  id: string;
  question_id: string;
  value: string;
  label_sv: string;
  label_en: string;
  order_index: number;
}

interface OptionsEditorProps {
  questionId: string;
  options: QuestionOption[];
  onChange: (options: QuestionOption[]) => void;
}

const OptionsEditor: React.FC<OptionsEditorProps> = ({ questionId, options, onChange }) => {
  const { toast } = useToast();
  const { t } = useLanguage();
  const [newValue, setNewValue] = useState('');
  const [newLabelSv, setNewLabelSv] = useState('');
  const [newLabelEn, setNewLabelEn] = useState('');

  const handleAdd = async () => {
    const trimmedValue = newValue.trim();
    if (!trimmedValue || !newLabelSv.trim()) return;
    if (options.some(o => o.value === trimmedValue)) {
      toast({ title: t('Duplikat', 'Duplicate'), description: t('Värdet måste vara unikt.', 'Value must be unique.'), variant: 'destructive' });
      return;
    }

    const maxOrder = options.length > 0 ? Math.max(...options.map(o => o.order_index)) + 1 : 0;
    const { data, error } = await supabase.from('home_question_options').insert({
      question_id: questionId,
      value: trimmedValue,
      label_sv: newLabelSv.trim(),
      label_en: newLabelEn.trim(),
      order_index: maxOrder,
    }).select().single();

    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }

    onChange([...options, data as QuestionOption]);
    setNewValue('');
    setNewLabelSv('');
    setNewLabelEn('');
  };

  const handleDelete = async (optionId: string) => {
    const { error } = await supabase.from('home_question_options').delete().eq('id', optionId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }
    onChange(options.filter(o => o.id !== optionId));
  };

  const handleUpdate = async (optionId: string, field: keyof QuestionOption, value: string) => {
    const { error } = await supabase.from('home_question_options').update({ [field]: value }).eq('id', optionId);
    if (error) {
      toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }
    onChange(options.map(o => o.id === optionId ? { ...o, [field]: value } : o));
  };

  return (
    <div className="space-y-3 pl-4 border-l-2 border-primary/20">
      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('Svarsalternativ', 'Answer Options')}
      </Label>

      {options.sort((a, b) => a.order_index - b.order_index).map(opt => (
        <div key={opt.id} className="flex items-center gap-2">
          <GripVertical className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input
            value={opt.value}
            onChange={e => handleUpdate(opt.id, 'value', e.target.value)}
            className="w-24 text-xs"
            placeholder="value"
          />
          <Input
            value={opt.label_sv}
            onChange={e => handleUpdate(opt.id, 'label_sv', e.target.value)}
            className="flex-1 text-xs"
            placeholder="🇸🇪 Label"
          />
          <Input
            value={opt.label_en}
            onChange={e => handleUpdate(opt.id, 'label_en', e.target.value)}
            className="flex-1 text-xs"
            placeholder="🇬🇧 Label"
          />
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => handleDelete(opt.id)}>
            <Trash2 className="w-3.5 h-3.5 text-destructive" />
          </Button>
        </div>
      ))}

      {/* Add new option */}
      <div className="flex items-center gap-2">
        <div className="w-4" />
        <Input
          value={newValue}
          onChange={e => setNewValue(e.target.value)}
          className="w-24 text-xs"
          placeholder="value"
        />
        <Input
          value={newLabelSv}
          onChange={e => setNewLabelSv(e.target.value)}
          className="flex-1 text-xs"
          placeholder="🇸🇪 Label"
        />
        <Input
          value={newLabelEn}
          onChange={e => setNewLabelEn(e.target.value)}
          className="flex-1 text-xs"
          placeholder="🇬🇧 Label"
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          disabled={!newValue.trim() || !newLabelSv.trim()}
          onClick={handleAdd}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default OptionsEditor;
