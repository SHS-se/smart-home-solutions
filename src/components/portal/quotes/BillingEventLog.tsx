import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  FileText, 
  Send, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Receipt,
  CreditCard,
  Mail,
  AlertCircle
} from 'lucide-react';

interface BillingEventLogProps {
  quoteId: string;
}

interface BillingEvent {
  id: string;
  event_type: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

const BillingEventLog: React.FC<BillingEventLogProps> = ({ quoteId }) => {
  const { t } = useLanguage();

  const { data: events = [] } = useQuery({
    queryKey: ['billing_events', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('billing_events')
        .select('*')
        .eq('quote_id', quoteId)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return data as BillingEvent[];
    },
  });

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'quote_created':
        return <FileText className="h-4 w-4 text-blue-500" />;
      case 'quote_sent':
        return <Send className="h-4 w-4 text-blue-500" />;
      case 'invoice_created':
        return <Receipt className="h-4 w-4 text-blue-500" />;
      case 'invoice_finalized':
        return <CheckCircle2 className="h-4 w-4 text-amber-500" />;
      case 'invoice_emailed':
        return <Mail className="h-4 w-4 text-blue-500" />;
      case 'invoice_paid':
        return <CreditCard className="h-4 w-4 text-green-500" />;
      case 'invoice_voided':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'invoice_uncollectible':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getEventLabel = (eventType: string) => {
    const labels: Record<string, { sv: string; en: string }> = {
      quote_created: { sv: 'Offert skapad', en: 'Quote created' },
      quote_sent: { sv: 'Offert skickad', en: 'Quote sent' },
      quote_updated: { sv: 'Offert uppdaterad', en: 'Quote updated' },
      invoice_created: { sv: 'Faktura skapad', en: 'Invoice created' },
      invoice_finalized: { sv: 'Faktura fastställd', en: 'Invoice finalized' },
      invoice_emailed: { sv: 'Faktura e-postad', en: 'Invoice emailed' },
      invoice_paid: { sv: 'Faktura betald', en: 'Invoice paid' },
      invoice_voided: { sv: 'Faktura makulerad', en: 'Invoice voided' },
      invoice_uncollectible: { sv: 'Faktura ej indrivningsbar', en: 'Invoice uncollectible' },
      invoice_updated: { sv: 'Faktura uppdaterad', en: 'Invoice updated' },
    };

    const label = labels[eventType];
    if (label) {
      return t(label.sv, label.en);
    }
    return eventType.replace(/_/g, ' ');
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString('sv-SE', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getEventBadgeVariant = (eventType: string) => {
    if (eventType.includes('paid')) return 'default';
    if (eventType.includes('voided') || eventType.includes('uncollectible')) return 'destructive';
    return 'secondary';
  };

  if (events.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4" />
          {t('Händelselogg', 'Event log')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />

          <div className="space-y-4">
            {events.map((event, index) => (
              <div key={event.id} className="relative flex gap-3 items-start">
                {/* Icon */}
                <div className="relative z-10 flex-shrink-0 w-6 h-6 bg-background rounded-full border border-border flex items-center justify-center">
                  {getEventIcon(event.event_type)}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {getEventLabel(event.event_type)}
                    </span>
                    {event.event_type === 'invoice_paid' && (
                      <Badge variant="default" className="bg-green-600 text-xs">
                        {t('Betald', 'Paid')}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>{formatTimestamp(event.created_at)}</span>
                    {event.metadata && (
                      <>
                        {(event.metadata as { invoice_number?: string; to?: string }).invoice_number && (
                          <span className="font-mono">
                            #{(event.metadata as { invoice_number?: string; to?: string }).invoice_number}
                          </span>
                        )}
                        {(event.metadata as { invoice_number?: string; to?: string }).to && (
                          <span>→ {(event.metadata as { invoice_number?: string; to?: string }).to}</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default BillingEventLog;
