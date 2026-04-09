import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PURCHASE_STATUS_LABELS, PURCHASE_STATUS_LABELS_EN, PURCHASE_STATUS_COLORS, formatSEK } from '@/lib/accounting-utils';
import { formatCurrencyAmount, isForeignCurrency, normalizeCurrency } from '@/lib/accounting-fx';
import { Plus, Filter } from 'lucide-react';

const PurchasesList: React.FC = () => {
  const { t, language } = useLanguage();
  const statusLabels = language === 'sv' ? PURCHASE_STATUS_LABELS : PURCHASE_STATUS_LABELS_EN;
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data: purchases, isLoading } = useQuery({
    queryKey: ['acc-purchases', statusFilter],
    queryFn: async () => {
      let query = supabase.from('acc_purchases').select('*, supplier:acc_suppliers(name)').order('document_date', { ascending: false });
      if (statusFilter !== 'all') query = query.eq('status', statusFilter);
      const { data } = await query;
      return data || [];
    },
  });

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Inköp', 'Purchases')}</h1>
            <p className="text-muted-foreground mt-1">{t('Leverantörsfakturor och kvitton', 'Supplier invoices and receipts')}</p>
          </div>
          <Link to="/accounting/purchases/upload">
            <Button><Plus className="w-4 h-4 mr-2" />{t('Ladda upp faktura', 'Upload invoice')}</Button>
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t('Filtrera:', 'Filter:')}</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla', 'All')}</SelectItem>
              <SelectItem value="draft">{t('Utkast', 'Draft')}</SelectItem>
              <SelectItem value="in_review">{t('Granskning', 'Review')}</SelectItem>
              <SelectItem value="blocked">{t('Blockerad', 'Blocked')}</SelectItem>
              <SelectItem value="posted">{t('Bokförd', 'Posted')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">ID</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Leverantör', 'Supplier')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Datum', 'Date')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Belopp', 'Amount')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Status</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground text-right">{t('Åtgärd', 'Action')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</TableCell></TableRow>
                ) : purchases?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                      <p>{t('Inga inköp registrerade', 'No purchases registered')}</p>
                      <Link to="/accounting/purchases/upload" className="text-primary text-sm hover:underline mt-2 inline-block">
                        {t('Ladda upp ditt första inköp →', 'Upload your first purchase →')}
                      </Link>
                    </TableCell>
                  </TableRow>
                ) : purchases?.map((purchase) => (
                  <TableRow key={purchase.id} className="hover:bg-muted/30">
                    <TableCell><Link to={`/accounting/purchases/${purchase.id}`} className="text-primary hover:underline font-medium text-sm">{purchase.id.slice(0, 8)}...</Link></TableCell>
                    <TableCell><span className="text-sm">{(purchase.supplier as any)?.name || '—'}</span></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{purchase.document_date}</TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      <div>{formatSEK(Number(purchase.converted_gross_amount_sek ?? purchase.gross_amount))}</div>
                      {isForeignCurrency(purchase.original_currency || purchase.currency) && (
                        <div className="text-xs font-normal text-muted-foreground">
                          {formatCurrencyAmount(Number(purchase.original_gross_amount ?? purchase.gross_amount), normalizeCurrency(purchase.original_currency || purchase.currency))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`${PURCHASE_STATUS_COLORS[purchase.status as keyof typeof PURCHASE_STATUS_COLORS]} border-0 text-xs`}>
                        {statusLabels[purchase.status as keyof typeof statusLabels]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to={`/accounting/purchases/${purchase.id}`}><Button variant="outline" size="sm">{t('Granska', 'Review')}</Button></Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AccountingLayout>
  );
};

export default PurchasesList;
