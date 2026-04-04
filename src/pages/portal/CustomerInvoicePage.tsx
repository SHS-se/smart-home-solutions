import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import PortalLayout from '@/components/portal/PortalLayout';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import InvoicePdfModal from '@/components/portal/invoices/InvoicePdfModal';
import InvoiceDocumentView, {
  type InvoiceDocumentData,
} from '@/components/portal/invoices/InvoiceDocumentView';

const CustomerInvoicePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [showPdfModal, setShowPdfModal] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [authLoading, navigate, user]);

  const { data: invoiceData, isLoading, error } = useQuery({
    queryKey: ['customer-invoice-document', id],
    queryFn: async () => {
      const { data, error: invokeError } = await supabase.functions.invoke('fetch-customer-invoice', {
        body: { invoice_id: id },
      });

      if (invokeError) {
        throw invokeError;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      return data as InvoiceDocumentData;
    },
    enabled: !!id && !!user,
  });

  return (
    <PortalLayout>
      {authLoading || isLoading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : error || !invoiceData ? (
        <div className="min-h-[400px] flex items-center justify-center p-4">
          <Card className="max-w-md w-full">
            <CardContent className="pt-6 text-center space-y-4">
              <AlertTriangle className="h-12 w-12 text-destructive mx-auto" />
              <h2 className="text-xl font-semibold">Fakturan kunde inte laddas</h2>
              <p className="text-muted-foreground">
                {error instanceof Error ? error.message : 'Kunde inte ladda fakturan'}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          <InvoiceDocumentView
            invoice={invoiceData}
            onOpenPdf={() => setShowPdfModal(true)}
          />
          <InvoicePdfModal
            open={showPdfModal}
            onOpenChange={setShowPdfModal}
            invoiceId={invoiceData.id}
            invoiceNumber={invoiceData.invoice_number || invoiceData.id}
          />
        </>
      )}
    </PortalLayout>
  );
};

export default CustomerInvoicePage;
