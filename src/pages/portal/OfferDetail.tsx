import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2, ArrowLeft, Check, X, MessageSquare,
  CheckCircle2, XCircle, AlertCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import PortalLayout from '@/components/portal/PortalLayout';
import OfferLineBreakdown from '@/components/portal/offers/OfferLineBreakdown';
import OfferRevisionHistory from '@/components/portal/offers/OfferRevisionHistory';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { getQuoteStatusBadge } from '@/lib/quote-status-badge';

// ─── Helpers ───
const formatDate = (ts: string) =>
  new Date(ts).toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' });

const formatSEK = (amount: number | null) => {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(amount)) + ' kr';
};

// ─── Component ───
const OfferDetail: React.FC = () => {
  const { quoteId } = useParams<{ quoteId: string }>();
  const { user, customerData, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Action dialogs
  const [showAcceptDialog, setShowAcceptDialog] = useState(false);
  const [showDeclineDialog, setShowDeclineDialog] = useState(false);
  const [showRevisionDialog, setShowRevisionDialog] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [revisionMessage, setRevisionMessage] = useState('');
  const [isActioning, setIsActioning] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate('/login');
  }, [user, authLoading, navigate]);

  // ─── Data queries ───
  const { data: quote, isLoading: quoteLoading, refetch: refetchQuote } = useQuery({
    queryKey: ['customer-offer', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, version, is_latest, status, created_at, sent_at, accepted_at, declined_at, expires_at, parent_quote_id, bom_id, customer_id')
        .eq('id', quoteId!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!quoteId && !authLoading && !!user,
  });

  const { data: bomData } = useQuery({
    queryKey: ['customer-offer-bom', quote?.bom_id],
    queryFn: async () => {
      const { data } = await supabase
        .from('boms')
        .select('project_name')
        .eq('id', quote!.bom_id!)
        .single();
      return data;
    },
    enabled: !!quote?.bom_id,
  });

  const { data: lines = [] } = useQuery({
    queryKey: ['customer-offer-lines', quoteId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quote_lines')
        .select('id, section, description, quantity, unit_price_ex_vat, unit_price_inc_vat, vat_rate')
        .eq('quote_id', quoteId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!quoteId && !authLoading && !!user,
  });

  const { data: totals } = useQuery({
    queryKey: ['customer-offer-totals', quoteId],
    queryFn: async () => {
      const { data } = await supabase
        .from('quote_computed_totals')
        .select('*')
        .eq('quote_id', quoteId!)
        .single();
      return data;
    },
    enabled: !!quoteId,
  });

  // Fetch all versions in the chain
  const { data: chainVersions = [] } = useQuery({
    queryKey: ['customer-offer-chain', quote?.parent_quote_id, quote?.id],
    queryFn: async () => {
      const rootId = quote!.parent_quote_id || quote!.id;
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, version, status, created_at, is_latest')
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`)
        .order('version', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!quote,
  });

  // Determine if viewing the latest version
  const latestInChain = chainVersions.length > 0
    ? chainVersions.reduce((a, b) => (a.version > b.version ? a : b))
    : null;
  const isViewingLatest = !latestInChain || latestInChain.id === quoteId;

  // Action availability
  const canAccept = isViewingLatest && ['sent', 'viewed'].includes(quote?.status ?? '');
  const canDecline = isViewingLatest && ['sent', 'viewed', 'revision_requested'].includes(quote?.status ?? '');
  const canRequestRevision = isViewingLatest && ['sent', 'viewed'].includes(quote?.status ?? '');
  const showActions = canAccept || canDecline || canRequestRevision;

  // ─── Action handler ───
  const handleAction = async (action: 'accept' | 'decline' | 'revision_request') => {
    setIsActioning(true);
    try {
      const body: Record<string, string> = { quote_id: quoteId!, action };
      if (action === 'decline' && declineReason) body.reason = declineReason;
      if (action === 'revision_request') {
        if (!revisionMessage.trim()) return;
        body.message = revisionMessage.trim();
      }

      const { data, error } = await supabase.functions.invoke('customer-quote-action', { body });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setShowAcceptDialog(false);
      setShowDeclineDialog(false);
      setShowRevisionDialog(false);
      setDeclineReason('');
      setRevisionMessage('');

      // Refetch data
      queryClient.invalidateQueries({ queryKey: ['customer-offer', quoteId] });
      queryClient.invalidateQueries({ queryKey: ['customer-offer-chain'] });
      refetchQuote();

      toast({
        title:
          action === 'accept'
            ? t('Offerten är godkänd!', 'Quote accepted!')
            : action === 'decline'
            ? t('Offerten har avvisats.', 'Quote declined.')
            : t('Ändringsförfrågan skickad.', 'Revision request sent.'),
      });
    } catch (err: any) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setIsActioning(false);
    }
  };

  // ─── Render ───
  if (authLoading || quoteLoading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (!quote) {
    return (
      <PortalLayout>
        <Alert variant="destructive">
          <AlertDescription>{t('Offerten kunde inte hittas.', 'Quote not found.')}</AlertDescription>
        </Alert>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Back link */}
        <Link
          to="/portal/offers"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('Tillbaka till offerter', 'Back to offers')}
        </Link>

        {/* Older version banner */}
        {!isViewingLatest && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>{t('Du visar en tidigare version av denna offert.', 'You are viewing an older version of this offer.')}</span>
              {latestInChain && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/portal/offers/${latestInChain.id}`)}
                >
                  {t('Visa senaste', 'View latest')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* ─── Summary card ─── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <CardTitle className="font-mono text-xl">
                  {quote.quote_number
                    ? `${t('Offert', 'Offer')} ${quote.quote_number}`
                    : t('Offert', 'Offer')}
                </CardTitle>
                {getQuoteStatusBadge(quote.status, t)}
                {quote.version > 1 && (
                  <Badge variant="outline" className="font-mono text-xs">
                    v{quote.version}
                  </Badge>
                )}
                {!isViewingLatest && (
                  <Badge variant="secondary" className="text-xs">
                    {t('Tidigare version', 'Previous version')}
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {/* Project */}
              {bomData?.project_name && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    {t('Projekt', 'Project')}
                  </p>
                  <p className="font-medium">{bomData.project_name}</p>
                </div>
              )}
              {/* Date */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  {t('Datum', 'Date')}
                </p>
                <p className="font-medium">{formatDate(quote.sent_at || quote.created_at)}</p>
              </div>
              {/* Total */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  {t('Totalt inkl. moms', 'Total incl. VAT')}
                </p>
                <p className="text-2xl font-bold">{formatSEK(totals?.total_inc_vat ?? null)}</p>
              </div>
            </div>

            {/* Status-specific info */}
            {quote.status === 'accepted' && quote.accepted_at && (
              <div className="mt-4 flex items-center gap-2 text-sm text-green-700 bg-green-500/10 rounded-lg px-3 py-2">
                <CheckCircle2 className="h-4 w-4" />
                {t('Accepterad', 'Accepted')} {formatDate(quote.accepted_at)}
              </div>
            )}
            {quote.status === 'declined' && quote.declined_at && (
              <div className="mt-4 flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <XCircle className="h-4 w-4" />
                {t('Avvisad', 'Declined')} {formatDate(quote.declined_at)}
              </div>
            )}
            {quote.status === 'revision_requested' && (
              <div className="mt-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-500/10 rounded-lg px-3 py-2">
                <MessageSquare className="h-4 w-4" />
                {t('Ändringsförfrågan skickad – vi återkommer.', 'Revision request sent – we will get back to you.')}
              </div>
            )}

            {/* Expiry */}
            {quote.expires_at && ['sent', 'viewed'].includes(quote.status) && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('Giltig till', 'Valid until')} {formatDate(quote.expires_at)}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ─── Line breakdown ─── */}
        <OfferLineBreakdown lines={lines} totals={totals ?? null} t={t} />

        {/* ─── Action buttons ─── */}
        {showActions && (
          <div className="space-y-3">
            {canAccept && (
              <Button className="w-full h-12 text-base" onClick={() => setShowAcceptDialog(true)}>
                <Check className="h-5 w-5 mr-2" />
                {t('Acceptera offert', 'Accept offer')}
              </Button>
            )}
            <div className="grid grid-cols-2 gap-3">
              {canDecline && (
                <Button variant="outline" className="h-12" onClick={() => setShowDeclineDialog(true)}>
                  <X className="h-5 w-5 mr-2" />
                  {t('Avvisa', 'Decline')}
                </Button>
              )}
              {canRequestRevision && (
                <Button variant="outline" className="h-12" onClick={() => setShowRevisionDialog(true)}>
                  <MessageSquare className="h-5 w-5 mr-2" />
                  {t('Begär ändring', 'Request change')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ─── Revision history ─── */}
        <OfferRevisionHistory
          versions={chainVersions}
          currentQuoteId={quoteId!}
          t={t}
        />
      </div>

      {/* ─── Accept Dialog ─── */}
      <Dialog open={showAcceptDialog} onOpenChange={setShowAcceptDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Acceptera offert', 'Accept offer')}</DialogTitle>
            <DialogDescription>
              {t(
                'Vill du godkänna offerten? En faktura kommer att skickas.',
                'Do you want to accept the offer? An invoice will be sent.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAcceptDialog(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button onClick={() => handleAction('accept')} disabled={isActioning}>
              {isActioning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Godkänn', 'Accept')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Decline Dialog ─── */}
      <Dialog open={showDeclineDialog} onOpenChange={setShowDeclineDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Avvisa offert', 'Decline offer')}</DialogTitle>
            <DialogDescription>
              {t('Du kan ange en anledning (valfritt).', 'You can provide a reason (optional).')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder={t('Anledning (valfritt)', 'Reason (optional)')}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeclineDialog(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={() => handleAction('decline')} disabled={isActioning}>
              {isActioning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Avvisa offert', 'Decline offer')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Revision Dialog ─── */}
      <Dialog open={showRevisionDialog} onOpenChange={setShowRevisionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Begär ändring', 'Request change')}</DialogTitle>
            <DialogDescription>
              {t(
                'Beskriv vad du vill ändra så återkommer vi.',
                'Describe what you would like to change and we will get back to you.'
              )}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={revisionMessage}
            onChange={(e) => setRevisionMessage(e.target.value)}
            placeholder={t('Beskriv önskade ändringar...', 'Describe desired changes...')}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRevisionDialog(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button onClick={() => handleAction('revision_request')} disabled={isActioning || !revisionMessage.trim()}>
              {isActioning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Skicka', 'Send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
};

export default OfferDetail;
