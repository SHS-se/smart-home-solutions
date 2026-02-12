import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import LanguageToggle from '@/components/LanguageToggle';

const Verify: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const code = searchParams.get('code');
    if (!code) {
      setStatus('error');
      setErrorMessage(t('Ingen verifieringskod hittades.', 'No verification code found.'));
      return;
    }

    verifyCode(code);
  }, []);

  const verifyCode = async (code: string) => {
    try {
      // Step 1: Resolve the short code to token_hash via edge function
      console.log('[Verify] Step 1: Resolving code...');
      const { data, error } = await supabase.functions.invoke('resolve-verification', {
        body: { code },
      });

      console.log('[Verify] Step 1 result:', { data: data ? { ...data, token_hash: data.token_hash ? '***' : undefined } : null, error: error?.message || error });

      if (error || !data?.token_hash) {
        console.error('[Verify] Step 1 failed. error:', error, 'data:', data);
        setStatus('error');
        setErrorMessage(
          data?.error ||
          t('Länken är ogiltig eller har gått ut.', 'This link is invalid or has expired.')
        );
        return;
      }

      const { token_hash, type, redirect_path } = data;
      console.log('[Verify] Step 2: Calling verifyOtp with type:', type);

      // Step 2: Verify OTP client-side to establish session
      const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
        token_hash,
        type: type as 'recovery' | 'signup' | 'magiclink',
      });

      console.log('[Verify] Step 2 result:', { session: !!otpData?.session, user: !!otpData?.user, error: otpError?.message });

      if (otpError) {
        console.error('[Verify] verifyOtp failed:', otpError.message, otpError);
        setStatus('error');
        setErrorMessage(
          t('Länken är ogiltig eller har gått ut.', 'This link is invalid or has expired.')
        );
        return;
      }

      // Step 3: Redirect to the intended path
      console.log('[Verify] Step 3: Redirecting to', redirect_path || '/portal');
      navigate(redirect_path || '/portal', { replace: true });
    } catch (err: any) {
      console.error('[Verify] Unexpected error:', err);
      setStatus('error');
      setErrorMessage(
        t('Något gick fel. Försök igen.', 'Something went wrong. Please try again.')
      );
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
        <div className="absolute top-4 right-4">
          <LanguageToggle />
        </div>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">
            {t('Verifierar din länk...', 'Verifying your link...')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="absolute top-4 right-4">
        <LanguageToggle />
      </div>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <AlertTriangle className="w-10 h-10 text-destructive" />
          </div>
          <CardTitle className="text-2xl">
            {t('Länken fungerar inte', 'Link not working')}
          </CardTitle>
          <CardDescription>{errorMessage}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground text-center">
            {t(
              'Om du behöver en ny länk, kontakta oss så skickar vi en ny.',
              'If you need a new link, contact us and we\'ll send you a new one.'
            )}
          </p>
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => navigate('/contact')}>
              {t('Kontakta oss', 'Contact us')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Verify;
