import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, Loader2, MailX } from 'lucide-react';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

type Status = 'loading' | 'subscribed' | 'unsubscribed' | 'invalid' | 'error';

const Unsubscribe = () => {
  const { t } = useLanguage();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [status, setStatus] = useState<Status>('loading');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.functions.invoke('unsubscribe', {
        body: { token, action: 'status' },
      });
      if (cancelled) return;
      if (error || !data?.success) {
        setStatus('invalid');
      } else {
        setStatus(data.marketing_opt_out ? 'unsubscribed' : 'subscribed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const setPreference = async (action: 'unsubscribe' | 'resubscribe') => {
    setSaving(true);
    const { data, error } = await supabase.functions.invoke('unsubscribe', {
      body: { token, action },
    });
    setSaving(false);
    if (error || !data?.success) {
      setStatus('error');
    } else {
      setStatus(data.marketing_opt_out ? 'unsubscribed' : 'subscribed');
    }
  };

  return (
    <Layout>
      <div className="max-w-lg mx-auto px-4 py-16 sm:py-24">
        <div className="text-center space-y-6">
          {status === 'loading' && (
            <div className="flex justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          )}

          {status === 'invalid' && (
            <Alert>
              <AlertDescription>
                {t(
                  'Länken är ogiltig eller har slutat gälla. Kontakta oss på support@smarthomesolutions.se om du vill ändra dina utskicksinställningar.',
                  'This link is invalid or has expired. Contact us at support@smarthomesolutions.se if you want to change your email preferences.'
                )}
              </AlertDescription>
            </Alert>
          )}

          {status === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>
                {t('Något gick fel. Försök igen.', 'Something went wrong. Please try again.')}
              </AlertDescription>
            </Alert>
          )}

          {status === 'subscribed' && (
            <>
              <MailX className="w-12 h-12 mx-auto text-muted-foreground" />
              <h1 className="text-2xl font-medium">
                {t('Avsluta marknadsutskick', 'Unsubscribe from marketing emails')}
              </h1>
              <p className="text-muted-foreground">
                {t(
                  'Vill du sluta få nyheter och erbjudanden från Smart Home Solutions via e-post? Offerter, fakturor och viktig kontoinformation skickas alltid.',
                  'Do you want to stop receiving news and offers from Smart Home Solutions by email? Quotes, invoices and important account information are always sent.'
                )}
              </p>
              <Button onClick={() => setPreference('unsubscribe')} disabled={saving}>
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('Avsluta marknadsutskick', 'Unsubscribe')}
              </Button>
            </>
          )}

          {status === 'unsubscribed' && (
            <>
              <CheckCircle className="w-12 h-12 mx-auto text-primary" />
              <h1 className="text-2xl font-medium">
                {t('Du är avregistrerad', 'You are unsubscribed')}
              </h1>
              <p className="text-muted-foreground">
                {t(
                  'Du får inte längre nyheter och erbjudanden från oss via e-post. Offerter, fakturor och viktig kontoinformation skickas fortfarande.',
                  'You will no longer receive news and offers from us by email. Quotes, invoices and important account information are still sent.'
                )}
              </p>
              <Button variant="outline" onClick={() => setPreference('resubscribe')} disabled={saving}>
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t('Ångra – prenumerera igen', 'Undo – subscribe again')}
              </Button>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default Unsubscribe;
