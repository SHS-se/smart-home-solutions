import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, ArrowLeft, ExternalLink, Send, Copy, Plus,
  FileText, CheckCircle2, XCircle, Clock, Eye, MessageSquare,
  Receipt, Mail, AlertCircle
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/contexts/AuthContext';
import { useViewedCustomer } from '@/contexts/ViewedCustomerContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { getQuoteStatusBadge } from '@/lib/quote-status-badge';
import { supersedeActiveQuotesInChain } from '@/lib/supersede-quotes';

// ─── Types ───
interface QuoteDetail {
  id: string;
  quote_number: string | null;
  version: number;
  is_latest: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  last_viewed_at: string | null;
  accepted_at: string | null;
  accepted_by_name: string | null;
  accepted_by_email: string | null;
  declined_at: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  bom_id: string | null;
  customer_id: string | null;
  parent_quote_id: string | null;
}

interface QuoteEvent {
  id: string;
  event_type: string;
  actor_type: string | null;
  actor_email: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface QuoteMessage {
  id: string;
  author_type: string;
  author_email: string | null;
  author_name: string | null;
  body_markdown: string;
  created_at: string;
  source: string;
}

interface ComputedTotals {
  subtotal_ex_vat: number | null;
  vat_total: number | null;
  total_inc_vat: number | null;
  hardware_total: number | null;
  labor_total: number | null;
  travel_total: number | null;
}

// ─── Helpers ───
const canEdit = (status: string) =>
  ['draft', 'sent', 'viewed', 'revision_requested'].includes(status);

const canResend = (status: string) =>
  ['sent', 'viewed', 'revision_requested'].includes(status);

const canCreateRevision = (status: string) => status === 'accepted';

const canDuplicate = (status: string) =>
  ['declined', 'expired', 'cancelled'].includes(status);

const formatTimestamp = (ts: string) =>
  new Date(ts).toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const formatDate = (ts: string) =>
  new Date(ts).toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });

const formatAmount = (amount: number | null) => {
  if (amount == null) return '—';
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
};

// ─── Component ───
const CustomerViewOfferDetail: React.FC = () => {
  const { quoteId } = useParams<{ quoteId: string }>();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { customerId, customerData, loading: customerLoading, error: customerError } = useViewedCustomer();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [newMessage, setNewMessage] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isCreatingRevision, setIsCreatingRevision] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
    if (!authLoading && !isStaff) navigate('/portal');
  }, [user, isStaff, authLoading, navigate]);

  // ─── Queries ───
  const { data: quote, isLoading: quoteLoading } = useQuery({
    queryKey: ['customer-quote-detail', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, version, is_latest, status, created_at, updated_at, sent_at, last_viewed_at, accepted_at, accepted_by_name, accepted_by_email, declined_at, cancelled_at, expires_at, bom_id, customer_id, parent_quote_id')
        .eq('id', quoteId!)
        .single();
      if (error) throw error;
      return data as QuoteDetail;
    },
    enabled: !!quoteId,
  });

  const { data: bomName } = useQuery({
    queryKey: ['bom-name', quote?.bom_id],
    queryFn: async () => {
      const { data } = await supabase
        .from('boms')
        .select('project_name')
        .eq('id', quote!.bom_id!)
        .single();
      return data?.project_name || null;
    },
    enabled: !!quote?.bom_id,
  });

  const { data: totals } = useQuery({
    queryKey: ['quote-totals', quoteId],
    queryFn: async () => {
      const { data } = await supabase
        .from('quote_computed_totals')
        .select('*')
        .eq('quote_id', quoteId!)
        .single();
      return data as ComputedTotals | null;
    },
    enabled: !!quoteId,
  });

  const { data: events = [] } = useQuery({
    queryKey: ['quote-events', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_events')
        .select('*')
        .eq('quote_id', quoteId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as QuoteEvent[];
    },
    enabled: !!quoteId,
  });

  const { data: messages = [] } = useQuery({
    queryKey: ['quote-messages', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_messages')
        .select('*')
        .eq('quote_id', quoteId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as QuoteMessage[];
    },
    enabled: !!quoteId,
  });

  // ─── Actions ───
  const handleResend = async () => {
    if (!quoteId) return;
    setIsResending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-quote-email', {
        body: { quote_id: quoteId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast({ title: t('Offert skickad', 'Quote sent') });
      queryClient.invalidateQueries({ queryKey: ['quote-events', quoteId] });
      queryClient.invalidateQueries({ queryKey: ['customer-quote-detail', quoteId] });
    } catch (err) {
      toast({ title: t('Fel vid skickande', 'Error sending'), description: err.message, variant: 'destructive' });
    } finally {
      setIsResending(false);
    }
  };

  const handleSendMessage = async () => {
    if (!quoteId || !newMessage.trim() || !user) return;
    setIsSendingMessage(true);
    try {
      // Insert message
      const { error: msgError } = await supabase
        .from('quote_messages')
        .insert({
          quote_id: quoteId,
          author_type: 'staff',
          author_email: user.email,
          author_name: user.email?.split('@')[0] || 'Staff',
          body_markdown: newMessage.trim(),
          source: 'portal',
        });
      if (msgError) throw msgError;

      // Log event
      await supabase.from('quote_events').insert({
        quote_id: quoteId,
        event_type: 'message_posted',
        actor_type: 'staff',
        actor_email: user.email,
      });

      setNewMessage('');
      queryClient.invalidateQueries({ queryKey: ['quote-messages', quoteId] });
      queryClient.invalidateQueries({ queryKey: ['quote-events', quoteId] });
      toast({ title: t('Meddelande skickat', 'Message sent') });
    } catch (err) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setIsSendingMessage(false);
    }
  };

  const handleCreateRevision = async () => {
    if (!quote) return;
    setIsCreatingRevision(true);
    try {
      // 1) Fetch current quote lines
      const { data: lines, error: linesErr } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', quote.id);
      if (linesErr) throw linesErr;

      // 2) Insert new quote
      const { data: newQuote, error: insertErr } = await supabase
        .from('quotes')
        .insert({
          parent_quote_id: quote.id,
          version: quote.version + 1,
          status: 'draft',
          customer_id: quote.customer_id,
          bom_id: quote.bom_id,
          is_latest: true,
        })
        .select('id')
        .single();
      if (insertErr) throw insertErr;

      // 3) Mark current quote as not latest
      await supabase
        .from('quotes')
        .update({ is_latest: false })
        .eq('id', quote.id);

      // 4) Copy quote lines to new quote
      if (lines && lines.length > 0) {
        const newLines = lines.map(({ id, created_at, quote_id, ...rest }) => ({
          ...rest,
          quote_id: newQuote.id,
        }));
        const { error: copyErr } = await supabase
          .from('quote_lines')
          .insert(newLines);
        if (copyErr) throw copyErr;
      }

      // 4.5) Supersede active quotes in the chain
      if (quote.bom_id) {
        await supersedeActiveQuotesInChain({ newQuoteId: newQuote.id, bomId: quote.bom_id });
      }

      // 5) Log event
      await supabase.from('quote_events').insert({
        quote_id: newQuote.id,
        event_type: 'created',
        actor_type: 'staff',
        actor_email: user?.email,
        metadata: { parent_quote_id: quote.id, revision: true },
      });

      toast({ title: t('Ny revision skapad', 'New revision created') });
      navigate(`/portal/quotes/${newQuote.id}`);
    } catch (err) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setIsCreatingRevision(false);
    }
  };

  const handleDuplicate = async () => {
    if (!quote) return;
    setIsCreatingRevision(true);
    try {
      const { data: lines } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', quote.id);

      const { data: newQuote, error: insertErr } = await supabase
        .from('quotes')
        .insert({
          status: 'draft',
          customer_id: quote.customer_id,
          bom_id: quote.bom_id,
          is_latest: true,
          version: 1,
        })
        .select('id')
        .single();
      if (insertErr) throw insertErr;

      if (lines && lines.length > 0) {
        const newLines = lines.map(({ id, created_at, quote_id, ...rest }) => ({
          ...rest,
          quote_id: newQuote.id,
        }));
        await supabase.from('quote_lines').insert(newLines);
      }

      await supabase.from('quote_events').insert({
        quote_id: newQuote.id,
        event_type: 'created',
        actor_type: 'staff',
        actor_email: user?.email,
        metadata: { duplicated_from: quote.id },
      });

      toast({ title: t('Kopia skapad', 'Copy created') });
      navigate(`/portal/quotes/${newQuote.id}`);
    } catch (err) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setIsCreatingRevision(false);
    }
  };

  // ─── Event helpers ───
  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'created': return <FileText className="h-4 w-4 text-blue-500" />;
      case 'sent': return <Send className="h-4 w-4 text-blue-500" />;
      case 'viewed': return <Eye className="h-4 w-4 text-blue-400" />;
      case 'accept_opened': return <Eye className="h-4 w-4 text-amber-500" />;
      case 'accepted': return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'declined': return <XCircle className="h-4 w-4 text-destructive" />;
      case 'revision_requested': return <AlertCircle className="h-4 w-4 text-amber-500" />;
      case 'message_posted': return <Mail className="h-4 w-4 text-blue-500" />;
      case 'invoice_created': return <Receipt className="h-4 w-4 text-green-500" />;
      case 'cancelled': return <XCircle className="h-4 w-4 text-muted-foreground" />;
      case 'superseded': return <Clock className="h-4 w-4 text-muted-foreground" />;
      default: return <Clock className="h-4 w-4 text-muted-foreground" />;
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
      superseded: { sv: 'Ersatt av nyare version', en: 'Superseded by newer version' },
    };
    const label = labels[eventType];
    return label ? t(label.sv, label.en) : eventType.replace(/_/g, ' ');
  };

  // ─── Render ───
  if (authLoading || customerLoading || quoteLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  if (customerError || !customerData || !quote) {
    return (
      <>
        <Alert variant="destructive">
          <AlertDescription>
            {customerError || t('Offerten kunde inte hittas.', 'Quote not found.')}
          </AlertDescription>
        </Alert>
      </>
    );
  }

  

  return (
    <>
      <div className="space-y-6">
        {/* Back link */}
        <Link
          to={`/portal/customers/${customerId}/offers`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till offerter', 'Back to quotes')}
        </Link>


        {/* ─── Summary header ─── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3">
                <CardTitle className="font-mono text-xl">
                  {quote.quote_number ? `#${quote.quote_number}` : t('Utkast', 'Draft')}
                </CardTitle>
                {getQuoteStatusBadge(quote.status, t)}
                {quote.version > 1 && (
                  <Badge variant="outline" className="font-mono text-xs">v{quote.version}</Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* Customer */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{t('Kund', 'Customer')}</p>
                <p className="font-medium">{customerData.name || '—'}</p>
              </div>
              {/* Project */}
              {bomName && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">{t('Projekt', 'Project')}</p>
                  <p className="font-medium">{bomName}</p>
                </div>
              )}
              {/* Totals */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{t('Total ink. moms', 'Total inc. VAT')}</p>
                <p className="text-2xl font-bold">{formatAmount(totals?.total_inc_vat ?? null)}</p>
                {totals && (
                  <p className="text-xs text-muted-foreground">
                    {t('Exkl. moms', 'Excl. VAT')}: {formatAmount(totals.subtotal_ex_vat)} · {t('Moms', 'VAT')}: {formatAmount(totals.vat_total)}
                  </p>
                )}
              </div>
            </div>

            {/* Key timestamps */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 mt-4 text-xs text-muted-foreground">
              <span>{t('Skapad', 'Created')}: {formatDate(quote.created_at)}</span>
              {quote.sent_at && <span>{t('Skickad', 'Sent')}: {formatDate(quote.sent_at)}</span>}
              {quote.last_viewed_at && <span>{t('Visad', 'Viewed')}: {formatDate(quote.last_viewed_at)}</span>}
              {quote.accepted_at && <span>{t('Accepterad', 'Accepted')}: {formatDate(quote.accepted_at)}</span>}
              {quote.declined_at && <span>{t('Avvisad', 'Declined')}: {formatDate(quote.declined_at)}</span>}
              {quote.cancelled_at && <span>{t('Avbruten', 'Cancelled')}: {formatDate(quote.cancelled_at)}</span>}
              {quote.expires_at && <span>{t('Giltig t.o.m.', 'Valid until')}: {formatDate(quote.expires_at)}</span>}
            </div>
          </CardContent>
        </Card>


        {/* ─── Two-column: Timeline + Messages ─── */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4" />
                {t('Händelselogg', 'Event log')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('Inga händelser.', 'No events.')}</p>
              ) : (
                <div className="relative">
                  <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />
                  <div className="space-y-4">
                    {events.map((event) => (
                      <div key={event.id} className={`relative flex gap-3 items-start ${event.event_type === 'revision_requested' ? 'bg-amber-500/5 -mx-2 px-2 py-1 rounded-md' : ''}`}>
                        <div className="relative z-10 flex-shrink-0 w-6 h-6 bg-background rounded-full border border-border flex items-center justify-center">
                          {getEventIcon(event.event_type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{getEventLabel(event.event_type)}</span>
                            {event.event_type === 'accepted' && (
                              <Badge variant="default" className="bg-green-600 text-xs">{t('Godkänd', 'Accepted')}</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                            <span>{formatTimestamp(event.created_at)}</span>
                            {event.actor_email && <span>· {event.actor_email}</span>}
                            {event.metadata && (event.metadata as any).invoice_number && (
                              <span className="font-mono">#{(event.metadata as any).invoice_number}</span>
                            )}
                            {event.metadata && (event.metadata as any).recipient_email && (
                              <span>→ {(event.metadata as any).recipient_email}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Messages */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                {t('Meddelanden', 'Messages')}
                {messages.length > 0 && (
                  <Badge variant="secondary" className="text-xs">{messages.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground mb-4">{t('Inga meddelanden ännu.', 'No messages yet.')}</p>
              ) : (
                <div className="space-y-3 mb-4 max-h-[400px] overflow-y-auto">
                  {messages.map((msg) => {
                    const isStaffMsg = msg.author_type === 'staff';
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isStaffMsg ? 'justify-end' : 'justify-start'}`}
                      >
                        <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                          isStaffMsg
                            ? 'bg-primary/10 text-foreground'
                            : 'bg-muted text-foreground'
                        }`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-xs">
                              {msg.author_name || msg.author_email || (isStaffMsg ? 'Staff' : t('Kund', 'Customer'))}
                            </span>
                            <span className="text-xs text-muted-foreground">{formatTimestamp(msg.created_at)}</span>
                          </div>
                          <p className="whitespace-pre-wrap">{msg.body_markdown}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <Separator className="my-3" />

              {/* Compose */}
              <div className="space-y-2">
                <Textarea
                  placeholder={t('Skriv ett meddelande till kunden...', 'Write a message to the customer...')}
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={!newMessage.trim() || isSendingMessage}
                  >
                    {isSendingMessage ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                    {t('Skicka', 'Send')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
};

export default CustomerViewOfferDetail;
