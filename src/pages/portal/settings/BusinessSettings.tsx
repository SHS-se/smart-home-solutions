import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  useBusinessSettings,
  BUSINESS_SETTINGS_QUERY_KEY,
  type BusinessSettings as BusinessSettingsRow,
} from '@/hooks/use-business-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Building2, Save, Info, CreditCard } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

/** Columns the form edits — everything on the row except the id/updated_at. */
type EditableField = Exclude<keyof BusinessSettingsRow, 'id' | 'updated_at'>;

const BusinessSettings: React.FC = () => {
  const { t } = useLanguage();
  const { isAdmin, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { settings, isLoading } = useBusinessSettings();
  const [form, setForm] = React.useState<BusinessSettingsRow>(settings);
  const [hasChanges, setHasChanges] = React.useState(false);

  // Sync local form with the fetched row once it loads / changes externally.
  React.useEffect(() => {
    setForm(settings);
    setHasChanges(false);
  }, [settings]);

  const setField = (field: EditableField, value: string | number | boolean | null) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('business_settings')
        .update({
          legal_name: form.legal_name,
          org_number: form.org_number,
          vat_number: form.vat_number,
          f_skatt_approved: form.f_skatt_approved,
          address_street: form.address_street,
          address_postcode: form.address_postcode,
          address_city: form.address_city,
          address_country: form.address_country,
          contact_email: form.contact_email,
          support_email: form.support_email,
          contact_phone: form.contact_phone,
          website: form.website,
          bankgiro_number: form.bankgiro_number,
          payee_name: form.payee_name,
          iban: form.iban,
          bic: form.bic,
          bank_name: form.bank_name,
          payment_terms_days: form.payment_terms_days,
        })
        .eq('id', 1);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BUSINESS_SETTINGS_QUERY_KEY });
      setHasChanges(false);
      toast({ title: t('Ändringar sparade', 'Changes saved') });
    },
    onError: (error) => {
      toast({
        title: t('Kunde inte spara', 'Failed to save'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    },
  });

  // Settings touch invoices and the public site — keep them admin-only.
  if (!authLoading && !isAdmin) {
    navigate('/portal');
    return null;
  }

  const text = (field: EditableField, label: string, placeholder?: string, type = 'text') => (
    <div className="space-y-1.5">
      <Label htmlFor={field}>{label}</Label>
      <Input
        id={field}
        type={type}
        value={(form[field] as string | number | null) ?? ''}
        placeholder={placeholder}
        onChange={(e) =>
          setField(
            field,
            type === 'number'
              ? e.target.value === ''
                ? 0
                : Number(e.target.value)
              : e.target.value === ''
                ? null
                : e.target.value,
          )
        }
      />
    </div>
  );

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-24">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">{t('Företagsuppgifter', 'Business settings')}</h1>
          <p className="text-muted-foreground">
            {t(
              'Uppgifter som visas på fakturor, i fakturamejl och på den publika webbplatsen.',
              'Details shown on invoices, invoice emails and the public website.',
            )}
          </p>
        </div>
      </div>

      <Alert className="border-primary/20 bg-primary/5">
        <Info className="h-4 w-4" />
        <AlertTitle>{t('Hur uppgifterna används', 'How these are used')}</AlertTitle>
        <AlertDescription>
          {t(
            'Betalningsuppgifterna (bl.a. bankgiro) skrivs ut på fakturor och i fakturans QR-kod. Företags- och kontaktuppgifter visas i fakturahuvudet samt på kontaktsidan och i sidfoten.',
            'Payment details (e.g. bankgiro) are printed on invoices and in the invoice QR code. Company and contact details appear in the invoice header and on the public contact page and footer.',
          )}
        </AlertDescription>
      </Alert>

      {isLoading ? (
        <p className="text-center py-12 text-muted-foreground">{t('Laddar...', 'Loading...')}</p>
      ) : (
        <>
          {/* Payment */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">{t('Betalningsuppgifter', 'Payment details')}</CardTitle>
              </div>
              <CardDescription>
                {t(
                  'Visas i avsnittet Betalningsinformation på varje faktura.',
                  'Shown in the payment information section of every invoice.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {text('bankgiro_number', t('Bankgiro', 'Bankgiro'), '123-4567')}
              {text('payee_name', t('Mottagare', 'Payee'), 'Smart Home Solutions')}
              {text('bank_name', t('Bank', 'Bank'), 'Swedbank')}
              {text('payment_terms_days', t('Betalningsvillkor (dagar)', 'Payment terms (days)'), '30', 'number')}
              {text('iban', 'IBAN', 'SE00 0000 0000 0000 0000 0000')}
              {text('bic', 'BIC/SWIFT', 'SWEDSESS')}
            </CardContent>
          </Card>

          {/* Company / legal */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('Företagsinformation', 'Company information')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {text('legal_name', t('Företagsnamn', 'Company name'))}
              {text('org_number', t('Organisationsnummer', 'Org. number'), '790519-7591')}
              {text('vat_number', t('Momsregistreringsnummer', 'VAT number'), 'SE790519759101')}
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 sm:col-span-2">
                <div>
                  <Label htmlFor="f_skatt_approved">{t('Godkänd för F-skatt', 'Approved for F-tax')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('Visas på fakturor och kontaktsidan.', 'Shown on invoices and the contact page.')}
                  </p>
                </div>
                <Switch
                  id="f_skatt_approved"
                  checked={form.f_skatt_approved}
                  onCheckedChange={(checked) => setField('f_skatt_approved', checked)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Address */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('Adress', 'Address')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {text('address_street', t('Gatuadress', 'Street'), 'Porfyrvägen 10')}
              {text('address_postcode', t('Postnummer', 'Postcode'), '187 34')}
              {text('address_city', t('Ort', 'City'), 'Täby')}
              {text('address_country', t('Land', 'Country'), 'Sverige')}
            </CardContent>
          </Card>

          {/* Contact */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('Kontaktuppgifter', 'Contact details')}</CardTitle>
              <CardDescription>
                {t(
                  'E-post och telefon som visas publikt och i fakturakommunikation.',
                  'Email and phone shown publicly and in invoice communication.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {text('contact_email', t('E-post (allmän)', 'Email (general)'), 'sales@smarthomesolutions.se', 'email')}
              {text('support_email', t('E-post (support)', 'Email (support)'), 'support@smarthomesolutions.se', 'email')}
              {text('contact_phone', t('Telefon', 'Phone'), '+46 70 287 08 14', 'tel')}
              {text('website', t('Webbplats', 'Website'), 'https://smarthomesolutions.se', 'url')}
            </CardContent>
          </Card>
        </>
      )}

      {/* Sticky save bar */}
      <div className="fixed bottom-0 inset-x-0 border-t border-border bg-background/95 backdrop-blur px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {hasChanges
              ? t('Du har osparade ändringar.', 'You have unsaved changes.')
              : t('Allt är sparat.', 'Everything is saved.')}
          </p>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!hasChanges || saveMutation.isPending}
          >
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? t('Sparar...', 'Saving...') : t('Spara ändringar', 'Save changes')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default BusinessSettings;
