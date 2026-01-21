import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Download } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Invoice {
  id: string;
  external_id: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  pdf_url: string | null;
}

const Billing: React.FC = () => {
  const { user, customerData, loading, isStaff } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const fetchInvoices = async () => {
      if (!customerData) return;
      setInvoicesLoading(true);

      try {
        const { data, error } = await supabase
          .from('invoices')
          .select('*')
          .eq('customer_id', customerData.id)
          .order('date', { ascending: false });

        if (error) throw error;
        setInvoices(data || []);
      } catch (error) {
        console.error('Error fetching invoices:', error);
      } finally {
        setInvoicesLoading(false);
      }
    };

    if (!loading && customerData) {
      fetchInvoices();
    }
  }, [customerData, loading]);

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
              'Personalkonton har ingen faktureringsinformation. Använd kundsidan för att se kundfakturor.',
              "Staff accounts don't have billing information. Use the Customers page to view customer invoices."
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

  const formatAmount = (amount: number | null, currency: string | null) => {
    if (amount === null) return 'N/A';
    const formatted = new Intl.NumberFormat('sv-SE').format(amount);
    return `${formatted} ${currency || 'kr'}`;
  };

  const getStatusBadge = (status: string | null) => {
    if (!status) return null;
    const lowerStatus = status.toLowerCase();
    
    const statusLabels: Record<string, string> = {
      paid: t('Betald', 'Paid'),
      pending: t('Väntande', 'Pending'),
      sent: t('Skickad', 'Sent'),
      overdue: t('Förfallen', 'Overdue'),
    };
    
    const label = statusLabels[lowerStatus] || status;
    
    if (lowerStatus === 'paid') {
      return <Badge className="bg-energy/30 text-energy-darker border-0">{label}</Badge>;
    }
    if (lowerStatus === 'pending' || lowerStatus === 'sent') {
      return <Badge variant="outline">{label}</Badge>;
    }
    if (lowerStatus === 'overdue') {
      return <Badge variant="destructive">{label}</Badge>;
    }
    return <Badge variant="secondary">{label}</Badge>;
  };

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-medium">{t('Fakturering', 'Billing & invoices')}</h1>

        <Card>
          <CardContent className="pt-6">
            {invoicesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : invoices.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                {t('Inga fakturor hittades.', 'No invoices found.')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-primary">{t('Datum', 'Date')}</TableHead>
                    <TableHead className="text-primary">{t('Fakturanummer', 'Invoice number')}</TableHead>
                    <TableHead className="text-primary">{t('Belopp', 'Amount')}</TableHead>
                    <TableHead className="text-primary">{t('Status', 'Status')}</TableHead>
                    <TableHead className="text-primary">{t('Ladda ner', 'Download')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>{invoice.date || 'N/A'}</TableCell>
                      <TableCell>{invoice.external_id || invoice.id.slice(0, 8)}</TableCell>
                      <TableCell>{formatAmount(invoice.amount, invoice.currency)}</TableCell>
                      <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                      <TableCell>
                        {invoice.pdf_url ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            asChild
                          >
                            <a href={invoice.pdf_url} target="_blank" rel="noopener noreferrer">
                              <Download className="w-4 h-4" />
                            </a>
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default Billing;
