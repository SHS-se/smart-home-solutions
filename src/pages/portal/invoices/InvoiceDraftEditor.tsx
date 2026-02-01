import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Send, Eye, Plus, Trash2, Loader2, Info, Link as LinkIcon } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface LineItem {
  id?: string;
  line_type: 'hardware' | 'labor' | 'travel_other';
  description: string;
  sku?: string;
  sku_id?: string;
  quantity: number;
  unit_price: number;
  unit?: string;
  tax_rate: number;
  category?: string;
  sort_order: number;
}

interface Invoice {
  id: string;
  invoice_number: string | null;
  stripe_invoice_id: string | null;
  customer_id: string | null;
  bom_id: string | null;
  quote_id: string | null;
  quote_number: string | null;
  status: string;
  is_test: boolean;
  due_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  customer?: { id: string; org_name: string | null; billing_email?: string | null } | null;
  bom?: { id: string; project_name: string; version: number } | null;
}

const InvoiceDraftEditor: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  
  const invoiceId = searchParams.get('id');
  const fromQuoteId = searchParams.get('fromQuote');
  const fromBomId = searchParams.get('fromBom');

  const [isCreating, setIsCreating] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedBomId, setSelectedBomId] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string>('');
  const [isTest, setIsTest] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  // Fetch existing invoice if editing
  const { data: existingInvoice, isLoading: invoiceLoading } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      const { data, error } = await supabase
        .from('invoices')
        .select('*, customer:customers(id, org_name, billing_email), bom:boms(id, project_name, version)')
        .eq('id', invoiceId)
        .single();
      if (error) throw error;
      return data as Invoice;
    },
    enabled: !!invoiceId && isStaff,
  });

  // Fetch line items for existing invoice
  const { data: existingLineItems } = useQuery({
    queryKey: ['invoice_line_items', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return [];
      const { data, error } = await supabase
        .from('invoice_line_items')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('sort_order');
      if (error) throw error;
      return data as LineItem[];
    },
    enabled: !!invoiceId && isStaff,
  });

  // Fetch customers for selection
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('id, org_name')
        .order('org_name');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Fetch BOMs for selection
  const { data: boms = [] } = useQuery({
    queryKey: ['boms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('id, project_name, version, customer_id')
        .order('project_name');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Initialize state from existing invoice
  useEffect(() => {
    if (existingInvoice) {
      setSelectedCustomerId(existingInvoice.customer_id);
      setSelectedBomId(existingInvoice.bom_id);
      setDueDate(existingInvoice.due_date || '');
      setIsTest(existingInvoice.is_test);
    }
  }, [existingInvoice]);

  useEffect(() => {
    if (existingLineItems) {
      setLineItems(existingLineItems);
    }
  }, [existingLineItems]);

  // Initialize from query params
  useEffect(() => {
    if (fromBomId && !invoiceId) {
      setSelectedBomId(fromBomId);
      const bom = boms.find(b => b.id === fromBomId);
      if (bom) {
        setSelectedCustomerId(bom.customer_id);
      }
    }
  }, [fromBomId, boms, invoiceId]);

  // Calculate totals
  const totals = useMemo(() => {
    const hardware = lineItems
      .filter(i => i.line_type === 'hardware')
      .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const labor = lineItems
      .filter(i => i.line_type === 'labor')
      .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const other = lineItems
      .filter(i => i.line_type === 'travel_other')
      .reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const subtotal = hardware + labor + other;
    const tax = subtotal * 0.25;
    return { hardware, labor, other, subtotal, tax, total: subtotal + tax };
  }, [lineItems]);

  // Create draft invoice
  const createDraftMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCustomerId) throw new Error('Customer is required');
      
      const { data, error } = await supabase.functions.invoke('create-draft-invoice', {
        body: {
          customer_id: selectedCustomerId,
          bom_id: selectedBomId,
          quote_id: fromQuoteId,
          due_date: dueDate || null,
          is_test: isTest,
          line_items: lineItems,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: t('Fakturautkast skapat', 'Invoice draft created') });
      navigate(`/portal/invoices/new?id=${data.invoice_id}`, { replace: true });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Kunde inte skapa faktura', 'Failed to create invoice'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Sync line items to Stripe
  const syncLinesMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error('No invoice ID');
      
      // First save line items locally
      await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId);
      if (lineItems.length > 0) {
        const { error } = await supabase.from('invoice_line_items').insert(
          lineItems.map((item, idx) => ({
            ...item,
            invoice_id: invoiceId,
            sort_order: idx,
          }))
        );
        if (error) throw error;
      }

      // Then sync to Stripe
      const { data, error } = await supabase.functions.invoke('sync-invoice-lines', {
        body: { invoice_id: invoiceId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: t('Rader synkroniserade', 'Lines synced') });
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Synkronisering misslyckades', 'Sync failed'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Finalize invoice
  const finalizeMutation = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error('No invoice ID');
      
      // First sync lines
      await syncLinesMutation.mutateAsync();

      // Then finalize
      const { data, error } = await supabase.functions.invoke('finalize-new-invoice', {
        body: { invoice_id: invoiceId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: t('Faktura fastställd!', 'Invoice finalized!') });
      navigate(`/portal/invoices/${data.invoice_number}`, { replace: true });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (error: Error) => {
      toast({ 
        title: t('Kunde inte fastställa faktura', 'Failed to finalize invoice'),
        description: error.message,
        variant: 'destructive'
      });
    },
  });

  // Add line item
  const addLineItem = (type: 'hardware' | 'labor' | 'travel_other') => {
    setLineItems(prev => [...prev, {
      line_type: type,
      description: '',
      quantity: 1,
      unit_price: 0,
      tax_rate: 25,
      sort_order: prev.length,
    }]);
  };

  // Update line item
  const updateLineItem = (index: number, updates: Partial<LineItem>) => {
    setLineItems(prev => prev.map((item, i) => i === index ? { ...item, ...updates } : item));
  };

  // Remove line item
  const removeLineItem = (index: number) => {
    setLineItems(prev => prev.filter((_, i) => i !== index));
  };

  const formatPrice = (value: number) => {
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' kr';
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  if (invoiceLoading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  const customer = existingInvoice?.customer || customers.find(c => c.id === selectedCustomerId);
  const bom = existingInvoice?.bom || boms.find(b => b.id === selectedBomId);

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Fakturaförberedelse', 'Invoice Preparation')}</h1>
          <p className="text-muted-foreground">
            {t('Organisera och granska faktura innan den fastställs och skickas till kund', 'Organize and review invoice before it is finalized and sent to customer')}
          </p>
          {customer && (
            <div className="flex flex-wrap gap-4 mt-2 text-sm">
              <span>
                <span className="text-muted-foreground">{t('Kund:', 'Customer:')}</span>{' '}
                <strong>{customer.org_name}</strong>
              </span>
              {bom && (
                <span>
                  <span className="text-muted-foreground">{t('Projekt:', 'Project:')}</span>{' '}
                  <strong>{bom.project_name}</strong>
                </span>
              )}
              {existingInvoice?.quote_number && (
                <span>
                  <span className="text-muted-foreground">{t('Från offert:', 'From quote:')}</span>{' '}
                  <a href={`/portal/quotes/${existingInvoice.quote_id}`} className="text-primary hover:underline">
                    #{existingInvoice.quote_number}
                  </a>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Main content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left side - Line items */}
          <div className="lg:col-span-2 space-y-6">
            {/* Customer/BOM selection (only if no invoice exists yet) */}
            {!invoiceId && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{t('Grunduppgifter', 'Basic information')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label>{t('Kund', 'Customer')} *</Label>
                    <Select value={selectedCustomerId || ''} onValueChange={setSelectedCustomerId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('Välj kund...', 'Select customer...')} />
                      </SelectTrigger>
                      <SelectContent>
                        {customers.map(c => (
                          <SelectItem key={c.id} value={c.id}>{c.org_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t('Materiallista (valfritt)', 'BOM (optional)')}</Label>
                    <Select value={selectedBomId || ''} onValueChange={setSelectedBomId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('Välj BOM...', 'Select BOM...')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">{t('Ingen', 'None')}</SelectItem>
                        {boms.filter(b => !selectedCustomerId || b.customer_id === selectedCustomerId).map(b => (
                          <SelectItem key={b.id} value={b.id}>{b.project_name} (v{b.version})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Hardware section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">
                  {t('Hårdvara', 'Hardware')}
                  {bom && <span className="text-muted-foreground font-normal text-sm ml-2">(från BOM #{bom.version})</span>}
                </CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => addLineItem('hardware')}>
                    <Plus className="h-4 w-4 mr-1" />
                    {t('Lägg till rad', 'Add row')}
                  </Button>
                  {bom && (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`/portal/boms/${bom.id}`} target="_blank">
                        <LinkIcon className="h-4 w-4 mr-1" />
                        {t('Visa hela BOM', 'View full BOM')}
                      </a>
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase">{t('PRODUKT', 'PRODUCT')}</TableHead>
                      <TableHead className="text-xs uppercase">{t('SKU', 'SKU')}</TableHead>
                      <TableHead className="text-xs uppercase w-24">{t('ANTAL', 'QTY')}</TableHead>
                      <TableHead className="text-xs uppercase w-28">{t('Å-PRIS', 'UNIT')}</TableHead>
                      <TableHead className="text-xs uppercase text-right">{t('SUMMA', 'TOTAL')}</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lineItems.filter(i => i.line_type === 'hardware').length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-4">
                          {t('Inga hårdvaruartiklar', 'No hardware items')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      lineItems.map((item, idx) => item.line_type === 'hardware' && (
                        <TableRow key={idx}>
                          <TableCell>
                            <Input 
                              value={item.description}
                              onChange={(e) => updateLineItem(idx, { description: e.target.value })}
                              placeholder={t('Produktnamn', 'Product name')}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground font-mono">{item.sku || '—'}</span>
                          </TableCell>
                          <TableCell>
                            <Input 
                              type="number"
                              value={item.quantity}
                              onChange={(e) => updateLineItem(idx, { quantity: parseFloat(e.target.value) || 0 })}
                              className="w-20"
                            />
                          </TableCell>
                          <TableCell>
                            <Input 
                              type="number"
                              value={item.unit_price}
                              onChange={(e) => updateLineItem(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                              className="w-24"
                            />
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatPrice(item.quantity * item.unit_price)}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon" onClick={() => removeLineItem(idx)}>
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <div className="flex justify-end mt-4 text-sm">
                  <span className="text-muted-foreground mr-4">{t('Hårdvara delsumma:', 'Hardware subtotal:')}</span>
                  <span className="font-semibold">{formatPrice(totals.hardware)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Labor section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">{t('Arbete', 'Labor')}</CardTitle>
                <Button variant="outline" size="sm" onClick={() => addLineItem('labor')}>
                  <Plus className="h-4 w-4 mr-1" />
                  {t('Lägg till rad', 'Add row')}
                </Button>
              </CardHeader>
              <CardContent>
                {lineItems.filter(i => i.line_type === 'labor').length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">{t('Inga arbetstimmar', 'No labor items')}</p>
                ) : (
                  <div className="space-y-2">
                    {lineItems.map((item, idx) => item.line_type === 'labor' && (
                      <div key={idx} className="flex items-center gap-3">
                        <Input 
                          className="flex-1"
                          value={item.description}
                          onChange={(e) => updateLineItem(idx, { description: e.target.value })}
                          placeholder={t('Beskrivning', 'Description')}
                        />
                        <Input 
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(idx, { quantity: parseFloat(e.target.value) || 0 })}
                          className="w-20"
                        />
                        <span className="text-muted-foreground text-sm">{t('tim ×', 'hrs ×')}</span>
                        <Input 
                          type="number"
                          value={item.unit_price}
                          onChange={(e) => updateLineItem(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                          className="w-24"
                        />
                        <span className="text-muted-foreground text-sm">kr</span>
                        <span className="font-medium w-24 text-right">{formatPrice(item.quantity * item.unit_price)}</span>
                        <Button variant="ghost" size="icon" onClick={() => removeLineItem(idx)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Travel/Other section */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">{t('Resa / Övrigt', 'Travel / Other')}</CardTitle>
                <Button variant="outline" size="sm" onClick={() => addLineItem('travel_other')}>
                  <Plus className="h-4 w-4 mr-1" />
                  {t('Lägg till rad', 'Add row')}
                </Button>
              </CardHeader>
              <CardContent>
                {lineItems.filter(i => i.line_type === 'travel_other').length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">{t('Inga övriga kostnader', 'No other costs')}</p>
                ) : (
                  <div className="space-y-2">
                    {lineItems.map((item, idx) => item.line_type === 'travel_other' && (
                      <div key={idx} className="flex items-center gap-3">
                        <Input 
                          className="flex-1"
                          value={item.description}
                          onChange={(e) => updateLineItem(idx, { description: e.target.value })}
                          placeholder={t('Beskrivning', 'Description')}
                        />
                        <Input 
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(idx, { quantity: parseFloat(e.target.value) || 0 })}
                          className="w-20"
                        />
                        <span className="text-muted-foreground text-sm">×</span>
                        <Input 
                          type="number"
                          value={item.unit_price}
                          onChange={(e) => updateLineItem(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                          className="w-24"
                        />
                        <span className="text-muted-foreground text-sm">kr</span>
                        <span className="font-medium w-24 text-right">{formatPrice(item.quantity * item.unit_price)}</span>
                        <Button variant="ghost" size="icon" onClick={() => removeLineItem(idx)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right side - Summary and actions */}
          <div className="space-y-6">
            {/* Summary card */}
            <Card>
              <CardHeader>
                <CardTitle>{t('Sammanfattning', 'Summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Hårdvara:', 'Hardware:')}</span>
                  <span>{formatPrice(totals.hardware)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Arbete:', 'Labor:')}</span>
                  <span>{formatPrice(totals.labor)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('Övrigt:', 'Other:')}</span>
                  <span>{formatPrice(totals.other)}</span>
                </div>
                <div className="border-t pt-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Delsumma:', 'Subtotal:')}</span>
                    <span>{formatPrice(totals.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('Moms (25%):', 'VAT (25%):')}</span>
                    <span>{formatPrice(totals.tax)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold mt-2">
                    <span>{t('Totalt:', 'Total:')}</span>
                    <span className="text-primary">{formatPrice(totals.total)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Invoice settings card */}
            <Card>
              <CardHeader>
                <CardTitle>{t('Fakturering', 'Invoicing')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <span className="text-sm text-muted-foreground">{t('Status', 'Status')}</span>
                  <div className="mt-1">
                    <Badge variant="outline">{t('Utkast', 'Draft')}</Badge>
                  </div>
                </div>
                
                <div>
                  <span className="text-sm text-muted-foreground">{t('Fakturanummer', 'Invoice number')}</span>
                  <p className="font-mono">—</p>
                  <p className="text-xs text-muted-foreground">{t('Tilldelas när fakturan fastställs', 'Assigned when invoice is finalized')}</p>
                </div>

                <div>
                  <Label htmlFor="due_date">{t('Förfallodatum', 'Due date')}</Label>
                  <Input 
                    id="due_date"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="is_test">{t('Testfaktura', 'Test invoice')}</Label>
                    <p className="text-xs text-muted-foreground">{t('Används för test och demo', 'Used for test and demo')}</p>
                  </div>
                  <Switch 
                    id="is_test"
                    checked={isTest}
                    onCheckedChange={setIsTest}
                  />
                </div>

                {/* Actions */}
                <div className="pt-4 space-y-2">
                  {!invoiceId ? (
                    <Button 
                      className="w-full"
                      onClick={() => createDraftMutation.mutate()}
                      disabled={!selectedCustomerId || createDraftMutation.isPending}
                    >
                      {createDraftMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {t('Skapa utkast', 'Create draft')}
                    </Button>
                  ) : (
                    <>
                      <Button 
                        className="w-full"
                        onClick={() => finalizeMutation.mutate()}
                        disabled={finalizeMutation.isPending || lineItems.length === 0}
                      >
                        {finalizeMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        <Send className="h-4 w-4 mr-2" />
                        {t('Fastställ faktura', 'Finalize invoice')}
                      </Button>
                      <Button 
                        variant="outline" 
                        className="w-full"
                        disabled={true}
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        {t('Förhandsgranska PDF', 'Preview PDF')}
                      </Button>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Info className="h-3 w-3" />
                        {t('PDF tillgänglig efter fastställd', 'PDF available after finalization')}
                      </p>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </PortalLayout>
  );
};

export default InvoiceDraftEditor;
