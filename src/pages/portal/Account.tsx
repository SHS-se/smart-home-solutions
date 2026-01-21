import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Save } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const Account: React.FC = () => {
  const { user, customerData, loading, isStaff, refreshUserData } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    org_name: '',
    billing_email: '',
    phone: '',
    address: '',
    site_address: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (customerData) {
      setFormData({
        org_name: customerData.org_name || '',
        billing_email: customerData.billing_email || '',
        phone: customerData.phone || '',
        address: customerData.address || '',
        site_address: customerData.site_address || '',
      });
    }
  }, [customerData]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!customerData) return;

    setSaving(true);
    const { error } = await supabase
      .from('customers')
      .update({
        org_name: formData.org_name || null,
        billing_email: formData.billing_email || null,
        phone: formData.phone || null,
        address: formData.address || null,
        site_address: formData.site_address || null,
      })
      .eq('id', customerData.id);

    setSaving(false);

    if (error) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Kunde inte spara ändringar.', 'Could not save changes.'),
        variant: 'destructive',
      });
    } else {
      toast({
        title: t('Sparat', 'Saved'),
        description: t('Kontouppgifterna har uppdaterats.', 'Account details have been updated.'),
      });
      refreshUserData();
    }
  };

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
    { key: 'org_name', label: t('Företagsnamn', 'Company name'), multiline: false },
    { key: 'billing_email', label: t('Faktureringse-post', 'Billing email'), multiline: false },
    { key: 'phone', label: t('Telefon', 'Phone'), multiline: false },
    { key: 'address', label: t('Adress', 'Address'), multiline: true },
    { key: 'site_address', label: t('Anläggningsadress', 'Site address'), multiline: true },
  ];

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">{t('Kontouppgifter', 'Account details')}</h1>

        <Card className="max-w-2xl">
          <CardContent className="pt-6 space-y-6">
            {fields.map((field) => (
              <div key={field.key}>
                <label className="text-sm font-medium text-primary block mb-2">
                  {field.label}
                </label>
                {field.multiline ? (
                  <Textarea
                    value={formData[field.key as keyof typeof formData]}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    className="resize-none"
                    rows={3}
                  />
                ) : (
                  <Input
                    value={formData[field.key as keyof typeof formData]}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                  />
                )}
              </div>
            ))}

            <div className="pt-4 border-t border-border flex justify-end">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                {t('Spara ändringar', 'Save changes')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default Account;
