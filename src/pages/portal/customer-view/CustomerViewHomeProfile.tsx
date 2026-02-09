import React, { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Home, Loader2, Save, Upload, Pencil, Camera, X, Check, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Question {
  id: string;
  question_text: string;
  question_text_en: string;
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

const CustomerViewHomeProfile: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading } = useViewedCustomer();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState('');

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  useEffect(() => {
    if (!customerId) return;
    const fetchData = async () => {
      setLoadingData(true);
      try {
        const [qRes, aRes, pRes] = await Promise.all([
          supabase.from('home_questions').select('id, question_text, question_text_en, sort_order').eq('is_active', true).order('sort_order'),
          supabase.from('home_answers').select('question_id, answer_text').eq('customer_id', customerId),
          supabase.from('home_photos').select('id, storage_path, annotation_text, uploaded_at, visible_to_customer').eq('customer_id', customerId).order('uploaded_at', { ascending: false }),
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
        setLoadingData(false);
      }
    };
    fetchData();
  }, [customerId]);

  const handleSaveAnswers = async () => {
    if (!customerId || !user) return;
    setSaving(true);
    try {
      const upserts = questions.map(q => ({
        customer_id: customerId,
        question_id: q.id,
        answer_text: answers[q.id] || '',
        updated_by: user.id,
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

  const handleUploadPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !customerId || !user) return;
    setUploading(true);
    try {
      const photoId = crypto.randomUUID();
      const ext = file.name.split('.').pop() || 'jpg';
      const storagePath = `customers/${customerId}/${photoId}.${ext}`;
      const { error: uploadError } = await supabase.storage.from('home-photos').upload(storagePath, file);
      if (uploadError) throw uploadError;
      const { error: insertError } = await supabase.from('home_photos').insert({ customer_id: customerId, storage_path: storagePath, uploaded_by: user.id });
      if (insertError) throw insertError;
      const { data } = await supabase.storage.from('home-photos').createSignedUrl(storagePath, 3600);
      setPhotos(prev => [{ id: photoId, storage_path: storagePath, annotation_text: '', uploaded_at: new Date().toISOString(), visible_to_customer: true, signedUrl: data?.signedUrl || '' }, ...prev]);
      toast({ title: t('Uppladdad!', 'Uploaded!') });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
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

  if (authLoading || customerLoading || loadingData) {
    return (
      <CustomerViewLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </CustomerViewLayout>
    );
  }

  return (
    <CustomerViewLayout>
      <div className="space-y-6 max-w-4xl mx-auto">
        <Link to={`/portal/customers/${customerId}/overview`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kundvy', 'Back to customer view')}
        </Link>

        <div className="flex items-center gap-3">
          <Home className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-3xl font-medium">{t('Hemprofil', 'Home Profile')}</h1>
            <p className="text-muted-foreground">{customerData?.name}</p>
          </div>
        </div>

        {/* Answers */}
        <Card>
          <CardHeader>
            <CardTitle>{t('Bostad & enheter', 'Home & Devices')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {questions.length === 0 ? (
              <p className="text-muted-foreground">{t('Inga frågor har lagts till ännu.', 'No questions have been added yet.')}</p>
            ) : (
              questions.map(q => (
                <div key={q.id} className="space-y-2">
                  <label className="text-sm font-medium">{t(q.question_text, q.question_text_en || q.question_text)}</label>
                  <Textarea
                    value={answers[q.id] || ''}
                    onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                    rows={2}
                  />
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
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t('Installationsfoton', 'Installation Photos')}</CardTitle>
            <div>
              <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleUploadPhoto} />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Upload className="w-4 h-4 mr-2" />}
                {t('Ladda upp foto', 'Upload photo')}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {photos.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Camera className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>{t('Inga foton uppladdade ännu.', 'No photos uploaded yet.')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {photos.map(photo => (
                  <div key={photo.id} className="rounded-lg border bg-card overflow-hidden">
                    {photo.signedUrl && (
                      <img src={photo.signedUrl} alt={photo.annotation_text || 'Photo'} className="w-full h-48 object-cover" />
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
                        <div className="flex items-center gap-2">
                          {photo.visible_to_customer ? <Eye className="w-3.5 h-3.5 text-muted-foreground" /> : <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />}
                          <Switch
                            checked={photo.visible_to_customer}
                            onCheckedChange={(v) => handleToggleVisibility(photo.id, v)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewHomeProfile;
