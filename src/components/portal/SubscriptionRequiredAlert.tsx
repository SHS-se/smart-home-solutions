import React from 'react';
import { Link } from 'react-router-dom';
import { CreditCard } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';

interface SubscriptionRequiredAlertProps {
  className?: string;
}

export const SubscriptionRequiredAlert: React.FC<SubscriptionRequiredAlertProps> = ({ className }) => {
  const { t } = useLanguage();

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
          <Button size="sm" asChild>
            <Link to="/portal/billing">
              <CreditCard className="w-4 h-4 mr-2" />
              {t('Visa fakturering', 'View billing')}
            </Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
};

export default SubscriptionRequiredAlert;
