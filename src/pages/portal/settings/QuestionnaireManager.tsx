import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, GripVertical, Pencil, Check, X } from 'lucide-react';
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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Question {
  id: string;
  question_text: string;
  question_text_en: string;
  sort_order: number;
  is_active: boolean;
}

interface SortableQuestionProps {
  question: Question;
  editingId: string | null;
  editDraftSv: string;
  editDraftEn: string;
  setEditingId: (id: string | null) => void;
  setEditDraftSv: (text: string) => void;
  setEditDraftEn: (text: string) => void;
  onSaveEdit: (id: string) => void;
  onToggleActive: (id: string, active: boolean) => void;
  t: (sv: string, en: string) => string;
}

const SortableQuestion: React.FC<SortableQuestionProps> = ({
  question,
  editingId,
  editDraftSv,
  editDraftEn,
  setEditingId,
  setEditDraftSv,
  setEditDraftEn,
  onSaveEdit,
  onToggleActive,
  t,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: question.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-start gap-3 p-3 rounded-lg border ${!question.is_active ? 'opacity-50' : ''} ${isDragging ? 'opacity-70 shadow-lg bg-muted' : 'bg-card'}`}
    >
      <button
        className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground mt-1"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-5 h-5" />
      </button>

      <div className="flex-1 min-w-0">
        {editingId === question.id ? (
          <div className="space-y-2">
            <div>
              <Label className="text-xs text-muted-foreground">🇸🇪 Svenska</Label>
              <Input
                value={editDraftSv}
                onChange={e => setEditDraftSv(e.target.value)}
                className="text-sm"
                onKeyDown={e => e.key === 'Enter' && onSaveEdit(question.id)}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">🇬🇧 English</Label>
              <Input
                value={editDraftEn}
                onChange={e => setEditDraftEn(e.target.value)}
                className="text-sm"
                onKeyDown={e => e.key === 'Enter' && onSaveEdit(question.id)}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => onSaveEdit(question.id)}>
                <Check className="w-4 h-4 mr-1" /> {t('Spara', 'Save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                <X className="w-4 h-4 mr-1" /> {t('Avbryt', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm">{question.question_text}</span>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0 h-7 w-7"
                onClick={() => {
                  setEditingId(question.id);
                  setEditDraftSv(question.question_text);
                  setEditDraftEn(question.question_text_en);
                }}
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
            </div>
            {question.question_text_en && (
              <span className="text-xs text-muted-foreground">{question.question_text_en}</span>
            )}
          </div>
        )}
      </div>

      <Switch
        checked={question.is_active}
        onCheckedChange={v => onToggleActive(question.id, v)}
        className="mt-1"
      />
    </div>
  );
};

const QuestionnaireManager: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useLanguage();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [newQuestionSv, setNewQuestionSv] = useState('');
  const [newQuestionEn, setNewQuestionEn] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraftSv, setEditDraftSv] = useState('');
  const [editDraftEn, setEditDraftEn] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  const fetchQuestions = async () => {
    setLoadingData(true);
    const { data } = await supabase.from('home_questions').select('*').order('sort_order');
    if (data) setQuestions(data);
    setLoadingData(false);
  };

  useEffect(() => { fetchQuestions(); }, []);

  const handleAdd = async () => {
    if (!newQuestionSv.trim()) return;
    setAdding(true);
    try {
      const maxSort = questions.length > 0 ? Math.max(...questions.map(q => q.sort_order)) + 1 : 0;
      const { error } = await supabase.from('home_questions').insert({
        question_text: newQuestionSv.trim(),
        question_text_en: newQuestionEn.trim(),
        sort_order: maxSort,
      });
      if (error) throw error;
      setNewQuestionSv('');
      setNewQuestionEn('');
      await fetchQuestions();
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (!editDraftSv.trim()) return;
    try {
      const { error } = await supabase.from('home_questions').update({
        question_text: editDraftSv.trim(),
        question_text_en: editDraftEn.trim(),
      }).eq('id', id);
      if (error) throw error;
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, question_text: editDraftSv.trim(), question_text_en: editDraftEn.trim() } : q));
      setEditingId(null);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    }
  };

  const handleToggleActive = async (id: string, active: boolean) => {
    try {
      const { error } = await supabase.from('home_questions').update({ is_active: active }).eq('id', id);
      if (error) throw error;
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, is_active: active } : q));
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = questions.findIndex(q => q.id === active.id);
    const newIndex = questions.findIndex(q => q.id === over.id);
    const reordered = arrayMove(questions, oldIndex, newIndex);
    const updated = reordered.map((q, idx) => ({ ...q, sort_order: idx }));
    setQuestions(updated);

    try {
      await Promise.all(
        updated.map(q =>
          supabase.from('home_questions').update({ sort_order: q.sort_order }).eq('id', q.id)
        )
      );
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
      await fetchQuestions();
    }
  };

  if (authLoading || loadingData) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <h1 className="text-3xl font-medium">{t('Hantera frågor', 'Manage Questions')}</h1>
        <p className="text-muted-foreground">{t('Dessa frågor visas på kundens hemprofil.', 'These questions appear on the customer home profile.')}</p>

        <Card>
          <CardHeader>
            <CardTitle>{t('Frågor', 'Questions')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Add new */}
            <div className="space-y-2 border rounded-lg p-3">
              <div>
                <Label className="text-xs text-muted-foreground">🇸🇪 Svenska</Label>
                <Input
                  value={newQuestionSv}
                  onChange={e => setNewQuestionSv(e.target.value)}
                  placeholder={t('Ny fråga (svenska)...', 'New question (Swedish)...')}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">🇬🇧 English</Label>
                <Input
                  value={newQuestionEn}
                  onChange={e => setNewQuestionEn(e.target.value)}
                  placeholder={t('Ny fråga (engelska)...', 'New question (English)...')}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()}
                />
              </div>
              <Button onClick={handleAdd} disabled={adding || !newQuestionSv.trim()} size="sm">
                {adding ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
                {t('Lägg till', 'Add')}
              </Button>
            </div>

            {/* List */}
            {questions.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('Inga frågor ännu.', 'No questions yet.')}</p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={questions.map(q => q.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {questions.map(q => (
                      <SortableQuestion
                        key={q.id}
                        question={q}
                        editingId={editingId}
                        editDraftSv={editDraftSv}
                        editDraftEn={editDraftEn}
                        setEditingId={setEditingId}
                        setEditDraftSv={setEditDraftSv}
                        setEditDraftEn={setEditDraftEn}
                        onSaveEdit={handleSaveEdit}
                        onToggleActive={handleToggleActive}
                        t={t}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default QuestionnaireManager;
