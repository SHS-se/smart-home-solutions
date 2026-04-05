import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PAYMENT_SOURCE_LABELS } from '@/lib/accounting-utils';
import { toast } from 'sonner';
import { Upload, FileText, Plus } from 'lucide-react';
import type { PaymentSource } from '@/lib/accounting-utils';

const PurchaseUpload: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({
    supplierId: '',
    newSupplierName: '',
    documentType: 'supplier_invoice' as string,
    documentDate: new Date().toISOString().split('T')[0],
    grossAmount: '',
    netAmount: '',
    vatAmount: '',
    description: '',
    paymentSource: 'owner_paid' as PaymentSource,
  });

  const { data: suppliers } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_suppliers').select('*').order('name');
      return data || [];
    },
  });

  const handleAmountChange = (field: 'grossAmount' | 'netAmount' | 'vatAmount', value: string) => {
    const updated = { ...form, [field]: value };
    if (field === 'grossAmount' && updated.vatAmount) {
      updated.netAmount = String(Math.round((Number(value) - Number(updated.vatAmount)) * 100) / 100);
    } else if (field === 'grossAmount' && !updated.vatAmount) {
      const gross = Number(value);
      updated.vatAmount = String(Math.round(gross * 0.2 * 100) / 100);
      updated.netAmount = String(Math.round(gross * 0.8 * 100) / 100);
    }
    setForm(updated);
  };

  const saveDraft = useMutation({
    mutationFn: async () => {
      setUploading(true);

      let supplierId = form.supplierId || null;

      // Create new supplier if needed
      if (!supplierId && form.newSupplierName.trim()) {
        const { data: newSupplier, error: supplierError } = await supabase
          .from('acc_suppliers')
          .insert({ name: form.newSupplierName.trim() })
          .select()
          .single();
        if (supplierError) throw supplierError;
        supplierId = newSupplier.id;
      }

      // Upload file if present
      let filePath: string | null = null;
      if (file) {
        const ext = file.name.split('.').pop();
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('purchase-documents')
          .upload(path, file);
        if (uploadError) throw uploadError;
        filePath = path;
      }

      const { data: purchase, error } = await supabase
        .from('acc_purchases')
        .insert({
          supplier_id: supplierId,
          document_type: form.documentType,
          document_file_path: filePath,
          document_date: form.documentDate,
          gross_amount: Number(form.grossAmount) || 0,
          net_amount: Number(form.netAmount) || 0,
          vat_amount: Number(form.vatAmount) || 0,
          description: form.description,
          payment_source: form.paymentSource,
          status: 'draft',
          created_by: user?.id,
        })
        .select()
        .single();

      if (error) throw error;

      // Create a default line
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
    onError: (e: Error) => {
      toast.error(e.message);
      setUploading(false);
    },
  });

  return (
    <AccountingLayout>
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ladda upp inköp</h1>
          <p className="text-muted-foreground mt-1">Registrera leverantörsfaktura eller kvitto</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Upload area */}
          <Card className="border border-border">
            <CardHeader>
              <CardTitle className="text-base">Underlag</CardTitle>
            </CardHeader>
            <CardContent>
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-10 cursor-pointer hover:border-primary/40 hover:bg-muted/30 transition-colors">
                {file ? (
                  <div className="text-center">
                    <FileText className="w-10 h-10 text-primary mx-auto mb-3" />
                    <p className="text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{(file.size / 1024).toFixed(0)} KB</p>
                    <Button variant="ghost" size="sm" className="mt-2" onClick={(e) => { e.preventDefault(); setFile(null); }}>
                      Byt fil
                    </Button>
                  </div>
                ) : (
                  <div className="text-center">
                    <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium">Klicka för att ladda upp</p>
                    <p className="text-xs text-muted-foreground mt-1">PDF, bild eller foto</p>
                  </div>
                )}
                <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
            </CardContent>
          </Card>

          {/* Metadata form */}
          <Card className="border border-border">
            <CardHeader>
              <CardTitle className="text-base">Dokumentdetaljer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Supplier */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Leverantör</Label>
                <Select value={form.supplierId} onValueChange={(v) => setForm({ ...form, supplierId: v, newSupplierName: '' })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Välj leverantör..." />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers?.map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!form.supplierId && (
                  <div className="flex gap-2 items-center">
                    <Input
                      placeholder="Eller skapa ny leverantör..."
                      value={form.newSupplierName}
                      onChange={(e) => setForm({ ...form, newSupplierName: e.target.value })}
                      className="text-sm"
                    />
                  </div>
                )}
              </div>

              {/* Document type */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Dokumenttyp</Label>
                <Select value={form.documentType} onValueChange={(v) => setForm({ ...form, documentType: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="supplier_invoice">Leverantörsfaktura</SelectItem>
                    <SelectItem value="receipt">Kvitto</SelectItem>
                    <SelectItem value="other">Annat</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Date */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Fakturadatum</Label>
                <Input type="date" value={form.documentDate} onChange={(e) => setForm({ ...form, documentDate: e.target.value })} />
              </div>

              {/* Amounts */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Brutto</Label>
                  <Input type="number" step="0.01" value={form.grossAmount} onChange={(e) => handleAmountChange('grossAmount', e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Moms</Label>
                  <Input type="number" step="0.01" value={form.vatAmount} onChange={(e) => setForm({ ...form, vatAmount: e.target.value })} placeholder="0" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Netto</Label>
                  <Input type="number" step="0.01" value={form.netAmount} onChange={(e) => setForm({ ...form, netAmount: e.target.value })} placeholder="0" />
                </div>
              </div>

              {/* Payment source */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Betalkälla</Label>
                <Select value={form.paymentSource} onValueChange={(v) => setForm({ ...form, paymentSource: v as PaymentSource })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="owner_paid">{PAYMENT_SOURCE_LABELS.owner_paid}</SelectItem>
                    <SelectItem value="company_bank">{PAYMENT_SOURCE_LABELS.company_bank}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Beskrivning</Label>
                <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Vad är köpt..." rows={2} />
              </div>

              <Button onClick={() => saveDraft.mutate()} disabled={uploading || saveDraft.isPending} className="w-full">
                {uploading || saveDraft.isPending ? 'Sparar...' : 'Spara utkast'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseUpload;
