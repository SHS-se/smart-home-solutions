import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import InvoicePdfModal from '@/components/portal/invoices/InvoicePdfModal';
import InvoiceDocumentView, {
  type InvoiceDocumentData,
} from '@/components/portal/invoices/InvoiceDocumentView';

const PublicInvoicePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [invoiceData, setInvoiceData] = useState<InvoiceDocumentData | null>(null);
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
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-public-invoice?invoice_id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
          {
            headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          },
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Kunde inte ladda fakturan' }));
          throw new Error(errData.error || `HTTP ${response.status}`);
        }

        const result = (await response.json()) as InvoiceDocumentData;
        setInvoiceData(result);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Kunde inte ladda fakturan');
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

  if (error || !invoiceData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
            <h2 className="text-xl font-semibold">Fakturan kunde inte laddas</h2>
            <p className="text-muted-foreground">{error || 'Kunde inte ladda fakturan'}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <InvoiceDocumentView
        invoice={invoiceData}
        onOpenPdf={() => setShowPdfModal(true)}
      />
      <p className="text-center text-sm text-muted-foreground pb-8">
        Fragor? Kontakta oss pa{' '}
        <a href="mailto:support@smarthomesolutions.se" className="text-primary hover:underline">
          support@smarthomesolutions.se
        </a>
      </p>
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
