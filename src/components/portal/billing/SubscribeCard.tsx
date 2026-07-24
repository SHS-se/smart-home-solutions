import React, { useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { getStripe } from '@/lib/stripe';

interface SubscribeCardProps {
  /** Called once payment is confirmed; the parent re-checks subscription status. */
  onSubscribed: () => void;
}

// Inner form: rendered inside <Elements> so the Payment Element has a client secret.
const PaymentForm: React.FC<{ onSubscribed: () => void }> = ({ onSubscribed }) => {
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
    // redirect: 'if_required' keeps card + 3DS on our page (no Stripe-hosted redirect).
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });
    if (confirmError) {
      setError(confirmError.message || t('Betalningen misslyckades.', 'Payment failed.'));
      setSubmitting(false);
      return;
    }
    // Payment succeeded; entitlement is activated by the webhook — parent polls for it.
    onSubscribed();
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
        {t('Betala och starta prenumeration', 'Pay and start subscription')}
      </Button>
    </form>
  );
};

const SubscribeCard: React.FC<SubscribeCardProps> = ({ onSubscribed }) => {
  const { t, language } = useLanguage();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startSubscription = async () => {
    setStarting(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('create-subscription');
      if (fnError) throw new Error(fnError.message);
      if (data?.error) throw new Error(data.error);
      if (data?.alreadySubscribed) {
        onSubscribed();
        return;
      }
      if (!data?.clientSecret) throw new Error(t('Kunde inte starta prenumerationen.', 'Could not start the subscription.'));
      setClientSecret(data.clientSecret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  if (!clientSecret) {
    return (
      <div className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button onClick={startSubscription} disabled={starting}>
          {starting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {t('Starta prenumeration', 'Start subscription')}
        </Button>
      </div>
    );
  }

  return (
    <Elements
      stripe={getStripe()}
      options={{ clientSecret, locale: language, appearance: { theme: 'stripe' } }}
    >
      <PaymentForm onSubscribed={onSubscribed} />
    </Elements>
  );
};

export default SubscribeCard;
