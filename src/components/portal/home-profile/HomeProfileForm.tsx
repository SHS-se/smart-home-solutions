import React, { useEffect, useState, useMemo } from 'react';
import { Loader2, Save, Pencil, X, Check, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import PhotoUploadZone from './PhotoUploadZone';
import PhotoLightbox from './PhotoLightbox';
import {
  flattenTree,
  evaluateVisibility,
  parseAnswerText,
  type TreeQuestion,
  type DisplayRule,
  type AnswerMap,
  type QuestionType,
} from '@/lib/questionnaire-engine';

interface Question extends TreeQuestion {
  question_text: string;
  question_text_en: string;
  display_on_contact_form: boolean;
}

interface QuestionOption {
  id: string;
  question_id: string;
  value: string;
  label_sv: string;
  label_en: string;
  order_index: number;
}

interface Photo {
  id: string;
  storage_path: string;
  annotation_text: string;
  uploaded_at: string;
  visible_to_customer: boolean;
  signedUrl?: string;
}

interface HomeProfileFormProps {
  customerId: string;
  userId: string;
  isStaffView?: boolean;
}

const HomeProfileForm: React.FC<HomeProfileFormProps> = ({ customerId, userId, isStaffView = false }) => {
  const { toast } = useToast();
  const { t } = useLanguage();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [questionOptions, setQuestionOptions] = useState<Record<string, QuestionOption[]>>({});
  const [displayRules, setDisplayRules] = useState<DisplayRule[]>([]);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [lightboxPhoto, setLightboxPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    if (!customerId) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const photoSelect = 'id, storage_path, annotation_text, uploaded_at, visible_to_customer';
        const photoQuery = isStaffView
          ? supabase.from('home_photos').select(photoSelect).eq('customer_id', customerId).order('uploaded_at', { ascending: false })
          : supabase.from('home_photos').select(photoSelect).eq('customer_id', customerId).eq('visible_to_customer', true).order('uploaded_at', { ascending: false });

        const [qRes, aRes, pRes, oRes, rRes] = await Promise.all([
          supabase.from('home_questions').select('id, question_text, question_text_en, question_type, order_index, parent_question_id, is_active, display_on_contact_form').eq('is_active', true).order('order_index'),
          supabase.from('home_answers').select('question_id, answer_text, answer_value').eq('customer_id', customerId),
          photoQuery,
          supabase.from('home_question_options').select('*').order('order_index'),
          supabase.from('home_question_display_rules').select('*'),
        ]);

        if (qRes.data) setQuestions(qRes.data as Question[]);
        if (aRes.data) {
          const map: AnswerMap = {};
          for (const a of aRes.data) {
            if (a.answer_value !== null && a.answer_value !== undefined) {
              map[a.question_id] = a.answer_value;
            } else if (a.answer_text) {
              // Lazy migration: parse answer_text
              const q = qRes.data?.find((q: any) => q.id === a.question_id);
              if (q) {
                map[a.question_id] = parseAnswerText(a.answer_text, (q as any).question_type);
              } else {
                map[a.question_id] = a.answer_text;
              }
            }
          }
          setAnswers(map);
        }
        if (pRes.data) {
          const withUrls = await Promise.all(
            pRes.data.map(async (p) => {
              const { data } = await supabase.storage.from('home-photos').createSignedUrl(p.storage_path, 3600);
              return { ...p, signedUrl: data?.signedUrl || '' };
            })
          );
          setPhotos(withUrls);
        }
        if (oRes.data) {
          const grouped: Record<string, QuestionOption[]> = {};
          for (const o of oRes.data as QuestionOption[]) {
            if (!grouped[o.question_id]) grouped[o.question_id] = [];
            grouped[o.question_id].push(o);
          }
          setQuestionOptions(grouped);
        }
        if (rRes.data) setDisplayRules(rRes.data as DisplayRule[]);
      } catch (err) {
        console.error('Error fetching home profile:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [customerId, isStaffView]);

  const flattened = useMemo(() => flattenTree(questions), [questions]);

  const setAnswer = (qId: string, value: unknown) => {
    setAnswers(prev => {
      const next = { ...prev, [qId]: value };
      // Clear children answers if this question's answer changes and makes children invisible
      // (handled reactively during render - just set the answer)
      return next;
    });
  };

  const handleSaveAnswers = async () => {
    if (!customerId || !userId) return;
    setSaving(true);
    try {
      // Only save visible questions
      const visibleIds = new Set(
        flattened.filter(q => evaluateVisibility(q.id, displayRules, answers, questions)).map(q => q.id)
      );

      const upserts = questions.map(q => ({
        customer_id: customerId,
        question_id: q.id,
        answer_text: visibleIds.has(q.id) ? stringifyAnswer(answers[q.id]) : '',
        answer_value: visibleIds.has(q.id) ? (answers[q.id] as any) ?? null : null,
        updated_by: userId,
      }));
      const { error } = await supabase.from('home_answers').upsert(upserts, { onConflict: 'customer_id,question_id' });
      if (error) throw error;
      toast({ title: t('Sparat!', 'Saved!') });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleFileProcessed = async (blob: Blob, width: number, height: number, originalFilename: string) => {
    if (!customerId || !userId) return;
    const photoId = crypto.randomUUID();
    const storagePath = `customers/${customerId}/${photoId}.webp`;

    const { error: uploadError } = await supabase.storage.from('home-photos').upload(storagePath, blob, { contentType: 'image/webp' });
    if (uploadError) throw uploadError;

    const { error: insertError } = await supabase.from('home_photos').insert({
      customer_id: customerId,
      storage_path: storagePath,
      uploaded_by: userId,
      width,
      height,
      original_filename: originalFilename,
    });
    if (insertError) throw insertError;

    const { data } = await supabase.storage.from('home-photos').createSignedUrl(storagePath, 3600);
    setPhotos(prev => [{
      id: photoId,
      storage_path: storagePath,
      annotation_text: '',
      uploaded_at: new Date().toISOString(),
      visible_to_customer: true,
      signedUrl: data?.signedUrl || '',
    }, ...prev]);

    toast({ title: t('Uppladdad!', 'Uploaded!') });
  };

  const handleSaveAnnotation = async (photoId: string) => {
    try {
      const { error } = await supabase.from('home_photos').update({ annotation_text: annotationDraft }).eq('id', photoId);
      if (error) throw error;
      setPhotos(prev => prev.map(p => p.id === photoId ? { ...p, annotation_text: annotationDraft } : p));
      setEditingAnnotation(null);
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    }
  };

  const handleDeletePhoto = async (photoId: string, storagePath: string) => {
    if (!confirm(t('Vill du ta bort detta foto?', 'Delete this photo?'))) return;
    try {
      const { error: storageError } = await supabase.storage.from('home-photos').remove([storagePath]);
      if (storageError) throw storageError;
      const { error: dbError } = await supabase.from('home_photos').delete().eq('id', photoId);
      if (dbError) throw dbError;
      setPhotos(prev => prev.filter(p => p.id !== photoId));
      toast({ title: t('Borttagen!', 'Deleted!') });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    }
  };

  const renderQuestionInput = (q: Question) => {
    const type = q.question_type as QuestionType;
    const opts = questionOptions[q.id] || [];

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
        if (opts.length > 0) {
          return (
            <RadioGroup
              value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''}
              onValueChange={v => setAnswer(q.id, v)}
            >
              {opts.sort((a, b) => a.order_index - b.order_index).map(opt => (
                <div key={opt.id} className="flex items-center gap-2">
                  <RadioGroupItem value={opt.value} id={`hp-${q.id}-${opt.value}`} />
                  <Label htmlFor={`hp-${q.id}-${opt.value}`} className="text-sm cursor-pointer">
                    {t(opt.label_sv, opt.label_en || opt.label_sv)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          );
        }
        return (
          <Input
            value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''}
            onChange={e => setAnswer(q.id, e.target.value)}
            placeholder={!isStaffView ? t('Ditt svar...', 'Your answer...') : undefined}
          />
        );

      case 'multi_choice': {
        const current = Array.isArray(answers[q.id]) ? answers[q.id] as string[] : [];
        if (opts.length > 0) {
          return (
            <div className="space-y-2">
              {opts.sort((a, b) => a.order_index - b.order_index).map(opt => (
                <div key={opt.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`hp-${q.id}-${opt.value}`}
                    checked={current.includes(opt.value)}
                    onCheckedChange={checked => {
                      const next = checked
                        ? [...current, opt.value]
                        : current.filter(v => v !== opt.value);
                      setAnswer(q.id, next);
                    }}
                  />
                  <Label htmlFor={`hp-${q.id}-${opt.value}`} className="text-sm cursor-pointer">
                    {t(opt.label_sv, opt.label_en || opt.label_sv)}
                  </Label>
                </div>
              ))}
            </div>
          );
        }
        return (
          <Input
            value={current.join(', ')}
            onChange={e => setAnswer(q.id, e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            placeholder={!isStaffView ? t('Ditt svar...', 'Your answer...') : undefined}
          />
        );
      }

      case 'text':
      default:
        return (
          <Textarea
            value={typeof answers[q.id] === 'string' ? answers[q.id] as string : (answers[q.id] != null ? String(answers[q.id]) : '')}
            onChange={e => setAnswer(q.id, e.target.value)}
            placeholder={!isStaffView ? t('Ditt svar...', 'Your answer...') : undefined}
            rows={1}
            className="min-h-[40px] resize-y"
          />
        );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Answers */}
      <Card>
        <CardHeader>
          <CardTitle>{isStaffView ? t('Bostad & enheter', 'Home & Devices') : t('Din bostad & enheter', 'Your Home & Devices')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {flattened.length === 0 ? (
            <p className="text-muted-foreground">{t('Inga frågor har lagts till ännu.', 'No questions have been added yet.')}</p>
          ) : (
            flattened.map(q => {
              const visible = evaluateVisibility(q.id, displayRules, answers, questions);
              if (!visible) return null;
              const questionObj = q as unknown as Question;

              return (
                <div key={q.id} className="space-y-2" style={{ paddingLeft: `${q.depth * 20}px` }}>
                  <label className="text-sm font-medium">{t(questionObj.question_text, questionObj.question_text_en || questionObj.question_text)}</label>
                  {renderQuestionInput(questionObj)}
                </div>
              );
            })
          )}
          {flattened.length > 0 && (
            <Button onClick={handleSaveAnswers} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {t('Spara svar', 'Save answers')}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Photos */}
      <Card>
        <CardHeader>
          <CardTitle>{t('Installationsfoton', 'Installation Photos')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t(
              'För bäst resultat, ladda upp originalfotot. Vi formaterar om det för bästa visning. För foton som innehåller text, se till att de är tagna på nära håll, är i fokus och väl belysta. Undvik skärmdumpar eller bilder skickade via meddelandeappar, eftersom de försämrar kvaliteten.',
              'For best results, upload the original photo. We will reformat it for best viewing. For photos that contain text, make sure they are taken up close, are in focus and well lit. Avoid screenshots or images sent through messaging apps, as they reduce quality.'
            )}
          </p>
          <PhotoUploadZone onFileProcessed={handleFileProcessed} />

          {photos.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {photos.map(photo => (
                <div key={photo.id} className="rounded-lg border bg-card overflow-hidden">
                  {photo.signedUrl && (
                    <img
                      src={photo.signedUrl}
                      alt={photo.annotation_text || 'Photo'}
                      className="w-full h-48 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => setLightboxPhoto(photo)}
                    />
                  )}
                  <div className="p-3 space-y-2">
                    {editingAnnotation === photo.id ? (
                      <div className="flex gap-2">
                        <Input value={annotationDraft} onChange={e => setAnnotationDraft(e.target.value)} className="text-sm" />
                        <Button size="icon" variant="ghost" onClick={() => handleSaveAnnotation(photo.id)}><Check className="w-4 h-4" /></Button>
                        <Button size="icon" variant="ghost" onClick={() => setEditingAnnotation(null)}><X className="w-4 h-4" /></Button>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm text-muted-foreground">{photo.annotation_text || t('Ingen anteckning', 'No annotation')}</p>
                        <Button size="icon" variant="ghost" className="shrink-0" onClick={() => { setEditingAnnotation(photo.id); setAnnotationDraft(photo.annotation_text || ''); }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">{new Date(photo.uploaded_at).toLocaleDateString()}</p>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDeletePhoto(photo.id, photo.storage_path)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lightbox */}
      {lightboxPhoto && (
        <PhotoLightbox
          src={lightboxPhoto.signedUrl || ''}
          alt={lightboxPhoto.annotation_text || 'Photo'}
          open={!!lightboxPhoto}
          onOpenChange={(open) => { if (!open) setLightboxPhoto(null); }}
        />
      )}
    </div>
  );
};

// Helper: convert answer_value back to a string for legacy answer_text
function stringifyAnswer(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export default HomeProfileForm;
