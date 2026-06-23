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
  Eye,
  MessageSquare,
  AlertCircle,
  Mail
} from 'lucide-react';

interface QuoteEventLogProps {
  quoteId: string;
}

interface QuoteEvent {
  id: string;
  event_type: string;
  actor_type: string | null;
  actor_email: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

const QuoteEventLog: React.FC<QuoteEventLogProps> = ({ quoteId }) => {
  const { t } = useLanguage();

  const { data: events = [] } = useQuery({
    queryKey: ['quote_events', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_events')
        .select('*')
        .eq('quote_id', quoteId)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return data as QuoteEvent[];
    },
  });

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'created':
        return <FileText className="h-4 w-4 text-blue-500" />;
      case 'sent':
        return <Send className="h-4 w-4 text-blue-500" />;
      case 'viewed':
        return <Eye className="h-4 w-4 text-blue-400" />;
      case 'accept_opened':
        return <Eye className="h-4 w-4 text-amber-500" />;
      case 'accepted':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'declined':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'revision_requested':
        return <MessageSquare className="h-4 w-4 text-amber-500" />;
      case 'message_posted':
        return <Mail className="h-4 w-4 text-blue-500" />;
      case 'invoice_created':
        return <Receipt className="h-4 w-4 text-green-500" />;
      case 'cancelled':
        return <XCircle className="h-4 w-4 text-muted-foreground" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getEventLabel = (eventType: string) => {
    const labels: Record<string, { sv: string; en: string }> = {
      created: { sv: 'Offert skapad', en: 'Quote created' },
      sent: { sv: 'Offert skickad via e-post', en: 'Quote sent via email' },
      viewed: { sv: 'Kunden öppnade offerten', en: 'Customer viewed the quote' },
      accept_opened: { sv: 'Accepteringsflöde öppnat', en: 'Accept flow opened' },
      accepted: { sv: 'Offert accepterad av kund', en: 'Quote accepted by customer' },
      declined: { sv: 'Offert avvisad av kund', en: 'Quote declined by customer' },
      revision_requested: { sv: 'Kunden begärde ändring', en: 'Customer requested revision' },
      message_posted: { sv: 'Nytt meddelande', en: 'New message' },
      invoice_created: { sv: 'Faktura skapad', en: 'Invoice created' },
      cancelled: { sv: 'Offert avbruten', en: 'Quote cancelled' },
    };

    const label = labels[eventType];
    if (label) return t(label.sv, label.en);
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
          <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />
          <div className="space-y-4">
            {events.map((event) => (
              <div key={event.id} className="relative flex gap-3 items-start">
                <div className="relative z-10 flex-shrink-0 w-6 h-6 bg-background rounded-full border border-border flex items-center justify-center">
                  {getEventIcon(event.event_type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {getEventLabel(event.event_type)}
                    </span>
                    {event.event_type === 'accepted' && (
                      <Badge variant="default" className="bg-green-600 text-xs">
                        {t('Godkänd', 'Accepted')}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>{formatTimestamp(event.created_at)}</span>
                    {event.actor_email && (
                      <span>· {event.actor_email}</span>
                    )}
                    {event.metadata && (event.metadata as { invoice_number?: string; recipient_email?: string }).invoice_number && (
                      <span className="font-mono">#{(event.metadata as { invoice_number?: string; recipient_email?: string }).invoice_number}</span>
                    )}
                    {event.metadata && (event.metadata as { invoice_number?: string; recipient_email?: string }).recipient_email && (
                      <span>→ {(event.metadata as { invoice_number?: string; recipient_email?: string }).recipient_email}</span>
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

export default QuoteEventLog;
