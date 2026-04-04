import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, CheckCircle2, Eye } from 'lucide-react';

export interface InvoiceDocumentLineItem {
  id: string;
  line_type: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  sku: string | null;
  category: string | null;
}

export interface InvoiceDocumentPayment {
  id: string;
  payment_date: string;
  amount: number;
  method: string | null;
  reference: string | null;
  note: string | null;
}

export interface InvoiceDocumentData {
  id: string;
  invoice_number: string | null;
  status: string | null;
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
  line_items: InvoiceDocumentLineItem[];
  payments: InvoiceDocumentPayment[];
  payment_details: {
    bankgiro_number: string | null;
    payee_name: string;
    payment_reference: string | null;
    amount: number;
    due_date: string | null;
    currency: string;
    qr_payload: string | null;
    qr_data_url: string | null;
    manual_payment_instruction: string;
  };
}

interface InvoiceDocumentViewProps {
  invoice: InvoiceDocumentData;
  onOpenPdf?: () => void;
}

const formatSEK = (amount: number | null) => {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount) + ' kr';
};

const getStatusBadge = (status: string | null, dueDate: string | null) => {
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
      return <Badge variant="secondary">{status || 'Okand'}</Badge>;
  }
};

const InvoiceDocumentView: React.FC<InvoiceDocumentViewProps> = ({
  invoice,
  onOpenPdf,
}) => {
  const hardwareItems = invoice.line_items.filter((item) => item.line_type === 'hardware');
  const laborItems = invoice.line_items.filter((item) => item.line_type === 'labor');
  const otherItems = invoice.line_items.filter((item) => item.line_type === 'travel_other');
  const isPaid = invoice.status === 'paid';
  const isVoid = invoice.status === 'void';

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Smart Home Solutions</h1>
        <p className="text-muted-foreground">Faktura {invoice.invoice_number}</p>
        {invoice.customer_name && <p className="text-lg">{invoice.customer_name}</p>}
      </div>

      <div className="flex justify-center">
        {getStatusBadge(invoice.status, invoice.due_date)}
      </div>

      {isPaid && (
        <Card>
          <CardContent className="pt-4 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
            <p className="text-lg font-semibold text-green-600">Fakturan ar betald</p>
            {invoice.paid_at && (
              <p className="text-sm text-muted-foreground">
                Betald {new Date(invoice.paid_at).toLocaleDateString('sv-SE')}
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

      {hardwareItems.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <h3 className="font-semibold mb-3">Hardvara</h3>
            <div className="space-y-2">
              {hardwareItems.map((item) => (
                <div key={item.id} className="flex justify-between text-sm gap-4">
                  <span>
                    {item.description}
                    {item.quantity > 1 && <span className="text-muted-foreground"> x {item.quantity}</span>}
                  </span>
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
              {laborItems.map((item) => (
                <div key={item.id} className="flex justify-between text-sm gap-4">
                  <span>
                    {item.description}
                    {item.quantity > 1 && <span className="text-muted-foreground"> x {item.quantity}</span>}
                  </span>
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
            <h3 className="font-semibold mb-3">Resa och ovrigt</h3>
            <div className="space-y-2">
              {otherItems.map((item) => (
                <div key={item.id} className="flex justify-between text-sm gap-4">
                  <span>
                    {item.description}
                    {item.quantity > 1 && <span className="text-muted-foreground"> x {item.quantity}</span>}
                  </span>
                  <span className="font-medium">{formatSEK(item.unit_price * item.quantity)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Summa exkl. moms</span>
            <span>{formatSEK(invoice.subtotal)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Moms (25%)</span>
            <span>{formatSEK(invoice.tax)}</span>
          </div>
          <div className="border-t border-border pt-2 flex justify-between">
            <span className="text-lg font-bold">Totalt inkl. moms</span>
            <span className="text-lg font-bold text-primary">{formatSEK(invoice.total)}</span>
          </div>
        </CardContent>
      </Card>

      {!isPaid && !isVoid && (
        <Card>
          <CardContent className="pt-4 space-y-4">
            <div>
              <h3 className="font-semibold">Betalningsinformation</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {invoice.payment_details.manual_payment_instruction}
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
              <div className="text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">Bankgiro:</span>{' '}
                  {invoice.payment_details.bankgiro_number || 'Ej konfigurerat'}
                </p>
                <p>
                  <span className="text-muted-foreground">Betalningsreferens:</span>{' '}
                  {invoice.payment_details.payment_reference || '—'}
                </p>
                {invoice.payment_details.due_date && (
                  <p>
                    <span className="text-muted-foreground">Forfallodatum:</span>{' '}
                    {new Date(invoice.payment_details.due_date).toLocaleDateString('sv-SE')}
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">Belopp:</span>{' '}
                  {formatSEK(invoice.payment_details.amount)}
                </p>
                <p>
                  <span className="text-muted-foreground">Mottagare:</span>{' '}
                  {invoice.payment_details.payee_name}
                </p>
              </div>
              {invoice.payment_details.qr_data_url && (
                <div className="rounded-lg border border-border p-3 bg-white">
                  <img
                    src={invoice.payment_details.qr_data_url}
                    alt="Betalnings-QR"
                    className="h-32 w-32"
                  />
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {invoice.payments.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <h3 className="font-semibold mb-3">Betalningshistorik</h3>
            <div className="space-y-2">
              {invoice.payments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex justify-between text-sm border-b border-border pb-2 last:border-0"
                >
                  <div>
                    <p>{new Date(payment.payment_date).toLocaleDateString('sv-SE')}</p>
                    {payment.method && <p className="text-xs text-muted-foreground">{payment.method}</p>}
                    {payment.reference && (
                      <p className="text-xs text-muted-foreground">Ref: {payment.reference}</p>
                    )}
                  </div>
                  <span className="font-medium">{formatSEK(payment.amount)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!isVoid && onOpenPdf && (
        <Button variant="outline" className="w-full" onClick={onOpenPdf}>
          <Eye className="h-4 w-4 mr-2" />
          Visa / Ladda ner PDF
        </Button>
      )}
    </div>
  );
};

export default InvoiceDocumentView;
