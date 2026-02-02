import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ExternalLink, FileText, Mail, XCircle, CheckCircle2, Loader2, Clock, AlertCircle } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import InvoiceEmailModal from '@/components/portal/invoices/InvoiceEmailModal';

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  customer_id: string | null;
  bom_id: string | null;
  quote_id: string | null;
  quote_number: string | null;
  bom_version: number | null;
  status: string;
  is_test: boolean;
  due_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  finalized_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  created_at: string;
  customer?: { id: string; org_name: string | null; billing_email?: string | null } | null;
  bom?: { id: string; project_name: string } | null;
}

interface LineItem {
  id: string;
  line_type: string;
  description: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
  unit: string | null;
  category: string | null;
}

interface InvoiceEvent {
  id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const getStatusBadge = (status: string, dueDate: string | null, t: (sv: string, en: string) => string) => {
  // Check for overdue
  if (status === 'open' && dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (due < today) {
      return <Badge variant="destructive">{t('Förfallen', 'Overdue')}</Badge>;
    }
  }
  
  switch (status) {
    case 'draft':
      return <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>;
    case 'open':
      return <Badge variant="secondary">{t('Öppen', 'Open')}</Badge>;
    case 'paid':
      return <Badge className="bg-green-600 text-white">{t('Betald', 'Paid')}</Badge>;
    case 'overdue':
      return <Badge variant="destructive">{t('Förfallen', 'Overdue')}</Badge>;
    case 'void':
      return <Badge variant="outline" className="text-muted-foreground">{t('Makulerad', 'Voided')}</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
};

const getEventIcon = (eventType: string) => {
  switch (eventType) {
    case 'invoice_finalized':
      return <CheckCircle2 className="h-4 w-4 text-yellow-500" />;
    case 'invoice_paid':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'invoice_voided':
      return <XCircle className="h-4 w-4 text-destructive" />;
    case 'email_sent':
      return <Mail className="h-4 w-4 text-primary" />;
    case 'invoice_created':
      return <FileText className="h-4 w-4 text-primary" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
};

const getEventLabel = (eventType: string, t: (sv: string, en: string) => string) => {
  switch (eventType) {
    case 'invoice_created':
      return t('Faktura skapad', 'Invoice created');
    case 'invoice_updated':
      return t('Faktura uppdaterad', 'Invoice updated');
    case 'invoice_finalized':
      return t('Faktura fastställd', 'Invoice finalized');
    case 'invoice_paid':
      return t('Faktura betald', 'Invoice paid');
    case 'invoice_voided':
      return t('Faktura makulerad', 'Invoice voided');
    case 'email_sent':
      return t('E-post skickad', 'Email sent');
    default:
      return eventType;
  }
};

const InvoiceDetail: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();

  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);

  // Fetch invoice by invoice_number or id
  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice-detail', id],
    queryFn: async () => {
      // Try finding by invoice_number first
      let { data, error } = await supabase
        .from('invoices')
        .select('*, customer:customers(id, org_name, billing_email), bom:boms(id, project_name)')
        .eq('invoice_number', id!)
        .maybeSingle();

      // If not found, try by id
      if (!data) {
        const result = await supabase
          .from('invoices')
          .select('*, customer:customers(id, org_name, billing_email), bom:boms(id, project_name)')
          .eq('id', id!)
          .maybeSingle();
        data = result.data;
        error = result.error;
      }

      if (error) throw error;
      if (!data) throw new Error('Invoice not found');
      return data as Invoice;
    },
    enabled: !!id && isStaff,
  });

  // Fetch line items
  const { data: lineItems = [] } = useQuery({
    queryKey: ['invoice_line_items', invoice?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('invoice_line_items')
        .select('*')
        .eq('invoice_id', invoice!.id)
        .order('sort_order');
      if (error) throw error;
      return data as LineItem[];
    },
    enabled: !!invoice?.id,
  });

  // Fetch events
  const { data: events = [] } = useQuery({
    queryKey: ['invoice_events', invoice?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('invoice_events')
        .select('*')
        .eq('invoice_id', invoice!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as InvoiceEvent[];
    },
    enabled: !!invoice?.id,
  });

  // Void mutation
  const voidMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('void-new-invoice', {
        body: { invoice_id: invoice!.id },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: t('Faktura makulerad', 'Invoice voided') });
      queryClient.invalidateQueries({ queryKey: ['invoice-detail', id] });
      queryClient.invalidateQueries({ queryKey: ['invoice_events', invoice?.id] });
      setShowVoidDialog(false);
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Kunde inte makulera', 'Failed to void'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  if (isLoading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (!invoice) {
    return (
      <PortalLayout>
        <div className="text-center py-12">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold">{t('Faktura hittades inte', 'Invoice not found')}</h2>
          <Button variant="link" onClick={() => navigate('/portal/invoices')}>
            {t('Tillbaka till fakturor', 'Back to invoices')}
          </Button>
        </div>
      </PortalLayout>
    );
  }

  const hardwareItems = lineItems.filter(i => i.line_type === 'hardware');
  const laborItems = lineItems.filter(i => i.line_type === 'labor');
  const otherItems = lineItems.filter(i => i.line_type === 'travel_other');

  const isPaid = invoice.status === 'paid';
  const isVoid = invoice.status === 'void';
  const canVoid = !isPaid && !isVoid;

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Faktura', 'Invoice')} {invoice.invoice_number}
          </h1>
          <p className="text-muted-foreground">
            {t('Fastställd faktura', 'Finalized invoice')}
          </p>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm">
            <span>
              <span className="text-muted-foreground">{t('Kund:', 'Customer:')}</span>{' '}
              <strong>{invoice.customer?.org_name}</strong>
            </span>
            {getStatusBadge(invoice.status, invoice.due_date, t)}
            {invoice.is_test && (
              <Badge variant="outline">Test</Badge>
            )}
            {invoice.bom && (
              <span>
                <span className="text-muted-foreground">{t('Projekt:', 'Project:')}</span>{' '}
                <strong>{invoice.bom.project_name}</strong>
              </span>
            )}
            {invoice.quote_number && (
              <span>
                <span className="text-muted-foreground">{t('Från offert:', 'From quote:')}</span>{' '}
                <a href={`/portal/quotes/${invoice.quote_id}`} className="text-primary hover:underline">
                  #{invoice.quote_number}
                </a>
              </span>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left side - Line items */}
          <div className="lg:col-span-2 space-y-6">
            {/* Hardware */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">
                  {t('Hårdvara', 'Hardware')}
                  {invoice.bom && <span className="text-muted-foreground font-normal text-sm ml-2">(från BOM #{invoice.bom_version})</span>}
                </CardTitle>
                {invoice.bom && (
                  <Button variant="ghost" size="sm" asChild>
                    <a href={`/portal/boms/${invoice.bom.id}`} target="_blank">
                      <ExternalLink className="h-4 w-4 mr-1" />
                      {t('Visa hela BOM', 'View full BOM')}
                    </a>
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase">{t('PRODUKT', 'PRODUCT')}</TableHead>
                      <TableHead className="text-xs uppercase">{t('SKU', 'SKU')}</TableHead>
                      <TableHead className="text-xs uppercase text-center">{t('ANTAL', 'QTY')}</TableHead>
                      <TableHead className="text-xs uppercase text-right">{t('Å-PRIS', 'UNIT')}</TableHead>
                      <TableHead className="text-xs uppercase text-right">{t('SUMMA', 'TOTAL')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hardwareItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-4">
                          {t('Inga hårdvaruartiklar', 'No hardware items')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      hardwareItems.map(item => (
                        <TableRow key={item.id}>
                          <TableCell>{item.description}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{item.sku || '—'}</TableCell>
                          <TableCell className="text-center">{item.quantity}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{formatPrice(item.unit_price)}</TableCell>
                          <TableCell className="text-right font-medium">{formatPrice(item.quantity * item.unit_price)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <div className="flex justify-end mt-4 text-sm">
                  <span className="text-muted-foreground mr-4">{t('Hårdvara delsumma:', 'Hardware subtotal:')}</span>
                  <span className="font-semibold">
                    {formatPrice(hardwareItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0))}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Labor */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t('Arbete', 'Labor')}</CardTitle>
              </CardHeader>
              <CardContent>
                {laborItems.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">{t('Inga arbetstimmar', 'No labor items')}</p>
                ) : (
                  <div className="space-y-2">
                    {laborItems.map(item => (
                      <div key={item.id} className="flex justify-between items-center py-2">
                        <div>
                          <p className="font-medium">{item.description}</p>
                          <p className="text-sm text-muted-foreground">
                            {item.quantity} {item.unit || t('timmar', 'hours')} × {formatPrice(item.unit_price)}
                          </p>
                        </div>
                        <span className="font-medium">{formatPrice(item.quantity * item.unit_price)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Other */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t('Resa / Övrigt', 'Travel / Other')}</CardTitle>
              </CardHeader>
              <CardContent>
                {otherItems.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">{t('Inga övriga kostnader', 'No other costs')}</p>
                ) : (
                  <div className="space-y-2">
                    {otherItems.map(item => (
                      <div key={item.id} className="flex justify-between items-center py-2">
                        <div>
                          <p className="font-medium">{item.description}</p>
                          <p className="text-sm text-muted-foreground">
                            {item.quantity} × {formatPrice(item.unit_price)}
                          </p>
                        </div>
                        <span className="font-medium">{formatPrice(item.quantity * item.unit_price)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right side - Summary, actions, events */}
          <div className="space-y-6">
            {/* Summary */}
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Hårdvara:', 'Hardware:')}</span>
                  <span>{formatPrice(hardwareItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0))}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Arbete:', 'Labor:')}</span>
                  <span>{formatPrice(laborItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0))}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Övrigt:', 'Other:')}</span>
                  <span>{formatPrice(otherItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0))}</span>
                </div>
                <div className="border-t pt-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Delsumma:', 'Subtotal:')}</span>
                    <span>{formatPrice(invoice.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Moms (25%):', 'VAT (25%):')}</span>
                    <span>{formatPrice(invoice.tax)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold mt-2">
                    <span>{t('Totalt:', 'Total:')}</span>
                    <span className="text-primary">{formatPrice(invoice.total)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            <Card>
              <CardHeader>
                <CardTitle>{t('Fakturering', 'Invoicing')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="text-sm text-muted-foreground">{t('Fakturanummer', 'Invoice number')}</span>
                  <p className="font-mono font-medium">{invoice.invoice_number}</p>
                </div>

                <div>
                  <span className="text-sm text-muted-foreground">{t('Förfallodatum', 'Due date')}</span>
                  <p>{invoice.due_date ? format(new Date(invoice.due_date), 'yyyy-MM-dd') : '—'}</p>
                </div>

                {/* Paid indicator */}
                {isPaid && (
                  <div className="flex items-center gap-2 text-green-600 bg-green-50 dark:bg-green-950/30 rounded-md p-3">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">{t('Fakturan är betald', 'Invoice is paid')}</span>
                  </div>
                )}

                {/* Void indicator */}
                {isVoid && (
                  <div className="flex items-center gap-2 text-destructive bg-destructive/10 rounded-md p-3">
                    <XCircle className="h-5 w-5" />
                    <span className="font-medium">{t('Fakturan är makulerad', 'Invoice is voided')}</span>
                  </div>
                )}

                {/* Action buttons */}
                <div className="space-y-2 pt-2">
                  {invoice.hosted_invoice_url && !isVoid && (
                    <Button variant="outline" className="w-full" asChild>
                      <a href={invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-2" />
                        {t('Öppna betalning', 'Open payment')}
                      </a>
                    </Button>
                  )}

                  {invoice.invoice_pdf_url && (
                    <Button variant="outline" className="w-full" asChild>
                      <a href={invoice.invoice_pdf_url} target="_blank" rel="noopener noreferrer">
                        <FileText className="h-4 w-4 mr-2" />
                        {t('Visa PDF', 'View PDF')}
                      </a>
                    </Button>
                  )}

                  {!isVoid && !isPaid && (
                    <Button className="w-full" onClick={() => setShowEmailModal(true)}>
                      <Mail className="h-4 w-4 mr-2" />
                      {t('Skicka faktura', 'Send invoice')}
                    </Button>
                  )}

                  {canVoid && (
                    <Button 
                      variant="outline" 
                      className="w-full text-destructive hover:text-destructive"
                      onClick={() => setShowVoidDialog(true)}
                    >
                      <XCircle className="h-4 w-4 mr-2" />
                      {t('Makulera faktura', 'Void invoice')}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Event log */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  {t('Händelselogg', 'Event log')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {events.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">
                    {t('Inga händelser', 'No events')}
                  </p>
                ) : (
                  <div className="space-y-4">
                    {events.map((event, idx) => (
                      <div key={event.id} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          {getEventIcon(event.event_type)}
                          {idx < events.length - 1 && (
                            <div className="w-px h-full bg-border mt-1" />
                          )}
                        </div>
                        <div className="flex-1 pb-4">
                          <p className="font-medium text-sm">{getEventLabel(event.event_type, t)}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(event.created_at), 'd MMM HH:mm', { locale: sv })}
                            {event.metadata?.invoice_number && (
                              <span className="ml-2 font-mono">#{event.metadata.invoice_number as string}</span>
                            )}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Void dialog */}
      <AlertDialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Makulera faktura?', 'Void invoice?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta makulerar fakturan i Stripe. Kunden kan inte längre betala via länken.',
                'This will void the invoice in Stripe. The customer can no longer pay using the link.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => voidMutation.mutate()}
              disabled={voidMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {voidMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Makulera', 'Void')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Email modal */}
      {invoice && (
        <InvoiceEmailModal
          open={showEmailModal}
          onOpenChange={setShowEmailModal}
          invoice={invoice}
        />
      )}
    </PortalLayout>
  );
};

export default InvoiceDetail;
