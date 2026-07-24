import React, { useEffect, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { getStripe } from '@/lib/stripe';

interface CardUpdateCardProps {
  /** Called once the new card is saved + set as default (and any open invoice retried). */
  onUpdated: () => void;
}

const UpdateForm: React.FC<{ onUpdated: () => void }> = ({ onUpdated }) => {
  const { t } = useLanguage();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });
    if (confirmError) {
      setError(confirmError.message || t('Kunde inte spara kortet.', 'Could not save the card.'));
      setSubmitting(false);
      return;
    }
    const pmId =
      typeof setupIntent?.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent?.payment_method?.id;
    if (!pmId) {
      setError(t('Kunde inte spara kortet.', 'Could not save the card.'));
      setSubmitting(false);
      return;
    }
    const { data, error: fnError } = await supabase.functions.invoke('set-default-payment-method', {
      body: JSON.stringify({ payment_method_id: pmId }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (fnError || data?.error) {
      setError(fnError?.message || data?.error || t('Något gick fel.', 'Something went wrong.'));
      setSubmitting(false);
      return;
    }
    onUpdated();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={!stripe || submitting} className="w-full">
        {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
        {t('Spara nytt kort', 'Save new card')}
      </Button>
    </form>
  );
};

const CardUpdateCard: React.FC<CardUpdateCardProps> = ({ onUpdated }) => {
  const { t, language } = useLanguage();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: fnError } = await supabase.functions.invoke('create-setup-intent');
      if (!active) return;
      if (fnError || data?.error || !data?.clientSecret) {
        setError(
          fnError?.message || data?.error || t('Kunde inte ladda kortformuläret.', 'Could not load the card form.'),
        );
      } else {
        setClientSecret(data.clientSecret);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [t]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('Laddar...', 'Loading...')}
      </div>
    );
  }
  if (error || !clientSecret) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Elements stripe={getStripe()} options={{ clientSecret, locale: language, appearance: { theme: 'stripe' } }}>
      <UpdateForm onUpdated={onUpdated} />
    </Elements>
  );
};

export default CardUpdateCard;
