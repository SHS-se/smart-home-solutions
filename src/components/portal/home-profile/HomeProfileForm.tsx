import React, { useEffect, useState, useRef } from 'react';
import { Loader2, Save, Pencil, X, Check, Eye, EyeOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import PhotoUploadZone from './PhotoUploadZone';
import PhotoLightbox from './PhotoLightbox';

interface Question {
  id: string;
  question_text: string;
  question_text_en: string;
  question_type: string;
  sort_order: number;
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
  /** Staff mode shows visibility toggles on photos */
  isStaffView?: boolean;
}

const HomeProfileForm: React.FC<HomeProfileFormProps> = ({ customerId, userId, isStaffView = false }) => {
  const { toast } = useToast();
  const { t } = useLanguage();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
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

        const [qRes, aRes, pRes] = await Promise.all([
          supabase.from('home_questions').select('id, question_text, question_text_en, question_type, sort_order').eq('is_active', true).order('sort_order'),
          supabase.from('home_answers').select('question_id, answer_text').eq('customer_id', customerId),
          photoQuery,
        ]);

        if (qRes.data) setQuestions(qRes.data);
        if (aRes.data) {
          const map: Record<string, string> = {};
          aRes.data.forEach(a => { map[a.question_id] = a.answer_text; });
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
      } catch (err) {
        console.error('Error fetching home profile:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [customerId, isStaffView]);

  const handleSaveAnswers = async () => {
    if (!customerId || !userId) return;
    setSaving(true);
    try {
      const upserts = questions.map(q => ({
        customer_id: customerId,
        question_id: q.id,
        answer_text: answers[q.id] || '',
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

    const { error: uploadError } = await supabase.storage.from('home-photos').upload(storagePath, blob, {
      contentType: 'image/webp',
    });
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

  const handleToggleVisibility = async (photoId: string, visible: boolean) => {
    try {
      const { error } = await supabase.from('home_photos').update({ visible_to_customer: visible }).eq('id', photoId);
      if (error) throw error;
      setPhotos(prev => prev.map(p => p.id === photoId ? { ...p, visible_to_customer: visible } : p));
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
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
          {questions.length === 0 ? (
            <p className="text-muted-foreground">{t('Inga frågor har lagts till ännu.', 'No questions have been added yet.')}</p>
          ) : (
            questions.map(q => (
              <div key={q.id} className="space-y-2">
                <label className="text-sm font-medium">{t(q.question_text, q.question_text_en || q.question_text)}</label>
                {q.question_type === 'boolean' ? (
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={answers[q.id] === 'true'}
                      onCheckedChange={(v) => setAnswers(prev => ({ ...prev, [q.id]: v ? 'true' : 'false' }))}
                    />
                    <span className="text-sm text-muted-foreground">
                      {answers[q.id] === 'true' ? t('Ja', 'Yes') : t('Nej', 'No')}
                    </span>
                  </div>
                ) : (
                  <Textarea
                    value={answers[q.id] || ''}
                    onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={!isStaffView ? t('Ditt svar...', 'Your answer...') : undefined}
                    rows={1}
                    className="min-h-[40px] resize-y"
                  />
                )}
              </div>
            ))
          )}
          {questions.length > 0 && (
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
                      {isStaffView && (
                        <div className="flex items-center gap-2">
                          {photo.visible_to_customer ? <Eye className="w-3.5 h-3.5 text-muted-foreground" /> : <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />}
                          <Switch
                            checked={photo.visible_to_customer}
                            onCheckedChange={(v) => handleToggleVisibility(photo.id, v)}
                          />
                        </div>
                      )}
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

export default HomeProfileForm;
