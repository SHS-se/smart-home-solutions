import { useState } from 'react';
import { MapPin, Mail, Phone, Send, CheckCircle, Loader2 } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import ObfuscatedEmail from '@/components/ObfuscatedEmail';

const contactSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
  email: z.string().trim().email("Invalid email address").max(255, "Email must be less than 255 characters"),
  phone: z.string().trim().max(20, "Phone must be less than 20 characters").optional().or(z.literal('')),
  message: z.string().trim().min(10, "Message must be at least 10 characters").max(5000, "Message must be less than 5000 characters")
});

type ContactFormData = z.infer<typeof contactSchema>;

const Contact = () => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [submitted, setSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactFormData, string>>>({});
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    message: ''
  });
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
      const { error } = await supabase.functions.invoke('send-contact-email', {
        body: formData
      });
      
      if (error) throw error;
      
      setSubmitted(true);
    } catch (error: any) {
      console.error('Error sending email:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Det gick inte att skicka meddelandet. Försök igen senare.', 'Failed to send message. Please try again later.'),
        variant: 'destructive'
      });
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
    // Clear error when user starts typing
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
              {submitted ? <div className="text-center py-12">
                  <div className="w-16 h-16 rounded-full bg-energy/30 flex items-center justify-center mx-auto mb-6">
                    <CheckCircle className="w-8 h-8 text-energy-darker" />
                  </div>
                  <h2 className="text-2xl font-medium text-foreground mb-4">
                    {t('Tack för ditt meddelande!', 'Thank you for your message!')}
                  </h2>
                  <p className="text-muted-foreground">
                    {t('Vi återkommer inom 24 timmar med mer information.', "We'll get back to you within 24 hours with more information.")}
                  </p>
                </div> : <>
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
                        <Label htmlFor="phone">{t('Telefon', 'Phone')}</Label>
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
                        address="info"
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