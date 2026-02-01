import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, Download, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import CustomerViewLayout from '@/components/portal/CustomerViewLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  pdf_url: string | null;
}

const CustomerViewBilling: React.FC = () => {
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
    if (!authLoading && !isStaff) {
      navigate('/portal');
    }
  }, [user, isStaff, authLoading, navigate]);

  useEffect(() => {
    const fetchInvoices = async () => {
      if (!customerId) return;
      setInvoicesLoading(true);

      try {
        const { data, error: fetchError } = await supabase
          .from('invoices')
          .select('*')
          .eq('customer_id', customerId)
          .order('date', { ascending: false });

        if (fetchError) throw fetchError;
        setInvoices(data || []);
      } catch (err) {
        console.error('Error fetching invoices:', err);
      } finally {
        setInvoicesLoading(false);
      }
    };

    if (!customerLoading && customerId) {
      fetchInvoices();
    }
  }, [customerId, customerLoading]);

  const formatAmount = (amount: number | null, currency: string | null) => {
    if (amount === null) return '-';
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: currency || 'SEK',
    }).format(amount);
  };

  const getStatusBadge = (status: string | null) => {
    switch (status?.toLowerCase()) {
      case 'paid':
        return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t('Betald', 'Paid')}</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100">{t('Väntar', 'Pending')}</Badge>;
      case 'overdue':
        return <Badge className="bg-red-100 text-red-800 hover:bg-red-100">{t('Förfallen', 'Overdue')}</Badge>;
      default:
        return <Badge variant="secondary">{status || '-'}</Badge>;
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

        <h1 className="text-3xl font-medium">{t('Fakturor', 'Invoices')}</h1>
        <p className="text-muted-foreground">
          {customerData.org_name || t('Namnlös kund', 'Unnamed customer')}
        </p>

        <Card>
          <CardContent className="pt-6">
            {invoicesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : invoices.length === 0 ? (
              <div className="text-center py-12">
                <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">{t('Inga fakturor hittades.', 'No invoices found.')}</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-primary">{t('Datum', 'Date')}</TableHead>
                    <TableHead className="text-primary">{t('Fakturanummer', 'Invoice number')}</TableHead>
                    <TableHead className="text-primary">{t('Belopp', 'Amount')}</TableHead>
                    <TableHead className="text-primary">{t('Status', 'Status')}</TableHead>
                    <TableHead className="text-primary"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        {invoice.date ? new Date(invoice.date).toLocaleDateString() : '-'}
                      </TableCell>
                      <TableCell className="font-medium">{invoice.invoice_number || '-'}</TableCell>
                      <TableCell>{formatAmount(invoice.amount, invoice.currency)}</TableCell>
                      <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                      <TableCell>
                        {invoice.pdf_url && (
                          <Button variant="ghost" size="sm" asChild>
                            <a href={invoice.pdf_url} target="_blank" rel="noopener noreferrer">
                              <Download className="w-4 h-4 mr-2" />
                              {t('Ladda ner', 'Download')}
                            </a>
                          </Button>
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
    </CustomerViewLayout>
  );
};

export default CustomerViewBilling;
