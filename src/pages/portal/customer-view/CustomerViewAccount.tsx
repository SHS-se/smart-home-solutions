import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
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
    org_name: '',
    billing_email: '',
    phone: '',
    address: '',
    site_address: '',
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
        org_name: customerData.org_name || '',
        billing_email: customerData.billing_email || '',
        phone: customerData.phone || '',
        address: customerData.address || '',
        site_address: customerData.site_address || '',
      });
    }
  }, [customerData]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async () => {
    if (!customerId) return;
    setSaving(true);

    try {
      const { error: updateError } = await supabase
        .from('customers')
        .update(formData)
        .eq('id', customerId);

      if (updateError) throw updateError;

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

  const fields = [
    { name: 'org_name', label: t('Kundnamn', 'Customer name'), multiline: false },
    { name: 'billing_email', label: t('Faktura-e-post', 'Billing email'), multiline: false },
    { name: 'phone', label: t('Telefon', 'Phone'), multiline: false },
    { name: 'address', label: t('Faktureringsadress', 'Billing address'), multiline: true },
    { name: 'site_address', label: t('Installationsadress', 'Site address'), multiline: true },
  ];

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
          {customerData.org_name || t('Namnlös kund', 'Unnamed customer')}
        </p>

        <Card>
          <CardHeader>
            <CardTitle>{t('Kundinformation', 'Customer information')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((field) => (
              <div key={field.name} className="space-y-2">
                <Label htmlFor={field.name}>{field.label}</Label>
                {field.multiline ? (
                  <Textarea
                    id={field.name}
                    name={field.name}
                    value={formData[field.name as keyof typeof formData]}
                    onChange={handleChange}
                    rows={3}
                  />
                ) : (
                  <Input
                    id={field.name}
                    name={field.name}
                    value={formData[field.name as keyof typeof formData]}
                    onChange={handleChange}
                  />
                )}
              </div>
            ))}
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
