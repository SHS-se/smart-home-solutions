import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import { fuzzyMatchSupplier, generateDescription, type ParsedInvoice } from '@/lib/invoice-parser';

interface Props {
  file: File | null;
  parsedInvoice: ParsedInvoice | null;
  extractedText: string | null;
}

const PurchaseUploadForm: React.FC<Props> = ({ file, parsedInvoice, extractedText }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const appliedRef = useRef<ParsedInvoice | null>(null);

  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    supplierId: '',
    newSupplierName: '',
    invoiceNumber: '',
    documentType: 'supplier_invoice',
    documentDate: '',
    dueDate: '',
    currency: 'SEK',
    grossAmount: '',
    vatAmount: '',
    netAmount: '',
    paymentSource: '',
    description: '',
  });

  const { data: suppliers } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_suppliers').select('*').order('name');
      return data || [];
    },
  });

  // Apply parsed invoice data (once per parse result)
  useEffect(() => {
    if (!parsedInvoice || parsedInvoice === appliedRef.current) return;
    appliedRef.current = parsedInvoice;

    const f = { ...form };
    const filled = new Set<string>();

    // Supplier matching
    if (parsedInvoice.supplierName) {
      if (suppliers?.length) {
        const match = fuzzyMatchSupplier(parsedInvoice.supplierName, suppliers);
        if (match && match.score > 0.7) {
          f.supplierId = match.id;
          filled.add('supplierId');
        } else {
          f.newSupplierName = parsedInvoice.supplierName;
          filled.add('newSupplierName');
        }
      } else {
        f.newSupplierName = parsedInvoice.supplierName;
        filled.add('newSupplierName');
      }
    }

    if (parsedInvoice.invoiceNumber) { f.invoiceNumber = parsedInvoice.invoiceNumber; filled.add('invoiceNumber'); }
    if (parsedInvoice.invoiceDate) { f.documentDate = parsedInvoice.invoiceDate; filled.add('documentDate'); }
    if (parsedInvoice.dueDate) { f.dueDate = parsedInvoice.dueDate; filled.add('dueDate'); }
    if (parsedInvoice.currency) { f.currency = parsedInvoice.currency; filled.add('currency'); }
    if (parsedInvoice.grossAmount != null) { f.grossAmount = String(parsedInvoice.grossAmount); filled.add('grossAmount'); }
    if (parsedInvoice.vatAmount != null) { f.vatAmount = String(parsedInvoice.vatAmount); filled.add('vatAmount'); }
    if (parsedInvoice.netAmount != null) { f.netAmount = String(parsedInvoice.netAmount); filled.add('netAmount'); }

    const desc = parsedInvoice.description || generateDescription(parsedInvoice.supplierName, extractedText || '');
    if (desc) { f.description = desc; filled.add('description'); }

    setForm(f);
    setAutoFilled(filled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedInvoice]);

  const updateField = (field: string, value: string) => {
    setForm(f => ({ ...f, [field]: value }));
    setAutoFilled(af => { const n = new Set(af); n.delete(field); return n; });
  };

  const saveDraft = useMutation({
    mutationFn: async () => {
      let supplierId = form.supplierId || null;
      if (!supplierId && form.newSupplierName.trim()) {
        const { data: ns, error } = await supabase.from('acc_suppliers').insert({ name: form.newSupplierName.trim() }).select().single();
        if (error) throw error;
        supplierId = ns.id;
      }

      let filePath: string | null = null;
      if (file) {
        const ext = file.name.split('.').pop();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error } = await supabase.storage.from('purchase-documents').upload(path, file);
        if (error) throw error;
        filePath = path;
      }

      const { data: purchase, error } = await supabase
        .from('acc_purchases')
        .insert({
          supplier_id: supplierId,
          document_type: form.documentType,
          document_file_path: filePath,
          document_date: form.documentDate || new Date().toISOString().split('T')[0],
          due_date: form.dueDate || null,
          currency: form.currency || 'SEK',
          gross_amount: Number(form.grossAmount) || 0,
          net_amount: Number(form.netAmount) || 0,
          vat_amount: Number(form.vatAmount) || 0,
          description: form.description,
          payment_source: form.paymentSource || 'owner_paid',
          notes: form.invoiceNumber ? `Leverantörens fakturanr: ${form.invoiceNumber}` : null,
          status: 'draft',
          created_by: user?.id,
        })
        .select()
        .single();
      if (error) throw error;

      await supabase.from('acc_purchase_lines').insert({
        purchase_id: purchase.id,
        description: form.description || 'Hela beloppet',
        net_amount: Number(form.netAmount) || 0,
        vat_amount: Number(form.vatAmount) || 0,
        gross_amount: Number(form.grossAmount) || 0,
        expense_account: '4000',
        vat_treatment: 'needs_review',
        sort_order: 0,
      });

      return purchase;
    },
    onSuccess: (purchase) => {
      queryClient.invalidateQueries({ queryKey: ['acc-purchases'] });
      toast.success('Inköp sparat som utkast');
      navigate(`/accounting/purchases/${purchase.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const AutoLabel = ({ text, field }: { text: string; field: string }) => (
    <div className="flex items-center gap-1.5">
      <Label className="text-xs text-muted-foreground">{text}</Label>
      {autoFilled.has(field) && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">
              Automatiskt tolkad – kontrollera
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );

  return (
    <Card className="border border-border h-full overflow-auto">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Dokumentdetaljer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Supplier */}
        <div className="space-y-1.5">
          <AutoLabel text="Leverantör" field="supplierId" />
          <Select value={form.supplierId} onValueChange={(v) => { setForm(f => ({ ...f, supplierId: v, newSupplierName: '' })); setAutoFilled(af => { const n = new Set(af); n.delete('supplierId'); return n; }); }}>
            <SelectTrigger><SelectValue placeholder="Välj leverantör..." /></SelectTrigger>
            <SelectContent>
              {suppliers?.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {!form.supplierId && (
            <div>
              <AutoLabel text="" field="newSupplierName" />
              <Input placeholder="Eller skapa ny leverantör..." value={form.newSupplierName} onChange={(e) => updateField('newSupplierName', e.target.value)} className="text-sm" />
            </div>
          )}
        </div>

        {/* Invoice number */}
        <div className="space-y-1.5">
          <AutoLabel text="Fakturanummer" field="invoiceNumber" />
          <Input value={form.invoiceNumber} onChange={(e) => updateField('invoiceNumber', e.target.value)} placeholder="Leverantörens ref..." />
        </div>

        {/* Document type */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Dokumenttyp</Label>
          <Select value={form.documentType} onValueChange={(v) => updateField('documentType', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="supplier_invoice">Leverantörsfaktura</SelectItem>
              <SelectItem value="receipt">Kvitto</SelectItem>
              <SelectItem value="other">Annat</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <AutoLabel text="Fakturadatum" field="documentDate" />
            <Input type="date" value={form.documentDate} onChange={(e) => updateField('documentDate', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <AutoLabel text="Förfallodatum" field="dueDate" />
            <Input type="date" value={form.dueDate} onChange={(e) => updateField('dueDate', e.target.value)} />
          </div>
        </div>

        <div className="space-y-1.5">
          <AutoLabel text="Valuta" field="currency" />
          <Input
            value={form.currency}
            onChange={(e) => updateField('currency', e.target.value.toUpperCase())}
            placeholder="SEK"
            maxLength={3}
          />
        </div>

        {/* Amounts */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <AutoLabel text="Brutto" field="grossAmount" />
            <Input type="number" step="0.01" value={form.grossAmount} onChange={(e) => updateField('grossAmount', e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <AutoLabel text="Moms" field="vatAmount" />
            <Input type="number" step="0.01" value={form.vatAmount} onChange={(e) => updateField('vatAmount', e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <AutoLabel text="Netto" field="netAmount" />
            <Input type="number" step="0.01" value={form.netAmount} onChange={(e) => updateField('netAmount', e.target.value)} placeholder="0" />
          </div>
        </div>

        {/* Payment source – no default */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Betalkälla</Label>
          <Select value={form.paymentSource} onValueChange={(v) => updateField('paymentSource', v)}>
            <SelectTrigger><SelectValue placeholder="Välj betalkälla..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="owner_paid">Ägarens egna medel</SelectItem>
              <SelectItem value="company_bank">Företagskonto</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <AutoLabel text="Beskrivning" field="description" />
          <Textarea value={form.description} onChange={(e) => updateField('description', e.target.value)} placeholder="Vad är köpt..." rows={2} />
        </div>

        <Button onClick={() => saveDraft.mutate()} disabled={saveDraft.isPending} className="w-full gap-2">
          <Save className="h-4 w-4" />
          {saveDraft.isPending ? 'Sparar...' : 'Spara utkast'}
        </Button>
      </CardContent>
    </Card>
  );
};

export default PurchaseUploadForm;
