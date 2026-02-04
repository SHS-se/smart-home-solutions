import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface SubscriptionRequiredAlertProps {
  className?: string;
}

export const SubscriptionRequiredAlert: React.FC<SubscriptionRequiredAlertProps> = ({ className }) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const handleCheckout = async () => {
    setCheckoutLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout');
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (error: any) {
      console.error('Error creating checkout:', error);
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte starta betalning.', 'Could not start payment.'),
        variant: 'destructive',
      });
    } finally {
      setCheckoutLoading(false);
    }
  };

  return (
    <Alert className={className}>
      <CreditCard className="h-4 w-4" />
      <AlertTitle>{t('Prenumeration krävs', 'Subscription required')}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {t(
            'Du behöver en aktiv prenumeration för att skapa eller uppdatera supportärenden.',
            'You need an active subscription to create or update support tickets.'
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleCheckout} disabled={checkoutLoading}>
            {checkoutLoading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <CreditCard className="w-4 h-4 mr-2" />
            )}
            {t('Prenumerera nu', 'Subscribe now')}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/portal/billing">{t('Visa fakturering', 'View billing')}</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
};

export default SubscriptionRequiredAlert;
