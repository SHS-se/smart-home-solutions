import { useState, useEffect, useMemo } from 'react';
import { MapPin, Mail, Phone, Send, CheckCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import ObfuscatedEmail from '@/components/ObfuscatedEmail';
import {
  flattenTree,
  evaluateVisibility,
  type TreeQuestion,
  type DisplayRule,
  type AnswerMap,
  type QuestionType,
} from '@/lib/questionnaire-engine';

const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
  email: z.string().trim().email("Invalid email address").max(255, "Email must be less than 255 characters"),
  phone: z.string().trim().min(1, "Phone is required").max(20, "Phone must be less than 20 characters"),
  message: z.string().trim().min(10, "Message must be at least 10 characters").max(5000, "Message must be less than 5000 characters"),
  website: z.string().max(0, "").optional()
});

type ContactFormData = z.infer<typeof contactSchema>;

interface HomeQuestion extends TreeQuestion {
  question_text: string;
  question_text_en: string;
}

interface QuestionOption {
  id: string;
  question_id: string;
  value: string;
  label_sv: string;
  label_en: string;
  order_index: number;
}

/* ─── Home Questions Section (collapsible) ─── */
interface HomeQuestionsSectionProps {
  questions: HomeQuestion[];
  options: Record<string, QuestionOption[]>;
  rules: DisplayRule[];
  answers: AnswerMap;
  setAnswers: React.Dispatch<React.SetStateAction<AnswerMap>>;
  showSection: boolean;
  toggleSection: () => void;
  t: (sv: string, en: string) => string;
}

const HomeQuestionsSection = ({
  questions, options, rules, answers, setAnswers, showSection, toggleSection, t
}: HomeQuestionsSectionProps) => {
  const { language } = useLanguage();
  const flat = useMemo(() => flattenTree(questions), [questions]);
  const visibleQuestions = useMemo(
    () => flat.filter(q => evaluateVisibility(q.id, rules, answers, questions)),
    [flat, rules, answers, questions]
  );

  const handleAnswer = (qId: string, value: unknown) => {
    setAnswers(prev => {
      const next = { ...prev, [qId]: value };
      // Clear children that become hidden
      for (const q of flat) {
        if (q.id !== qId && !evaluateVisibility(q.id, rules, next, questions)) {
          delete next[q.id];
        }
      }
      return next;
    });
  };

  return (
    <div className="border border-border rounded-lg">
      <button
        type="button"
        onClick={toggleSection}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <span className="font-medium text-foreground text-sm">
          {t('Berätta mer om ditt hem (valfritt)', 'Tell us more about your home (optional)')}
        </span>
        {showSection ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {showSection && (
        <div className="px-4 pb-4 space-y-4">
          {visibleQuestions.map(q => {
            const label = language === 'en' ? q.question_text_en || q.question_text : q.question_text;
            const qOptions = options[q.id] || [];
            const val = answers[q.id];
            return (
              <div key={q.id} className="space-y-1.5" style={{ marginLeft: (q as any).depth ? (q as any).depth * 16 : 0 }}>
                <Label className="text-sm">{String(label)}</Label>
                {q.question_type === 'text' && (
                  <Input
                    value={(val as string) || ''}
                    onChange={e => handleAnswer(q.id, e.target.value)}
                    placeholder={String(label)}
                  />
                )}
                {q.question_type === 'boolean' && (
                  <div className="flex items-center gap-2">
                    <Switch checked={val === true} onCheckedChange={v => handleAnswer(q.id, v)} />
                    <span className="text-sm text-muted-foreground">{val === true ? t('Ja', 'Yes') : t('Nej', 'No')}</span>
                  </div>
                )}
                {q.question_type === 'number' && (
                  <Input
                    type="number"
                    value={val !== undefined && val !== null ? String(val) : ''}
                    onChange={e => handleAnswer(q.id, e.target.value ? Number(e.target.value) : undefined)}
                  />
                )}
                {q.question_type === 'single_choice' && qOptions.length > 0 && (
                  <RadioGroup value={(val as string) || ''} onValueChange={v => handleAnswer(q.id, v)}>
                    {qOptions.map(o => (
                      <div key={o.id} className="flex items-center gap-2">
                        <RadioGroupItem value={o.value} id={`contact-${q.id}-${o.value}`} />
                        <Label htmlFor={`contact-${q.id}-${o.value}`} className="text-sm font-normal">
                          {language === 'en' ? o.label_en || o.label_sv : o.label_sv}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                )}
                {q.question_type === 'multi_choice' && qOptions.length > 0 && (
                  <div className="space-y-2">
                    {qOptions.map(o => {
                      const selected = Array.isArray(val) ? (val as string[]).includes(o.value) : false;
                      return (
                        <div key={o.id} className="flex items-center gap-2">
                          <Checkbox
                            checked={selected}
                            onCheckedChange={checked => {
                              const prev = Array.isArray(val) ? (val as string[]) : [];
                              handleAnswer(q.id, checked ? [...prev, o.value] : prev.filter(v => v !== o.value));
                            }}
                          />
                          <span className="text-sm">{language === 'en' ? o.label_en || o.label_sv : o.label_sv}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Contact = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactFormData, string>>>({});
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    message: '',
    website: ''
  });

  // Home questions
  const [homeQuestions, setHomeQuestions] = useState<HomeQuestion[]>([]);
  const [homeOptions, setHomeOptions] = useState<Record<string, QuestionOption[]>>({});
  const [homeRules, setHomeRules] = useState<DisplayRule[]>([]);
  const [homeAnswers, setHomeAnswers] = useState<AnswerMap>({});
  const [showHomeSection, setShowHomeSection] = useState(true);

  useEffect(() => {
    const fetchQuestions = async () => {
      const [qRes, oRes, rRes] = await Promise.all([
        supabase
          .from('home_questions')
          .select('id, question_text, question_text_en, question_type, order_index, parent_question_id, is_active, display_on_contact_form')
          .eq('is_active', true)
          .eq('display_on_contact_form', true)
          .order('order_index'),
        supabase.from('home_question_options').select('*').order('order_index'),
        supabase.from('home_question_display_rules').select('*'),
      ]);
      if (qRes.data) setHomeQuestions(qRes.data as HomeQuestion[]);
      if (oRes.data) {
        const grouped: Record<string, QuestionOption[]> = {};
        for (const o of oRes.data as QuestionOption[]) {
          if (!grouped[o.question_id]) grouped[o.question_id] = [];
          grouped[o.question_id].push(o);
        }
        setHomeOptions(grouped);
      }
      if (rRes.data) setHomeRules(rRes.data as DisplayRule[]);
    };
    fetchQuestions();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const result = contactSchema.safeParse(formData);

    if (!result.success) {
      const fieldErrors: Partial<Record<keyof ContactFormData, string>> = {};
      result.error.errors.forEach((err) => {
        if (err.path[0]) {
          fieldErrors[err.path[0] as keyof ContactFormData] = err.message;
        }
      });
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);

    try {
      // Build draft_answers array from answered questions
      const draftAnswers = homeQuestions
        .filter(q => {
          const a = homeAnswers[q.id];
          return a !== undefined && a !== null && a !== '';
        })
        .map(q => ({
          question_id: q.id,
          answer_text: typeof homeAnswers[q.id] === 'string' ? (homeAnswers[q.id] as string).trim() : JSON.stringify(homeAnswers[q.id]),
          answer_value: homeAnswers[q.id],
        }));

      const { data, error } = await supabase.functions.invoke('send-contact-email', {
        body: {
          ...formData,
          draft_answers: draftAnswers.length > 0 ? draftAnswers : undefined,
        }
      });

      if (error) {
        const is429 = error.message?.includes('429') ||
          (error as any)?.status === 429 ||
          error.message?.includes('Too many requests');
        if (is429) {
          toast({
            title: t('För många förfrågningar', 'Too many requests'),
            description: t('Vänta en stund och försök igen.', 'Please wait a moment and try again.'),
            variant: 'destructive'
          });
          setIsLoading(false);
          return;
        }
        console.warn('Contact form edge-function returned error (treated as success):', error.message);
      }

      setOnboarding(data?.onboarding === true);
      setSubmitted(true);
    } catch (error) {
      console.error('Contact form submission error (treated as success):', error);
      setSubmitted(true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    if (errors[name as keyof ContactFormData]) {
      setErrors(prev => ({ ...prev, [name]: undefined }));
    }
  };

  return <Layout>
      {/* Hero */}
      <section className="py-16 md:py-24 hero-gradient">
        <div className="container mx-auto text-center">
          <h1 className="text-foreground mb-4">{t('Kontakta oss', 'Contact Us')}</h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {t('Berätta om ditt projekt så återkommer vi med en kostnadsfri konsultation.', "Tell us about your project and we'll get back to you with a free consultation.")}
          </p>
        </div>
      </section>

      {/* Contact Form & Info */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto">
          <div className="grid lg:grid-cols-2 gap-12">
            {/* Form */}
            <div className="bg-card rounded-2xl p-8 border border-border">
              {submitted ? (
                <div className="text-center py-12">
                  <div className="w-16 h-16 rounded-full bg-energy/30 flex items-center justify-center mx-auto mb-6">
                    <CheckCircle className="w-8 h-8 text-energy-darker" />
                  </div>
                  {onboarding ? (
                    <>
                      <h2 className="text-2xl font-medium text-foreground mb-4">
                        {t('Vill du spara tid?', 'Want to save time?')}
                      </h2>
                      <p className="text-muted-foreground mb-2">
                        {t(
                          'Kolla din e-post för att fylla i din hemprofil och ladda upp bilder. Det hjälper oss hjälpa dig snabbare.',
                          'Check your email to fill in your home profile and upload photos. It helps us help you faster.'
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('Vi återkommer också inom 24 timmar.', "We'll also get back to you within 24 hours.")}
                      </p>
                    </>
                  ) : (
                    <>
                      <h2 className="text-2xl font-medium text-foreground mb-4">
                        {t('Tack för ditt meddelande!', 'Thank you for your message!')}
                      </h2>
                      <p className="text-muted-foreground">
                        {t('Vi återkommer inom 24 timmar med mer information.', "We'll get back to you within 24 hours with more information.")}
                      </p>
                    </>
                  )}
                </div>
              ) : <>
                  <h2 className="text-2xl font-medium text-foreground mb-6">
                    {t('Skicka ett meddelande', 'Send a Message')}
                  </h2>
                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">{t('Namn', 'Name')} *</Label>
                        <Input 
                          id="name" 
                          name="name" 
                          value={formData.name} 
                          onChange={handleChange} 
                          placeholder={t('Ditt namn', 'Your name')}
                          maxLength={100}
                          className={errors.name ? 'border-destructive' : ''}
                        />
                        {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="phone">{t('Telefon', 'Phone')} *</Label>
                        <Input 
                          id="phone" 
                          name="phone" 
                          type="tel" 
                          value={formData.phone} 
                          onChange={handleChange} 
                          placeholder="+46 70 123 45 67"
                          maxLength={20}
                          className={errors.phone ? 'border-destructive' : ''}
                        />
                        {errors.phone && <p className="text-xs text-destructive">{errors.phone}</p>}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email">{t('E-post', 'Email')} *</Label>
                      <Input 
                        id="email" 
                        name="email" 
                        type="email" 
                        value={formData.email} 
                        onChange={handleChange} 
                        placeholder="namn@exempel.se"
                        maxLength={255}
                        className={errors.email ? 'border-destructive' : ''}
                      />
                      {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="message">{t('Meddelande', 'Message')} *</Label>
                      <Textarea 
                        id="message" 
                        name="message" 
                        rows={5} 
                        value={formData.message} 
                        onChange={handleChange} 
                        placeholder={t('Berätta om ditt hem och vad du vill uppnå...', 'Tell us about your home and what you want to achieve...')}
                        maxLength={5000}
                        className={errors.message ? 'border-destructive' : ''}
                      />
                      {errors.message && <p className="text-xs text-destructive">{errors.message}</p>}
                    </div>

                    {/* Optional home questions */}
                    {homeQuestions.length > 0 && (
                      <HomeQuestionsSection
                        questions={homeQuestions}
                        options={homeOptions}
                        rules={homeRules}
                        answers={homeAnswers}
                        setAnswers={setHomeAnswers}
                        showSection={showHomeSection}
                        toggleSection={() => setShowHomeSection(!showHomeSection)}
                        t={t}
                      />
                    )}

                    {/* Honeypot field - hidden from users, catches bots */}
                    <div className="hidden" aria-hidden="true">
                      <Label htmlFor="website">Website</Label>
                      <Input 
                        id="website" 
                        name="website" 
                        type="text"
                        value={formData.website} 
                        onChange={handleChange} 
                        tabIndex={-1}
                        autoComplete="off"
                      />
                    </div>
                    <Button type="submit" size="lg" className="w-full gap-2" disabled={isLoading}>
                      {isLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                      {t('Skicka meddelande', 'Send Message')}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center">
                      {t('Genom att skicka detta formulär godkänner du att vi kontaktar dig.', 'By submitting this form, you agree to us contacting you.')}
                    </p>
                  </form>
                </>}
            </div>

            {/* Contact Info */}
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-medium text-foreground mb-6">
                  {t('Kontaktinformation', 'Contact Information')}
                </h2>
                <div className="space-y-4">
                  <div className="flex items-start gap-4">
                    <div className="icon-container bg-primary-lighter/30 text-primary">
                      <MapPin className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{t('Adress', 'Address')}</p>
                      <p className="text-muted-foreground">{t('Täby, Sverige', 'Täby, Sweden')}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="icon-container bg-primary-lighter/30 text-primary">
                      <Mail className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{t('E-post', 'Email')}</p>
                      <ObfuscatedEmail 
                        address="sales"
                        domain="smarthomesolutions.se" 
                        className="text-primary"
                      />
                    </div>
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="icon-container bg-primary-lighter/30 text-primary">
                      <Phone className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{t('Telefon', 'Phone')}</p>
                      <a href="tel:+46702870814" className="text-primary hover:underline">
                        +46 70 287 08 14
                      </a>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-border space-y-1">
                  <p className="text-sm text-muted-foreground">{t('Godkänd för F-skatt', 'Approved for F-tax')}</p>
                  <p className="text-sm text-muted-foreground">{t('Momsreg.nr', 'VAT reg. no')}: SE790519759101</p>
                </div>
              </div>

              {/* Service Area */}
              <div className="bg-muted rounded-2xl p-6">
                <h3 className="font-medium text-foreground mb-3">
                  {t('Serviceområde', 'Service Area')}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {t('Vi betjänar Täby och omgivande kommuner i norra Storstockholm.', 'We serve Täby and surrounding municipalities in northern Greater Stockholm.')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {['Täby', 'Danderyd', 'Vallentuna', 'Österåker', 'Sollentuna'].map(area => <span key={area} className="px-3 py-1 bg-card rounded-full text-xs">
                      {area}
                    </span>)}
                </div>
              </div>

              {/* Response Time */}
              <div className="bg-energy/20 rounded-2xl p-6">
                <h3 className="font-medium text-foreground mb-2">
                  {t('Snabb respons', 'Quick Response')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t('Vi svarar vanligtvis inom 24 timmar på vardagar. För brådskande ärenden, ring oss direkt.', 'We typically respond within 24 hours on weekdays. For urgent matters, call us directly.')}
                </p>
              </div>

              {/* Free Consultation */}
              <div className="border border-primary/30 rounded-2xl p-6 bg-primary/5">
                <h3 className="font-medium text-foreground mb-2">
                  {t('Gratis konsultation', 'Free Consultation')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t('Vi erbjuder alltid en kostnadsfri första konsultation där vi analyserar ditt hem och diskuterar möjligheter.', 'We always offer a free initial consultation where we analyze your home and discuss possibilities.')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </Layout>;
};
export default Contact;
