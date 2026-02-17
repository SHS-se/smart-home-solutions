import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Save, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import PortalLayout from '@/components/portal/PortalLayout';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface AccountProps {
  customerId?: string;
  isStaffView?: boolean;
  customerData?: any;
}

const Account: React.FC<AccountProps> = ({ customerId: propCustomerId, isStaffView = false, customerData: propCustomerData }) => {
  const { user, customerData: authCustomerData, loading, isStaff, refreshUserData } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();

  const resolvedCustomerData = propCustomerData || authCustomerData;
  const resolvedCustomerId = propCustomerId || resolvedCustomerData?.id;

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
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (resolvedCustomerData) {
      if (isStaffView) {
        // Staff view: use contact fields for name/email/phone
        setFormData({
          name: resolvedCustomerData.contact_name || resolvedCustomerData.name || '',
          email: resolvedCustomerData.contact_email || resolvedCustomerData.billing_email || '',
          phone: resolvedCustomerData.contact_phone || resolvedCustomerData.phone || '',
          site_street: resolvedCustomerData.site_street || '',
          site_postcode: resolvedCustomerData.site_postcode || '',
          site_city: resolvedCustomerData.site_city || '',
          billing_street: resolvedCustomerData.billing_street || '',
          billing_postcode: resolvedCustomerData.billing_postcode || '',
          billing_city: resolvedCustomerData.billing_city || '',
          billing_same_as_site: resolvedCustomerData.billing_same_as_site ?? true,
        });
      } else {
        // Customer view: use billing_email
        setFormData({
          name: resolvedCustomerData.name || '',
          email: resolvedCustomerData.billing_email || '',
          phone: resolvedCustomerData.phone || '',
          site_street: resolvedCustomerData.site_street || '',
          site_postcode: resolvedCustomerData.site_postcode || '',
          site_city: resolvedCustomerData.site_city || '',
          billing_street: resolvedCustomerData.billing_street || '',
          billing_postcode: resolvedCustomerData.billing_postcode || '',
          billing_city: resolvedCustomerData.billing_city || '',
          billing_same_as_site: resolvedCustomerData.billing_same_as_site ?? true,
        });
      }
    }
  }, [resolvedCustomerData, isStaffView]);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleCheckboxChange = (checked: boolean) => {
    setFormData((prev) => ({ ...prev, billing_same_as_site: checked }));
  };

  const handleSave = async () => {
    if (!resolvedCustomerId) return;

    setSaving(true);

    try {
      // Update the customer's address fields
      const customerUpdateData: any = {
        site_street: formData.site_street || null,
        site_postcode: formData.site_postcode || null,
        site_city: formData.site_city || null,
        billing_same_as_site: formData.billing_same_as_site,
        billing_street: formData.billing_same_as_site ? null : (formData.billing_street || null),
        billing_postcode: formData.billing_same_as_site ? null : (formData.billing_postcode || null),
        billing_city: formData.billing_same_as_site ? null : (formData.billing_city || null),
      };

      // For customer self-view, also update name/billing_email/phone directly on customers
      if (!isStaffView) {
        customerUpdateData.name = formData.name || null;
        customerUpdateData.billing_email = formData.email || null;
        customerUpdateData.phone = formData.phone || null;
      }

      const { error: customerError } = await supabase
        .from('customers')
        .update(customerUpdateData)
        .eq('id', resolvedCustomerId);

      if (customerError) throw customerError;

      // For staff view, update the contact's identity fields if we have a contact_id
      if (isStaffView && resolvedCustomerData?.contact_id) {
        const contactUpdateData = {
          name: formData.name || null,
          email: formData.email || null,
          phone: formData.phone || null,
        };

        const { error: contactError } = await supabase
          .from('contacts')
          .update(contactUpdateData)
          .eq('id', resolvedCustomerData.contact_id);

        if (contactError) throw contactError;
      }

      toast({
        title: t('Sparat!', 'Saved!'),
        description: t('Kontouppgifterna har uppdaterats.', 'Account details have been updated.'),
      });

      if (!isStaffView) {
        refreshUserData();
      }
    } catch (err: any) {
      toast({
        title: t('Fel', 'Error'),
        description: err.message || t('Kunde inte spara ändringar.', 'Could not save changes.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const Layout = isStaffView ? CustomerViewLayout : PortalLayout;

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!isStaffView && isStaff) {
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

  if (!resolvedCustomerData) {
    return (
      <Layout>
        <Alert>
          <AlertDescription>
            {t('Ingen kunddata hittades. Kontakta support.', 'No customer data found. Please contact support.')}
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  const emailLabel = isStaffView ? t('E-post', 'Email') : t('Faktureringse-post', 'Billing email');

  return (
    <Layout>
      <div className="space-y-6">
        {isStaffView && (
          <Link
            to="/portal/customers"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('Tillbaka till kunder', 'Back to customers')}
          </Link>
        )}

        <h1 className="text-3xl font-medium">{t('Kontouppgifter', 'Account details')}</h1>
        {isStaffView && (
          <p className="text-muted-foreground">
            {resolvedCustomerData.name || t('Namnlös kund', 'Unnamed customer')}
          </p>
        )}

        <Card className={isStaffView ? undefined : 'max-w-2xl'}>
          {isStaffView && (
            <CardHeader>
              <CardTitle>{t('Kundinformation', 'Customer information')}</CardTitle>
            </CardHeader>
          )}
          <CardContent className={isStaffView ? 'space-y-6' : 'pt-6 space-y-6'}>
            {/* Basic info */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">{t('Kundnamn', 'Customer name')}</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{emailLabel}</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t('Telefon', 'Phone')}</Label>
                <Input
                  id="phone"
                  value={formData.phone || ''}
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
    </Layout>
  );
};

export default Account;
