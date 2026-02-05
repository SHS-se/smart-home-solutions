import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Save } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
    name: '',
    billing_email: '',
    phone: '',
    site_street: '',
    site_postcode: '',
    site_city: '',
    billing_street: '',
    billing_postcode: '',
    billing_city: '',
    billing_same_as_site: true,
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
        name: customerData.name || '',
        billing_email: customerData.billing_email || '',
        phone: customerData.phone || '',
        site_street: customerData.site_street || '',
        site_postcode: customerData.site_postcode || '',
        site_city: customerData.site_city || '',
        billing_street: customerData.billing_street || '',
        billing_postcode: customerData.billing_postcode || '',
        billing_city: customerData.billing_city || '',
        billing_same_as_site: customerData.billing_same_as_site ?? true,
      });
    }
  }, [customerData]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleCheckboxChange = (checked: boolean) => {
    setFormData((prev) => ({ ...prev, billing_same_as_site: checked }));
  };

  const handleSave = async () => {
    if (!customerData) return;

    setSaving(true);
    
    const updateData = {
      name: formData.name || null,
      billing_email: formData.billing_email || null,
      phone: formData.phone || null,
      site_street: formData.site_street || null,
      site_postcode: formData.site_postcode || null,
      site_city: formData.site_city || null,
      billing_same_as_site: formData.billing_same_as_site,
      // Only save billing address if different from site
      billing_street: formData.billing_same_as_site ? null : (formData.billing_street || null),
      billing_postcode: formData.billing_same_as_site ? null : (formData.billing_postcode || null),
      billing_city: formData.billing_same_as_site ? null : (formData.billing_city || null),
    };

    const { error } = await supabase
      .from('customers')
      .update(updateData)
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

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">{t('Kontouppgifter', 'Account details')}</h1>

        <Card className="max-w-2xl">
          <CardContent className="pt-6 space-y-6">
            {/* Basic info */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">{t('Företagsnamn', 'Company name')}</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing_email">{t('Faktureringse-post', 'Billing email')}</Label>
                <Input
                  id="billing_email"
                  type="email"
                  value={formData.billing_email}
                  onChange={(e) => handleChange('billing_email', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t('Telefon', 'Phone')}</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                />
              </div>
            </div>

            {/* Site/Installation Address */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium">{t('Installationsadress', 'Installation address')}</h3>
              <div className="grid gap-4">
                <div className="space-y-2">
                  <Label htmlFor="site_street">{t('Gatuadress', 'Street address')}</Label>
                  <Input
                    id="site_street"
                    value={formData.site_street}
                    onChange={(e) => handleChange('site_street', e.target.value)}
                    placeholder={t('Exempelgatan 123', '123 Example Street')}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="site_postcode">{t('Postnummer', 'Postcode')}</Label>
                    <Input
                      id="site_postcode"
                      value={formData.site_postcode}
                      onChange={(e) => handleChange('site_postcode', e.target.value)}
                      placeholder="123 45"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="site_city">{t('Ort', 'City')}</Label>
                    <Input
                      id="site_city"
                      value={formData.site_city}
                      onChange={(e) => handleChange('site_city', e.target.value)}
                      placeholder={t('Stockholm', 'Stockholm')}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Billing Address Checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="billing_same_as_site"
                checked={formData.billing_same_as_site}
                onCheckedChange={handleCheckboxChange}
              />
              <Label htmlFor="billing_same_as_site" className="cursor-pointer">
                {t('Faktureringsadress samma som installationsadress', 'Invoice address same as installation address')}
              </Label>
            </div>

            {/* Billing Address (only shown if different from site) */}
            {!formData.billing_same_as_site && (
              <div className="space-y-4 pl-6 border-l-2 border-muted">
                <h3 className="text-lg font-medium">{t('Faktureringsadress', 'Billing address')}</h3>
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="billing_street">{t('Gatuadress', 'Street address')}</Label>
                    <Input
                      id="billing_street"
                      value={formData.billing_street}
                      onChange={(e) => handleChange('billing_street', e.target.value)}
                      placeholder={t('Exempelgatan 123', '123 Example Street')}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="billing_postcode">{t('Postnummer', 'Postcode')}</Label>
                      <Input
                        id="billing_postcode"
                        value={formData.billing_postcode}
                        onChange={(e) => handleChange('billing_postcode', e.target.value)}
                        placeholder="123 45"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="billing_city">{t('Ort', 'City')}</Label>
                      <Input
                        id="billing_city"
                        value={formData.billing_city}
                        onChange={(e) => handleChange('billing_city', e.target.value)}
                        placeholder={t('Stockholm', 'Stockholm')}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

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
