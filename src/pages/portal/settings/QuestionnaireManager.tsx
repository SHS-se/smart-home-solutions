import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, GripVertical, Pencil, Check, X, ChevronRight, ChevronDown, Eye, ArrowRight, ArrowLeft, Filter, Trash2 } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { flattenTree, TYPE_LABELS, type TreeQuestion, type DisplayRule, type QuestionType } from '@/lib/questionnaire-engine';
import OptionsEditor, { type QuestionOption } from '@/components/portal/settings/OptionsEditor';
import ConditionsEditor from '@/components/portal/settings/ConditionsEditor';
import QuestionnairePreview from '@/components/portal/settings/QuestionnairePreview';

interface Question extends TreeQuestion {
  question_text: string;
  question_text_en: string;
  display_on_contact_form: boolean;
  sort_order: number;
  allow_other: boolean;
}

// ── Sortable Row ────────────────────────────────────────────────────────────

interface SortableRowProps {
  question: Question & { depth: number };
  editingId: string | null;
  editDraft: { sv: string; en: string; type: string };
  setEditingId: (id: string | null) => void;
  setEditDraft: (d: { sv: string; en: string; type: string }) => void;
  onSaveEdit: (id: string) => void;
  onToggleActive: (id: string, active: boolean) => void;
  onToggleContactForm: (id: string, show: boolean) => void;
  onToggleAllowOther: (id: string, allow: boolean) => void;
  onDelete: (id: string) => void;
  collapsed: Set<string>;
  toggleCollapse: (id: string) => void;
  hasChildren: boolean;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  canIndent: boolean;
  canOutdent: boolean;
  options: QuestionOption[];
  onOptionsChange: (questionId: string, opts: QuestionOption[]) => void;
  rules: DisplayRule[];
  allQuestions: Question[];
  allOptions: Record<string, QuestionOption[]>;
  allRules: DisplayRule[];
  onRulesChange: (questionId: string, rules: DisplayRule[]) => void;
  t: (sv: string, en: string) => string;
}

const SortableRow: React.FC<SortableRowProps> = ({
  question,
  editingId,
  editDraft,
  setEditingId,
  setEditDraft,
  onSaveEdit,
  onToggleActive,
  onToggleContactForm,
  onToggleAllowOther,
  onDelete,
  collapsed,
  toggleCollapse,
  hasChildren,
  onIndent,
  onOutdent,
  canIndent,
  canOutdent,
  options,
  onOptionsChange,
  rules,
  allQuestions,
  allOptions,
  allRules,
  onRulesChange,
  t,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: question.id });
  const [showOptions, setShowOptions] = useState(false);
  const [showConditions, setShowConditions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isChoiceType = question.question_type === 'single_choice' || question.question_type === 'multi_choice';
  const isCollapsed = collapsed.has(question.id);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    paddingLeft: `${question.depth * 24}px`,
  };

  const typeLabel = TYPE_LABELS[question.question_type as QuestionType];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border ${!question.is_active ? 'opacity-50' : ''} ${isDragging ? 'opacity-70 shadow-lg bg-muted' : 'bg-card'}`}
    >
      <div className="flex items-center gap-2 p-3">
        <button
          className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="w-5 h-5" />
        </button>

        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => toggleCollapse(question.id)}
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm">{question.question_text}</span>
          <Badge variant="secondary" className="text-[10px]">
            {typeLabel ? t(typeLabel.sv, typeLabel.en) : question.question_type}
          </Badge>
          {rules.length > 0 && (
            <Badge variant="outline" className="text-[10px] gap-1">
              <Filter className="w-3 h-3" /> {rules.length}
            </Badge>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 h-7 w-7"
            onClick={() => {
              setEditingId(question.id);
              setEditDraft({ sv: question.question_text, en: question.question_text_en, type: question.question_type });
            }}
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[10px] text-muted-foreground">{t('Aktiv', 'Active')}</span>
          <Switch checked={question.is_active} onCheckedChange={v => onToggleActive(question.id, v)} />
        </div>

        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-[10px] text-muted-foreground">{t('Kontakt', 'Contact')}</span>
          <Switch checked={question.display_on_contact_form} onCheckedChange={v => onToggleContactForm(question.id, v)} />
        </div>
      </div>

      {/* Collapsible detail content */}
      {!isCollapsed && (
        <div className="px-3 pb-3 space-y-3" style={{ paddingLeft: `${40 + question.depth * 24}px` }}>
          {editingId === question.id && (
            <div className="space-y-2">
              <div>
                <Label className="text-xs text-muted-foreground">🇸🇪 Svenska</Label>
                <Input
                  value={editDraft.sv}
                  onChange={e => setEditDraft({ ...editDraft, sv: e.target.value })}
                  className="text-sm"
                  onKeyDown={e => e.key === 'Enter' && onSaveEdit(question.id)}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">🇬🇧 English</Label>
                <Input
                  value={editDraft.en}
                  onChange={e => setEditDraft({ ...editDraft, en: e.target.value })}
                  className="text-sm"
                  onKeyDown={e => e.key === 'Enter' && onSaveEdit(question.id)}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('Typ', 'Type')}</Label>
                <Select value={editDraft.type} onValueChange={v => setEditDraft({ ...editDraft, type: v })}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{t(label.sv, label.en)}</SelectItem>
                    ))}
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
          )}

          {editingId !== question.id && (
            <>
              {question.question_text_en && (
                <span className="text-xs text-muted-foreground">{question.question_text_en}</span>
              )}
              <div className="flex gap-1 flex-wrap">
                {canIndent && (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => onIndent(question.id)}>
                    <ArrowRight className="w-3 h-3 mr-0.5" /> {t('Indrag', 'Indent')}
                  </Button>
                )}
                {canOutdent && (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => onOutdent(question.id)}>
                    <ArrowLeft className="w-3 h-3 mr-0.5" /> {t('Utdrag', 'Outdent')}
                  </Button>
                )}
                {isChoiceType && (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => setShowOptions(!showOptions)}>
                    {showOptions ? t('Dölj alternativ', 'Hide options') : t('Alternativ', 'Options')} ({options.length})
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => setShowConditions(!showConditions)}>
                  {showConditions ? t('Dölj villkor', 'Hide conditions') : t('Villkor', 'Conditions')} ({rules.length})
                </Button>
                {isChoiceType && (
                  <Button
                    size="sm"
                    variant={question.allow_other ? 'default' : 'ghost'}
                    className="h-6 px-1.5 text-[10px]"
                    onClick={() => onToggleAllowOther(question.id, !question.allow_other)}
                  >
                    {t('Annat', 'Other')}
                  </Button>
                )}
                {!confirmDelete ? (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="w-3 h-3 mr-0.5" /> {t('Radera', 'Delete')}
                  </Button>
                ) : (
                  <div className="flex gap-1 items-center">
                    <span className="text-[10px] text-destructive">{t('Säker?', 'Sure?')}</span>
                    <Button size="sm" variant="destructive" className="h-6 px-1.5 text-[10px]" onClick={() => { onDelete(question.id); setConfirmDelete(false); }}>
                      {t('Ja', 'Yes')}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => setConfirmDelete(false)}>
                      {t('Nej', 'No')}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {showOptions && isChoiceType && (
            <OptionsEditor
              questionId={question.id}
              options={options}
              onChange={opts => onOptionsChange(question.id, opts)}
            />
          )}
          {showConditions && (
            <ConditionsEditor
              questionId={question.id}
              parentQuestionId={question.parent_question_id}
              rules={rules}
              allQuestions={allQuestions as TreeQuestion[]}
              allOptions={allOptions}
              allRules={allRules}
              onChange={r => onRulesChange(question.id, r)}
            />
          )}
        </div>
      )}
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────────────

const QuestionnaireManager: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useLanguage();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [options, setOptions] = useState<Record<string, QuestionOption[]>>({});
  const [rules, setRules] = useState<DisplayRule[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showPreview, setShowPreview] = useState(false);

  // Add question form
  const [newQuestionSv, setNewQuestionSv] = useState('');
  const [newQuestionEn, setNewQuestionEn] = useState('');
  const [newQuestionType, setNewQuestionType] = useState<string>('text');
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ sv: '', en: '', type: 'text' });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  const fetchAll = async () => {
    setLoadingData(true);
    const [qRes, oRes, rRes] = await Promise.all([
      supabase.from('home_questions').select('*').order('order_index'),
      supabase.from('home_question_options').select('*').order('order_index'),
      supabase.from('home_question_display_rules').select('*'),
    ]);

    if (qRes.data) setQuestions(qRes.data as Question[]);
    if (oRes.data) {
      const grouped: Record<string, QuestionOption[]> = {};
      for (const o of oRes.data as QuestionOption[]) {
        if (!grouped[o.question_id]) grouped[o.question_id] = [];
        grouped[o.question_id].push(o);
      }
      setOptions(grouped);
    }
    if (rRes.data) setRules(rRes.data as DisplayRule[]);
    setLoadingData(false);
  };

  useEffect(() => { fetchAll(); }, []);

  // Build flat tree for display
  const flatQuestions = useMemo(() => {
    const flat = flattenTree(questions);
    // Filter out collapsed children
    const visible: typeof flat = [];
    const collapsedAncestors = new Set<string>();
    for (const q of flat) {
      if (q.parent_question_id && collapsedAncestors.has(q.parent_question_id)) {
        collapsedAncestors.add(q.id);
        continue;
      }
      if (collapsed.has(q.id)) {
        collapsedAncestors.add(q.id);
      }
      visible.push(q);
    }
    return visible;
  }, [questions, collapsed]);

  const childrenMap = useMemo(() => {
    const map = new Set<string>();
    for (const q of questions) {
      if (q.parent_question_id) map.add(q.parent_question_id);
    }
    return map;
  }, [questions]);

  const toggleCollapse = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = async () => {
    if (!newQuestionSv.trim()) return;
    setAdding(true);
    try {
      const maxOrder = questions.length > 0 ? Math.max(...questions.map(q => q.order_index)) + 1 : 0;
      const { error } = await supabase.from('home_questions').insert({
        question_text: newQuestionSv.trim(),
        question_text_en: newQuestionEn.trim(),
        question_type: newQuestionType,
        sort_order: maxOrder,
        order_index: maxOrder,
      });
      if (error) throw error;
      setNewQuestionSv('');
      setNewQuestionEn('');
      setNewQuestionType('text');
      await fetchAll();
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (!editDraft.sv.trim()) return;
    try {
      const { error } = await supabase.from('home_questions').update({
        question_text: editDraft.sv.trim(),
        question_text_en: editDraft.en.trim(),
        question_type: editDraft.type,
      }).eq('id', id);
      if (error) throw error;
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, question_text: editDraft.sv.trim(), question_text_en: editDraft.en.trim(), question_type: editDraft.type as QuestionType } : q));
      setEditingId(null);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    }
  };

  const handleToggleActive = async (id: string, active: boolean) => {
    const { error } = await supabase.from('home_questions').update({ is_active: active }).eq('id', id);
    if (error) { toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' }); return; }
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, is_active: active } : q));
  };

  const handleToggleContactForm = async (id: string, show: boolean) => {
    const { error } = await supabase.from('home_questions').update({ display_on_contact_form: show }).eq('id', id);
    if (error) { toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' }); return; }
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, display_on_contact_form: show } : q));
  };

  const handleToggleAllowOther = async (id: string, allow: boolean) => {
    const { error } = await supabase.from('home_questions').update({ allow_other: allow } as any).eq('id', id);
    if (error) { toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' }); return; }
    setQuestions(prev => prev.map(q => q.id === id ? { ...q, allow_other: allow } : q));
  };

  const handleDelete = async (id: string) => {
    try {
      // Delete options, rules, and answers first
      await Promise.all([
        supabase.from('home_question_options').delete().eq('question_id', id),
        supabase.from('home_question_display_rules').delete().eq('question_id', id),
        supabase.from('home_question_display_rules').delete().eq('depends_on_question_id', id),
        supabase.from('home_answers').delete().eq('question_id', id),
        supabase.from('home_profile_draft_answers').delete().eq('question_id', id),
      ]);
      // Re-parent children to this question's parent
      const q = questions.find(x => x.id === id);
      if (q) {
        const children = questions.filter(x => x.parent_question_id === id);
        if (children.length > 0) {
          await Promise.all(
            children.map(c => supabase.from('home_questions').update({ parent_question_id: q.parent_question_id }).eq('id', c.id))
          );
        }
      }
      const { error } = await supabase.from('home_questions').delete().eq('id', id);
      if (error) throw error;
      await fetchAll();
      toast({ title: t('Borttagen', 'Deleted'), description: t('Frågan har raderats.', 'Question has been deleted.') });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    }
  };

  const handleIndent = async (id: string) => {
    // Make this question a child of the previous sibling at the same level
    const q = questions.find(x => x.id === id);
    if (!q) return;
    const siblings = questions.filter(x => x.parent_question_id === q.parent_question_id).sort((a, b) => a.order_index - b.order_index);
    const idx = siblings.findIndex(x => x.id === id);
    if (idx <= 0) return;
    const newParent = siblings[idx - 1].id;
    const { error } = await supabase.from('home_questions').update({ parent_question_id: newParent }).eq('id', id);
    if (error) { toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' }); return; }
    setQuestions(prev => prev.map(x => x.id === id ? { ...x, parent_question_id: newParent } : x));
  };

  const handleOutdent = async (id: string) => {
    const q = questions.find(x => x.id === id);
    if (!q || !q.parent_question_id) return;
    const parent = questions.find(x => x.id === q.parent_question_id);
    const newParent = parent?.parent_question_id ?? null;
    const { error } = await supabase.from('home_questions').update({ parent_question_id: newParent }).eq('id', id);
    if (error) { toast({ title: t('Fel', 'Error'), description: error.message, variant: 'destructive' }); return; }
    setQuestions(prev => prev.map(x => x.id === id ? { ...x, parent_question_id: newParent } : x));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = flatQuestions.findIndex(q => q.id === active.id);
    const newIndex = flatQuestions.findIndex(q => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    // Get siblings of the dragged item's parent
    const draggedQ = questions.find(q => q.id === active.id);
    if (!draggedQ) return;

    const siblings = questions
      .filter(q => q.parent_question_id === draggedQ.parent_question_id)
      .sort((a, b) => a.order_index - b.order_index);

    const sibOldIdx = siblings.findIndex(q => q.id === active.id);
    const sibNewIdx = siblings.findIndex(q => q.id === over.id);
    if (sibOldIdx < 0 || sibNewIdx < 0) return; // Only reorder within same parent

    const reordered = arrayMove(siblings, sibOldIdx, sibNewIdx);
    const updates = reordered.map((q, idx) => ({ id: q.id, order_index: idx }));

    setQuestions(prev => prev.map(q => {
      const update = updates.find(u => u.id === q.id);
      return update ? { ...q, order_index: update.order_index } : q;
    }));

    try {
      await Promise.all(
        updates.map(u => supabase.from('home_questions').update({ order_index: u.order_index, sort_order: u.order_index }).eq('id', u.id))
      );
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
      await fetchAll();
    }
  };

  const handleOptionsChange = (questionId: string, opts: QuestionOption[]) => {
    setOptions(prev => ({ ...prev, [questionId]: opts }));
  };

  const handleRulesChange = (questionId: string, questionRules: DisplayRule[]) => {
    setRules(prev => [
      ...prev.filter(r => r.question_id !== questionId),
      ...questionRules,
    ]);
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
      <div className="space-y-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-medium">{t('Hantera frågor', 'Manage Questions')}</h1>
            <p className="text-muted-foreground">{t('Bygg ett frågeträd med villkorlig synlighet.', 'Build a question tree with conditional visibility.')}</p>
          </div>
          <Button variant="outline" onClick={() => setShowPreview(true)}>
            <Eye className="w-4 h-4 mr-2" /> {t('Förhandsgranska', 'Preview')}
          </Button>
        </div>

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
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{t(label.sv, label.en)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleAdd} disabled={adding || !newQuestionSv.trim()} size="sm">
                {adding ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
                {t('Lägg till', 'Add')}
              </Button>
            </div>

            {/* List */}
            {flatQuestions.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('Inga frågor ännu.', 'No questions yet.')}</p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={flatQuestions.map(q => q.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {flatQuestions.map(q => {
                      const questionObj = q as Question & { depth: number };
                      const siblings = questions.filter(x => x.parent_question_id === questionObj.parent_question_id).sort((a, b) => a.order_index - b.order_index);
                      const sibIdx = siblings.findIndex(x => x.id === questionObj.id);

                      return (
                        <SortableRow
                          key={questionObj.id}
                          question={questionObj}
                          editingId={editingId}
                          editDraft={editDraft}
                          setEditingId={setEditingId}
                          setEditDraft={setEditDraft}
                          onSaveEdit={handleSaveEdit}
                          onToggleActive={handleToggleActive}
                          onToggleContactForm={handleToggleContactForm}
                          onToggleAllowOther={handleToggleAllowOther}
                          onDelete={handleDelete}
                          collapsed={collapsed}
                          toggleCollapse={toggleCollapse}
                          hasChildren={childrenMap.has(questionObj.id)}
                          onIndent={handleIndent}
                          onOutdent={handleOutdent}
                          canIndent={sibIdx > 0}
                          canOutdent={!!questionObj.parent_question_id}
                          options={options[questionObj.id] || []}
                          onOptionsChange={handleOptionsChange}
                          rules={rules.filter(r => r.question_id === questionObj.id)}
                          allQuestions={questions}
                          allOptions={options}
                          allRules={rules}
                          onRulesChange={handleRulesChange}
                          t={t}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </CardContent>
        </Card>
      </div>

      <QuestionnairePreview
        open={showPreview}
        onOpenChange={setShowPreview}
        questions={questions as TreeQuestion[]}
        rules={rules}
        options={options}
      />
    </PortalLayout>
  );
};

export default QuestionnaireManager;
