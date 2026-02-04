import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, FileCheck, ExternalLink, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { openExternalUrl } from '@/lib/stripe-dashboard';

interface Quote {
  id: string;
  quote_number: string;
  status: string;
  stripe_status: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  is_latest: boolean;
  bom_id: string | null;
  stripe_quote_id: string | null;
  bom: {
    project_name: string;
  } | null;
}

const Offers: React.FC = () => {
  const { user, customerData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/login');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const fetchQuotes = async () => {
      if (!customerData?.id) return;
      setLoading(true);
      setError(null);

      try {
        const { data, error: fetchError } = await supabase
          .from('quotes')
          .select(`
            id,
            quote_number,
            status,
            stripe_status,
            created_at,
            updated_at,
            version,
            is_latest,
            bom_id,
            stripe_quote_id,
            bom:boms(project_name)
          `)
          .eq('customer_id', customerData.id)
          .eq('is_test', customerData.is_test ?? false)
          .neq('status', 'draft')
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;
        setQuotes(data || []);
      } catch (err) {
        console.error('Error fetching quotes:', err);
        setError(t('Kunde inte hämta offerter.', 'Could not fetch offers.'));
      } finally {
        setLoading(false);
      }
    };

    if (!authLoading && customerData) {
      fetchQuotes();
    }
  }, [customerData, authLoading, t]);

  const handleDownloadPdf = async (quote: Quote) => {
    if (!quote.stripe_quote_id) return;
    
    setDownloadingId(quote.id);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('get-stripe-quote-pdf', {
        body: { quoteId: quote.id },
      });

      if (fnError) throw fnError;
      if (data?.url) {
        openExternalUrl(data.url);
      }
    } catch (err) {
      console.error('Error downloading PDF:', err);
    } finally {
      setDownloadingId(null);
    }
  };

  const getStatusBadge = (status: string, stripeStatus: string | null) => {
    const displayStatus = stripeStatus || status;
    
    switch (displayStatus) {
      case 'open':
        return <Badge variant="default">{t('Öppen', 'Open')}</Badge>;
      case 'accepted':
        return <Badge className="bg-[#5A8F73] text-white">{t('Accepterad', 'Accepted')}</Badge>;
      case 'canceled':
      case 'cancelled':
        return <Badge variant="secondary">{t('Avbruten', 'Cancelled')}</Badge>;
      case 'draft':
        return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
      default:
        return <Badge variant="secondary">{displayStatus}</Badge>;
    }
  };

  if (authLoading || loading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (error) {
    return (
      <PortalLayout>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-medium">{t('Mina offerter', 'My Offers')}</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileCheck className="w-5 h-5" />
              {t('Offerter', 'Offers')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {quotes.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {t('Du har inga offerter ännu.', 'You have no offers yet.')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Offertnummer', 'Quote Number')}</TableHead>
                    <TableHead>{t('Projekt', 'Project')}</TableHead>
                    <TableHead>{t('Status', 'Status')}</TableHead>
                    <TableHead>{t('Datum', 'Date')}</TableHead>
                    <TableHead className="text-right">{t('Åtgärder', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotes.map((quote) => (
                    <TableRow key={quote.id}>
                      <TableCell className="font-medium">
                        {quote.quote_number}
                        {quote.version > 1 && (
                          <span className="text-muted-foreground ml-1">v{quote.version}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {quote.bom?.project_name || '-'}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(quote.status, quote.stripe_status)}
                      </TableCell>
                      <TableCell>
                        {new Date(quote.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {quote.stripe_quote_id && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDownloadPdf(quote)}
                            disabled={downloadingId === quote.id}
                          >
                            {downloadingId === quote.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            <span className="ml-2 hidden sm:inline">{t('Ladda ner PDF', 'Download PDF')}</span>
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
    </PortalLayout>
  );
};

export default Offers;
