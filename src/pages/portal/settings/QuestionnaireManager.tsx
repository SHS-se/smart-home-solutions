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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Question {
  id: string;
  question_text: string;
  question_text_en: string;
  question_type: string;
  display_on_contact_form: boolean;
  sort_order: number;
  is_active: boolean;
}

interface SortableQuestionProps {
  question: Question;
  editingId: string | null;
  editDraftSv: string;
  editDraftEn: string;
  editDraftType: string;
  setEditingId: (id: string | null) => void;
  setEditDraftSv: (text: string) => void;
  setEditDraftEn: (text: string) => void;
  setEditDraftType: (type: string) => void;
  onSaveEdit: (id: string) => void;
  onToggleActive: (id: string, active: boolean) => void;
  onToggleContactForm: (id: string, show: boolean) => void;
  t: (sv: string, en: string) => string;
}

const SortableQuestion: React.FC<SortableQuestionProps> = ({
  question,
  editingId,
  editDraftSv,
  editDraftEn,
  editDraftType,
  setEditingId,
  setEditDraftSv,
  setEditDraftEn,
  setEditDraftType,
  onSaveEdit,
  onToggleActive,
  onToggleContactForm,
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
            <div>
              <Label className="text-xs text-muted-foreground">{t('Typ', 'Type')}</Label>
              <Select value={editDraftType} onValueChange={setEditDraftType}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t('Text', 'Text')}</SelectItem>
                  <SelectItem value="boolean">{t('Ja/Nej', 'Yes/No')}</SelectItem>
                </SelectContent>
              </Select>
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
              <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {question.question_type === 'boolean' ? t('Ja/Nej', 'Yes/No') : t('Text', 'Text')}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0 h-7 w-7"
                onClick={() => {
                  setEditingId(question.id);
                  setEditDraftSv(question.question_text);
                  setEditDraftEn(question.question_text_en);
                  setEditDraftType(question.question_type);
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

      <div className="flex flex-col items-center gap-1 shrink-0">
        <span className="text-[10px] text-muted-foreground">{t('Aktiv', 'Active')}</span>
        <Switch
          checked={question.is_active}
          onCheckedChange={v => onToggleActive(question.id, v)}
        />
      </div>

      <div className="flex flex-col items-center gap-1 shrink-0">
        <span className="text-[10px] text-muted-foreground">{t('Kontaktformulär', 'Contact form')}</span>
        <Switch
          checked={question.display_on_contact_form}
          onCheckedChange={v => onToggleContactForm(question.id, v)}
        />
      </div>
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
  const [newQuestionType, setNewQuestionType] = useState('text');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraftSv, setEditDraftSv] = useState('');
  const [editDraftEn, setEditDraftEn] = useState('');
  const [editDraftType, setEditDraftType] = useState('text');

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
    if (data) setQuestions(data as Question[]);
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
        question_type: newQuestionType,
        sort_order: maxSort,
      });
      if (error) throw error;
      setNewQuestionSv('');
      setNewQuestionEn('');
      setNewQuestionType('text');
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
        question_type: editDraftType,
      }).eq('id', id);
      if (error) throw error;
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, question_text: editDraftSv.trim(), question_text_en: editDraftEn.trim(), question_type: editDraftType } : q));
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

  const handleToggleContactForm = async (id: string, show: boolean) => {
    try {
      const { error } = await supabase.from('home_questions').update({ display_on_contact_form: show }).eq('id', id);
      if (error) throw error;
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, display_on_contact_form: show } : q));
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
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('Typ', 'Type')}</Label>
                <Select value={newQuestionType} onValueChange={setNewQuestionType}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">{t('Text', 'Text')}</SelectItem>
                    <SelectItem value="boolean">{t('Ja/Nej', 'Yes/No')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleAdd} disabled={adding || !newQuestionSv.trim()} size="sm">
                {adding ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
                {t('Lägg till', 'Add')}
              </Button>
            </div>

            {/* Column headers */}
            {questions.length > 0 && (
              <div className="flex items-center gap-3 px-3 text-xs text-muted-foreground">
                <div className="w-5" /> {/* drag handle spacer */}
                <div className="flex-1">{t('Fråga', 'Question')}</div>
                <div className="w-[70px] text-center shrink-0">{t('Aktiv', 'Active')}</div>
                <div className="w-[90px] text-center shrink-0">{t('Kontaktformulär', 'Contact form')}</div>
              </div>
            )}

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
                        editDraftType={editDraftType}
                        setEditingId={setEditingId}
                        setEditDraftSv={setEditDraftSv}
                        setEditDraftEn={setEditDraftEn}
                        setEditDraftType={setEditDraftType}
                        onSaveEdit={handleSaveEdit}
                        onToggleActive={handleToggleActive}
                        onToggleContactForm={handleToggleContactForm}
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
