import React, { useState } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

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

const slugify = (text: string) =>
  text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

interface SortableOptionProps {
  opt: QuestionOption;
  onUpdate: (optionId: string, field: keyof QuestionOption, value: string) => void;
  onDelete: (optionId: string) => void;
}

const SortableOption: React.FC<SortableOptionProps> = ({ opt, onUpdate, onDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: opt.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">
      <button type="button" className="cursor-grab touch-none shrink-0" {...attributes} {...listeners}>
        <GripVertical className="w-4 h-4 text-muted-foreground" />
      </button>
      <Input
        value={opt.label_sv}
        onChange={e => onUpdate(opt.id, 'label_sv', e.target.value)}
        className="flex-1 text-xs"
        placeholder="🇸🇪 Label"
      />
      <Input
        value={opt.label_en}
        onChange={e => onUpdate(opt.id, 'label_en', e.target.value)}
        className="flex-1 text-xs"
        placeholder="🇬🇧 Label"
      />
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => onDelete(opt.id)}>
        <Trash2 className="w-3.5 h-3.5 text-destructive" />
      </Button>
    </div>
  );
};

const OptionsEditor: React.FC<OptionsEditorProps> = ({ questionId, options, onChange }) => {
  const { toast } = useToast();
  const { t } = useLanguage();
  const [newLabelSv, setNewLabelSv] = useState('');
  const [newLabelEn, setNewLabelEn] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sorted = [...options].sort((a, b) => a.order_index - b.order_index);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sorted.findIndex(o => o.id === active.id);
    const newIndex = sorted.findIndex(o => o.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...sorted];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    const updated = reordered.map((o, i) => ({ ...o, order_index: i }));
    onChange(updated);

    // Persist order updates
    const promises = updated
      .filter((o, i) => sorted[i]?.id !== o.id)
      .map(o => supabase.from('home_question_options').update({ order_index: o.order_index }).eq('id', o.id));

    const results = await Promise.all(promises);
    const failed = results.find(r => r.error);
    if (failed?.error) {
      toast({ title: t('Fel', 'Error'), description: failed.error.message, variant: 'destructive' });
    }
  };

  const handleAdd = async () => {
    const trimmedValue = slugify(newLabelEn) || slugify(newLabelSv);
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

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sorted.map(o => o.id)} strategy={verticalListSortingStrategy}>
          {sorted.map(opt => (
            <SortableOption key={opt.id} opt={opt} onUpdate={handleUpdate} onDelete={handleDelete} />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add new option */}
      <div className="flex items-center gap-2">
        <div className="w-4" />
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
          disabled={!newLabelSv.trim()}
          onClick={handleAdd}
        >
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default OptionsEditor;
