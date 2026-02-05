import React, { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Check, X, MessageSquare, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface QuoteData {
  id: string;
  quote_number: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  customer_name: string | null;
  line_items: Array<{
    id: string;
    section: string;
    description: string;
    quantity: number;
    unit_price_ex_vat: number | null;
    unit_price_inc_vat: number | null;
    vat_rate: number | null;
  }>;
  totals: {
    hardware_total: number | null;
    labor_total: number | null;
    travel_total: number | null;
    subtotal_ex_vat: number | null;
    vat_total: number | null;
    total_inc_vat: number | null;
  } | null;
}

const formatSEK = (amount: number | null) => {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(amount)) + ' kr';
};

const PublicQuotePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [quoteData, setQuoteData] = useState<QuoteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Accept modal
  const [showAcceptModal, setShowAcceptModal] = useState(false);
  const [acceptName, setAcceptName] = useState('');
  const [acceptEmail, setAcceptEmail] = useState('');
  const [acceptConsent, setAcceptConsent] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);

  // Decline modal
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [isDeclining, setIsDeclining] = useState(false);

  // Revision modal
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [revisionName, setRevisionName] = useState('');
  const [revisionEmail, setRevisionEmail] = useState('');
  const [revisionMessage, setRevisionMessage] = useState('');
  const [isRequesting, setIsRequesting] = useState(false);

  // Completed state
  const [actionCompleted, setActionCompleted] = useState<'accepted' | 'declined' | 'revision_requested' | null>(null);

  useEffect(() => {
    const fetchQuote = async () => {
      if (!id || !token) {
        setError('Ogiltig länk');
        setLoading(false);
        return;
      }

      try {
        const { data, error: fetchError } = await supabase.functions.invoke('fetch-public-quote', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: null,
        });

        // Use direct fetch since we need query params
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fetch-public-quote?quote_id=${id}&token=${token}`,
          {
            headers: { 'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          }
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Kunde inte ladda offerten' }));
          throw new Error(errData.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        setQuoteData(result);
      } catch (err: any) {
        setError(err.message || 'Kunde inte ladda offerten');
      } finally {
        setLoading(false);
      }
    };

    fetchQuote();
  }, [id, token]);

  const handleAccept = async () => {
    if (!acceptName || !acceptEmail || !acceptConsent) return;
    setIsAccepting(true);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/accept-quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ quote_id: id, token, name: acceptName, email: acceptEmail, consent: true }),
        }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setShowAcceptModal(false);
      setActionCompleted('accepted');
    } catch (err: any) {
      toast({ title: 'Fel', description: err.message, variant: 'destructive' });
    } finally {
      setIsAccepting(false);
    }
  };

  const handleDecline = async () => {
    setIsDeclining(true);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/decline-quote`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ quote_id: id, token, reason: declineReason || undefined }),
        }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setShowDeclineModal(false);
      setActionCompleted('declined');
    } catch (err: any) {
      toast({ title: 'Fel', description: err.message, variant: 'destructive' });
    } finally {
      setIsDeclining(false);
    }
  };

  const handleRevision = async () => {
    if (!revisionName || !revisionEmail || !revisionMessage) return;
    setIsRequesting(true);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/request-quote-revision`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ quote_id: id, token, message: revisionMessage, name: revisionName, email: revisionEmail }),
        }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setShowRevisionModal(false);
      setActionCompleted('revision_requested');
    } catch (err: any) {
      toast({ title: 'Fel', description: err.message, variant: 'destructive' });
    } finally {
      setIsRequesting(false);
    }
  };

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
            <h2 className="text-xl font-semibold">Offerten kunde inte laddas</h2>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!quoteData) return null;

  const isActionable = ['sent', 'viewed'].includes(quoteData.status) && !actionCompleted;
  const hardwareItems = quoteData.line_items.filter(i => i.section === 'hardware');
  const laborItems = quoteData.line_items.filter(i => i.section === 'labor');
  const travelItems = quoteData.line_items.filter(i => i.section === 'travel');
  const totals = quoteData.totals;

  // Show completion states
  if (actionCompleted || quoteData.status === 'accepted' || quoteData.status === 'declined' || quoteData.status === 'revision_requested') {
    const completedStatus = actionCompleted || quoteData.status;
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            {completedStatus === 'accepted' && (
              <>
                <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto" />
                <h2 className="text-2xl font-bold">Offerten är godkänd!</h2>
                <p className="text-muted-foreground">Tack! Vi kommer att kontakta dig med nästa steg och skicka en faktura.</p>
              </>
            )}
            {completedStatus === 'declined' && (
              <>
                <XCircle className="h-16 w-16 text-destructive mx-auto" />
                <h2 className="text-2xl font-bold">Offerten har avvisats</h2>
                <p className="text-muted-foreground">Tack för att du meddelade oss. Kontakta oss om du ändrar dig.</p>
              </>
            )}
            {completedStatus === 'revision_requested' && (
              <>
                <MessageSquare className="h-16 w-16 text-primary mx-auto" />
                <h2 className="text-2xl font-bold">Ändringsförfrågan skickad</h2>
                <p className="text-muted-foreground">Vi har mottagit ditt meddelande och återkommer så snart som möjligt.</p>
              </>
            )}
            <p className="text-sm text-muted-foreground pt-4">
              Frågor? Kontakta oss på{' '}
              <a href="mailto:support@smarthomesolutions.se" className="text-primary hover:underline">
                support@smarthomesolutions.se
              </a>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Smart Home Solutions</h1>
          <p className="text-muted-foreground">Offert {quoteData.quote_number}</p>
          {quoteData.customer_name && (
            <p className="text-lg">Hej {quoteData.customer_name}</p>
          )}
        </div>

        {/* Expiry */}
        {quoteData.expires_at && (
          <p className="text-center text-sm text-muted-foreground">
            Giltig till {new Date(quoteData.expires_at).toLocaleDateString('sv-SE')}
          </p>
        )}

        {/* Line items by section */}
        {hardwareItems.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <h3 className="font-semibold mb-3">Hårdvara</h3>
              <div className="space-y-2">
                {hardwareItems.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.description} {item.quantity > 1 && <span className="text-muted-foreground">× {item.quantity}</span>}</span>
                    <span className="font-medium">{formatSEK((item.unit_price_ex_vat || 0) * item.quantity)}</span>
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
                    <span>{item.description} {item.quantity > 1 && <span className="text-muted-foreground">× {item.quantity}</span>}</span>
                    <span className="font-medium">{formatSEK((item.unit_price_ex_vat || 0) * item.quantity)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {travelItems.length > 0 && (
          <Card>
            <CardContent className="pt-4">
              <h3 className="font-semibold mb-3">Resa &amp; övrigt</h3>
              <div className="space-y-2">
                {travelItems.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.description} {item.quantity > 1 && <span className="text-muted-foreground">× {item.quantity}</span>}</span>
                    <span className="font-medium">{formatSEK((item.unit_price_ex_vat || 0) * item.quantity)}</span>
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
              <span>{formatSEK(totals?.subtotal_ex_vat || 0)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Moms</span>
              <span>{formatSEK(totals?.vat_total || 0)}</span>
            </div>
            <div className="border-t border-border pt-2 flex justify-between">
              <span className="text-lg font-bold">Totalt inkl. moms</span>
              <span className="text-lg font-bold text-primary">{formatSEK(totals?.total_inc_vat || 0)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Action buttons */}
        {isActionable && (
          <div className="space-y-3">
            <Button className="w-full h-12 text-base" onClick={() => setShowAcceptModal(true)}>
              <Check className="h-5 w-5 mr-2" />
              Acceptera offert
            </Button>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" className="h-12" onClick={() => setShowDeclineModal(true)}>
                <X className="h-5 w-5 mr-2" />
                Avvisa
              </Button>
              <Button variant="outline" className="h-12" onClick={() => setShowRevisionModal(true)}>
                <MessageSquare className="h-5 w-5 mr-2" />
                Begär ändring
              </Button>
            </div>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-sm text-muted-foreground pt-4">
          Frågor? Kontakta oss på{' '}
          <a href="mailto:support@smarthomesolutions.se" className="text-primary hover:underline">
            support@smarthomesolutions.se
          </a>
        </p>
      </div>

      {/* Accept Modal */}
      <Dialog open={showAcceptModal} onOpenChange={setShowAcceptModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acceptera offert</DialogTitle>
            <DialogDescription>Fyll i dina uppgifter för att godkänna offerten.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="accept-name">Namn</Label>
              <Input id="accept-name" value={acceptName} onChange={e => setAcceptName(e.target.value)} placeholder="Ditt fullständiga namn" />
            </div>
            <div>
              <Label htmlFor="accept-email">E-post</Label>
              <Input id="accept-email" type="email" value={acceptEmail} onChange={e => setAcceptEmail(e.target.value)} placeholder="din@email.se" />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="accept-consent" checked={acceptConsent} onCheckedChange={(c) => setAcceptConsent(c === true)} />
              <Label htmlFor="accept-consent" className="text-sm leading-5">
                Jag godkänner offerten och förstår att en faktura kommer att skickas.
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAcceptModal(false)}>Avbryt</Button>
            <Button onClick={handleAccept} disabled={isAccepting || !acceptName || !acceptEmail || !acceptConsent}>
              {isAccepting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Godkänn
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline Modal */}
      <Dialog open={showDeclineModal} onOpenChange={setShowDeclineModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Avvisa offert</DialogTitle>
            <DialogDescription>Du kan ange en anledning (valfritt).</DialogDescription>
          </DialogHeader>
          <Textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)} placeholder="Anledning (valfritt)" rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeclineModal(false)}>Avbryt</Button>
            <Button variant="destructive" onClick={handleDecline} disabled={isDeclining}>
              {isDeclining && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Avvisa offert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revision Modal */}
      <Dialog open={showRevisionModal} onOpenChange={setShowRevisionModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Begär ändring</DialogTitle>
            <DialogDescription>Beskriv vad du vill ändra så återkommer vi.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="rev-name">Namn</Label>
              <Input id="rev-name" value={revisionName} onChange={e => setRevisionName(e.target.value)} placeholder="Ditt namn" />
            </div>
            <div>
              <Label htmlFor="rev-email">E-post</Label>
              <Input id="rev-email" type="email" value={revisionEmail} onChange={e => setRevisionEmail(e.target.value)} placeholder="din@email.se" />
            </div>
            <div>
              <Label htmlFor="rev-message">Meddelande</Label>
              <Textarea id="rev-message" value={revisionMessage} onChange={e => setRevisionMessage(e.target.value)} placeholder="Beskriv önskade ändringar..." rows={4} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRevisionModal(false)}>Avbryt</Button>
            <Button onClick={handleRevision} disabled={isRequesting || !revisionName || !revisionEmail || !revisionMessage}>
              {isRequesting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Skicka
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PublicQuotePage;
