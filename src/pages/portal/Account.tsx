import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';

const Account: React.FC = () => {
  const { user, customerData, loading, isStaff } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();

  React.useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (isStaff) {
    return (
      <PortalLayout>
        <Alert>
          <AlertDescription>
            {t(
              'Personalkonton har inga kunduppgifter. Använd kundsidan för att se kundinformation.',
              "Staff accounts don't have customer details. Use the Customers page to view customer information."
            )}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  if (!customerData) {
    return (
      <PortalLayout>
        <Alert>
          <AlertDescription>
            {t('Ingen kunddata hittades. Kontakta support.', 'No customer data found. Please contact support.')}
          </AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  const fields = [
    { label: t('Företagsnamn', 'Company name'), value: customerData.org_name },
    { label: t('Faktureringse-post', 'Billing email'), value: customerData.billing_email },
    { label: t('Telefon', 'Phone'), value: customerData.phone },
    { label: t('Adress', 'Address'), value: customerData.address },
    { label: t('Anläggningsadress', 'Site address'), value: customerData.site_address },
  ];

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">{t('Kontouppgifter', 'Account details')}</h1>

        <Card className="max-w-2xl">
          <CardContent className="pt-6 space-y-6">
            {fields.map((field) => (
              <div key={field.label}>
                <label className="text-sm font-medium text-primary block mb-2">
                  {field.label}
                </label>
                <div className="p-3 bg-muted rounded-lg text-foreground whitespace-pre-line">
                  {field.value || t('Ej angivet', 'Not specified')}
                </div>
              </div>
            ))}

            <div className="pt-4 border-t border-border">
              <p className="text-sm text-muted-foreground">
                {t('Kontakta oss för att uppdatera kontouppgifter.', 'Contact us to update account details.')}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default Account;
