import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

const CustomerViewAccount: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '' as string | null,
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
    if (!authLoading && !user) {
      navigate('/login');
    }
    if (!authLoading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, authLoading, navigate]);

  useEffect(() => {
    if (customerData) {
      setFormData({
        name: customerData.contact_name || customerData.name || '',
        email: customerData.contact_email || customerData.billing_email || '',
        phone: customerData.contact_phone || customerData.phone || '',
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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleCheckboxChange = (checked: boolean) => {
    setFormData(prev => ({ ...prev, billing_same_as_site: checked }));
  };

  const handleSave = async () => {
    if (!customerId) return;
    setSaving(true);

    try {
      // Update the customer's address fields
      const customerUpdateData = {
        site_street: formData.site_street || null,
        site_postcode: formData.site_postcode || null,
        site_city: formData.site_city || null,
        billing_same_as_site: formData.billing_same_as_site,
        billing_street: formData.billing_same_as_site ? null : (formData.billing_street || null),
        billing_postcode: formData.billing_same_as_site ? null : (formData.billing_postcode || null),
        billing_city: formData.billing_same_as_site ? null : (formData.billing_city || null),
      };

      const { error: customerError } = await supabase
        .from('customers')
        .update(customerUpdateData)
        .eq('id', customerId);

      if (customerError) throw customerError;

      // Update the contact's identity fields if we have a contact_id
      if (customerData?.contact_id) {
        const contactUpdateData = {
          name: formData.name || null,
          email: formData.email || null,
          phone: formData.phone || null,
        };

        const { error: contactError } = await supabase
          .from('contacts')
          .update(contactUpdateData)
          .eq('id', customerData.contact_id);

        if (contactError) throw contactError;
      }

      toast({
        title: t('Sparat!', 'Saved!'),
        description: t('Kunduppgifterna har uppdaterats.', 'Customer details have been updated.'),
      });
    } catch (err: any) {
      toast({
        title: t('Fel', 'Error'),
        description: err.message || t('Kunde inte spara.', 'Failed to save.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || customerLoading) {
    return (
      <CustomerViewLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </CustomerViewLayout>
    );
  }

  if (error || !customerData) {
    return (
      <CustomerViewLayout>
        <Alert variant="destructive">
          <AlertDescription>
            {error || t('Kunde inte hitta kunden.', 'Customer not found.')}
          </AlertDescription>
        </Alert>
      </CustomerViewLayout>
    );
  }

  return (
    <CustomerViewLayout>
      <div className="space-y-6">
        {/* Back link */}
        <Link 
          to="/portal/customers"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till kunder', 'Back to customers')}
        </Link>

        <h1 className="text-3xl font-medium">{t('Kontouppgifter', 'Account details')}</h1>
        <p className="text-muted-foreground">
          {customerData.name || t('Namnlös kund', 'Unnamed customer')}
        </p>

        <Card>
          <CardHeader>
            <CardTitle>{t('Kundinformation', 'Customer information')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Basic info */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">{t('Kundnamn', 'Customer name')}</Label>
                <Input
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{t('E-post', 'Email')}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleChange}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t('Telefon', 'Phone')}</Label>
                <Input
                  id="phone"
                  name="phone"
                  value={formData.phone}
                  onChange={handleChange}
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
                    name="site_street"
                    value={formData.site_street}
                    onChange={handleChange}
                    placeholder={t('Exempelgatan 123', '123 Example Street')}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="site_postcode">{t('Postnummer', 'Postcode')}</Label>
                    <Input
                      id="site_postcode"
                      name="site_postcode"
                      value={formData.site_postcode}
                      onChange={handleChange}
                      placeholder="123 45"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="site_city">{t('Ort', 'City')}</Label>
                    <Input
                      id="site_city"
                      name="site_city"
                      value={formData.site_city}
                      onChange={handleChange}
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
                      name="billing_street"
                      value={formData.billing_street}
                      onChange={handleChange}
                      placeholder={t('Exempelgatan 123', '123 Example Street')}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="billing_postcode">{t('Postnummer', 'Postcode')}</Label>
                      <Input
                        id="billing_postcode"
                        name="billing_postcode"
                        value={formData.billing_postcode}
                        onChange={handleChange}
                        placeholder="123 45"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="billing_city">{t('Ort', 'City')}</Label>
                      <Input
                        id="billing_city"
                        name="billing_city"
                        value={formData.billing_city}
                        onChange={handleChange}
                        placeholder={t('Stockholm', 'Stockholm')}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t('Spara ändringar', 'Save changes')}
            </Button>
          </CardContent>
        </Card>
      </div>
    </CustomerViewLayout>
  );
};

export default CustomerViewAccount;
