import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, ArrowUp, ArrowDown, Pencil, Check, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Question {
  id: string;
  question_text: string;
  sort_order: number;
  is_active: boolean;
}

const QuestionnaireManager: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useLanguage();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [newQuestion, setNewQuestion] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

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
    if (!newQuestion.trim()) return;
    setAdding(true);
    try {
      const maxSort = questions.length > 0 ? Math.max(...questions.map(q => q.sort_order)) + 1 : 0;
      const { error } = await supabase.from('home_questions').insert({ question_text: newQuestion.trim(), sort_order: maxSort });
      if (error) throw error;
      setNewQuestion('');
      await fetchQuestions();
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (!editDraft.trim()) return;
    try {
      const { error } = await supabase.from('home_questions').update({ question_text: editDraft.trim() }).eq('id', id);
      if (error) throw error;
      setQuestions(prev => prev.map(q => q.id === id ? { ...q, question_text: editDraft.trim() } : q));
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

  const handleReorder = async (index: number, direction: 'up' | 'down') => {
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= questions.length) return;

    const updated = [...questions];
    const tempSort = updated[index].sort_order;
    updated[index].sort_order = updated[swapIndex].sort_order;
    updated[swapIndex].sort_order = tempSort;
    [updated[index], updated[swapIndex]] = [updated[swapIndex], updated[index]];

    setQuestions(updated);

    try {
      await Promise.all([
        supabase.from('home_questions').update({ sort_order: updated[index].sort_order }).eq('id', updated[index].id),
        supabase.from('home_questions').update({ sort_order: updated[swapIndex].sort_order }).eq('id', updated[swapIndex].id),
      ]);
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
            <div className="flex gap-2">
              <Input
                value={newQuestion}
                onChange={e => setNewQuestion(e.target.value)}
                placeholder={t('Ny fråga...', 'New question...')}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
              <Button onClick={handleAdd} disabled={adding || !newQuestion.trim()}>
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </Button>
            </div>

            {/* List */}
            {questions.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('Inga frågor ännu.', 'No questions yet.')}</p>
            ) : (
              <div className="space-y-2">
                {questions.map((q, idx) => (
                  <div key={q.id} className={`flex items-center gap-3 p-3 rounded-lg border ${!q.is_active ? 'opacity-50' : ''}`}>
                    <div className="flex flex-col gap-1">
                      <Button size="icon" variant="ghost" className="h-6 w-6" disabled={idx === 0} onClick={() => handleReorder(idx, 'up')}>
                        <ArrowUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6" disabled={idx === questions.length - 1} onClick={() => handleReorder(idx, 'down')}>
                        <ArrowDown className="w-3.5 h-3.5" />
                      </Button>
                    </div>

                    <div className="flex-1 min-w-0">
                      {editingId === q.id ? (
                        <div className="flex gap-2">
                          <Input value={editDraft} onChange={e => setEditDraft(e.target.value)} className="text-sm" onKeyDown={e => e.key === 'Enter' && handleSaveEdit(q.id)} />
                          <Button size="icon" variant="ghost" onClick={() => handleSaveEdit(q.id)}><Check className="w-4 h-4" /></Button>
                          <Button size="icon" variant="ghost" onClick={() => setEditingId(null)}><X className="w-4 h-4" /></Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-sm truncate">{q.question_text}</span>
                          <Button size="icon" variant="ghost" className="shrink-0 h-7 w-7" onClick={() => { setEditingId(q.id); setEditDraft(q.question_text); }}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>

                    <Switch checked={q.is_active} onCheckedChange={v => handleToggleActive(q.id, v)} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default QuestionnaireManager;
