import React, { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle, CheckCircle2, Download, Eye } from 'lucide-react';
import InvoicePdfModal from '@/components/portal/invoices/InvoicePdfModal';

interface InvoiceLineItem {
  id: string;
  line_type: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  sku: string | null;
  category: string | null;
}

interface InvoicePayment {
  id: string;
  payment_date: string;
  amount: number;
  method: string | null;
  reference: string | null;
  note: string | null;
}

interface PublicInvoiceData {
  id: string;
  invoice_number: string | null;
  status: string;
  due_date: string | null;
  currency: string | null;
  subtotal: number;
  tax: number;
  total: number;
  created_at: string;
  finalized_at: string | null;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  quote_number: string | null;
  customer_name: string | null;
  customer_address: {
    street: string | null;
    postcode: string | null;
    city: string | null;
  } | null;
  line_items: InvoiceLineItem[];
  payments: InvoicePayment[];
}

const formatSEK = (amount: number | null) => {
  if (amount === null || amount === undefined) return '\u2014';
  return new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' kr';
};

const getStatusBadge = (status: string, dueDate: string | null) => {
  if (status === 'open' && dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (due < today) {
      return <Badge variant="destructive">Forfallen</Badge>;
    }
  }

  switch (status) {
    case 'open':
      return <Badge variant="secondary">Oppen</Badge>;
    case 'paid':
      return <Badge className="bg-green-600 text-white">Betald</Badge>;
    case 'void':
      return <Badge variant="destructive">Makulerad</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
};

const PublicInvoicePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [invoiceData, setInvoiceData] = useState<PublicInvoiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPdfModal, setShowPdfModal] = useState(false);

  useEffect(() => {
    const fetchInvoice = async () => {
      if (!id || !token) {
        setError('Ogiltig lank');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-public-invoice?invoice_id=${id}&token=${token}`,
          {
            headers: { 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          }
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Kunde inte ladda fakturan' }));
          throw new Error(errData.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        setInvoiceData(result);
      } catch (err: any) {
        setError(err.message || 'Kunde inte ladda fakturan');
      } finally {
        setLoading(false);
      }
    };

    fetchInvoice();
  }, [id, token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
            <h2 className="text-xl font-semibold">Fakturan kunde inte laddas</h2>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!invoiceData) return null;

  const hardwareItems = invoiceData.line_items.filter(i => i.line_type === 'hardware');
  const laborItems = invoiceData.line_items.filter(i => i.line_type === 'labor');
  const otherItems = invoiceData.line_items.filter(i => i.line_type === 'travel_other');
  const isPaid = invoiceData.status === 'paid';
  const isVoid = invoiceData.status === 'void';

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Smart Home Solutions</h1>
          <p className="text-muted-foreground">Faktura {invoiceData.invoice_number}</p>
          {invoiceData.customer_name && (
            <p className="text-lg">{invoiceData.customer_name}</p>
          )}
        </div>

        {/* Status */}
        <div className="flex justify-center">
          {getStatusBadge(invoiceData.status, invoiceData.due_date)}
        </div>

        {isPaid && (
          <Card>
            <CardContent className="pt-4 text-center">
              <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
              <p className="text-lg font-semibold text-green-600">Fakturan ar betald</p>
              {invoiceData.paid_at && (
                <p className="text-sm text-muted-foreground">
                  Betald {new Date(invoiceData.paid_at).toLocaleDateString('sv-SE')}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {isVoid && (
          <Card>
            <CardContent className="pt-4 text-center">
              <AlertTriangle className="h-10 w-10 text-destructive mx-auto mb-2" />
              <p className="text-lg font-semibold text-destructive">Fakturan ar makulerad</p>
            </CardContent>
          </Card>
        )}

        {/* Line items */}
        {hardwareItems.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <h3 className="font-semibold mb-3">Hardvara</h3>
              <div className="space-y-2">
                {hardwareItems.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.description} {item.quantity > 1 && <span className="text-muted-foreground">x {item.quantity}</span>}</span>
                    <span className="font-medium">{formatSEK(item.unit_price * item.quantity)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {laborItems.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <h3 className="font-semibold mb-3">Arbete</h3>
              <div className="space-y-2">
                {laborItems.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.description} {item.quantity > 1 && <span className="text-muted-foreground">x {item.quantity}</span>}</span>
                    <span className="font-medium">{formatSEK(item.unit_price * item.quantity)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {otherItems.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <h3 className="font-semibold mb-3">Resa &amp; ovrigt</h3>
              <div className="space-y-2">
                {otherItems.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.description} {item.quantity > 1 && <span className="text-muted-foreground">x {item.quantity}</span>}</span>
                    <span className="font-medium">{formatSEK(item.unit_price * item.quantity)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Totals */}
        <Card>
          <CardContent className="pt-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Summa exkl. moms</span>
              <span>{formatSEK(invoiceData.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Moms (25%)</span>
              <span>{formatSEK(invoiceData.tax)}</span>
            </div>
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="text-lg font-bold">Totalt inkl. moms</span>
              <span className="text-lg font-bold text-primary">{formatSEK(invoiceData.total)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Payment details */}
        {!isPaid && !isVoid && (
          <Card>
            <CardContent className="pt-4 space-y-3">
              <h3 className="font-semibold">Betalningsinformation</h3>
              <div className="text-sm space-y-1">
                <p><span className="text-muted-foreground">Betalningsreferens:</span> {invoiceData.invoice_number}</p>
                {invoiceData.due_date && (
                  <p><span className="text-muted-foreground">Forfallodatum:</span> {new Date(invoiceData.due_date).toLocaleDateString('sv-SE')}</p>
                )}
                <p><span className="text-muted-foreground">Belopp:</span> {formatSEK(invoiceData.total)}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Payment history */}
        {invoiceData.payments.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <h3 className="font-semibold mb-3">Betalningshistorik</h3>
              <div className="space-y-2">
                {invoiceData.payments.map(payment => (
                  <div key={payment.id} className="flex justify-between text-sm border-b border-border pb-2 last:border-0">
                    <div>
                      <p>{new Date(payment.payment_date).toLocaleDateString('sv-SE')}</p>
                      {payment.method && <p className="text-xs text-muted-foreground">{payment.method}</p>}
                    </div>
                    <span className="font-medium">{formatSEK(payment.amount)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* PDF download */}
        {!isVoid && (
          <Button variant="outline" className="w-full" onClick={() => setShowPdfModal(true)}>
            <Eye className="h-4 w-4 mr-2" />
            Visa / Ladda ner PDF
          </Button>
        )}

        {/* Footer */}
        <p className="text-center text-sm text-muted-foreground pt-4">
          Fragor? Kontakta oss pa{' '}
          <a href="mailto:support@smarthomesolutions.se" className="text-primary hover:underline">
            support@smarthomesolutions.se
          </a>
        </p>
      </div>

      {/* PDF Modal */}
      <InvoicePdfModal
        open={showPdfModal}
        onOpenChange={setShowPdfModal}
        invoiceId={invoiceData.id}
        invoiceNumber={invoiceData.invoice_number || invoiceData.id}
        publicToken={token}
      />
    </div>
  );
};

export default PublicInvoicePage;
