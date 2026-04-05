import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, Receipt, ShoppingCart, AlertCircle, ArrowRight } from 'lucide-react';
import { MONTH_NAMES_SV, PURCHASE_STATUS_LABELS, PURCHASE_STATUS_COLORS, formatSEK } from '@/lib/accounting-utils';

const AccountingOverview: React.FC = () => {
  const { data: periods } = useQuery({
    queryKey: ['acc-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('month', { ascending: false });
      return data || [];
    },
  });

  const { data: purchases } = useQuery({
    queryKey: ['acc-purchases-summary'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('id, status, gross_amount, document_date, supplier_id, description');
      return data || [];
    },
  });

  const { data: vatPeriods } = useQuery({
    queryKey: ['acc-vat-periods'],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_vat_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('quarter', { ascending: false });
      return data || [];
    },
  });

  const currentPeriod = periods?.[0];
  const q1Vat = vatPeriods?.find(v => v.year === 2026 && v.quarter === 1);
  const draftPurchases = purchases?.filter(p => p.status === 'draft') || [];
  const blockedPurchases = purchases?.filter(p => p.status === 'blocked') || [];
  const reviewPurchases = purchases?.filter(p => p.status === 'in_review') || [];

  // Action items
  const actionItems: Array<{ title: string; detail: string; href: string }> = [];
  if (draftPurchases.length > 0) {
    actionItems.push({
      title: `${draftPurchases.length} utkast att granska`,
      detail: 'Inköp',
      href: '/accounting/purchases',
    });
  }
  if (blockedPurchases.length > 0) {
    actionItems.push({
      title: `${blockedPurchases.length} blockerade inköp`,
      detail: 'Kräver åtgärd',
      href: '/accounting/purchases',
    });
  }
  if (reviewPurchases.length > 0) {
    actionItems.push({
      title: `${reviewPurchases.length} inköp under granskning`,
      detail: 'Inköp',
      href: '/accounting/purchases',
    });
  }

  return (
    <AccountingLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ekonomiöversikt</h1>
          <p className="text-muted-foreground mt-1">Översikt över ekonomi och bokföring</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">Aktuell period</p>
                <p className="text-xl font-bold mt-1">
                  {currentPeriod ? `${MONTH_NAMES_SV[currentPeriod.month]} ${currentPeriod.year}` : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {currentPeriod ? (currentPeriod.status === 'open' ? 'Öppen för bokföring' : currentPeriod.status) : ''}
                </p>
              </div>
              <Calendar className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">Nästa momsdeklaration</p>
                <p className="text-xl font-bold mt-1">
                  {q1Vat?.deadline ? new Date(q1Vat.deadline).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }) : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Q1 2026</p>
              </div>
              <Receipt className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">Inköp att granska</p>
                <p className="text-xl font-bold mt-1">{draftPurchases.length + reviewPurchases.length + blockedPurchases.length}</p>
                <p className="text-xs text-muted-foreground mt-0.5">ej bokförda</p>
              </div>
              <ShoppingCart className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>

          <Card className="border border-border">
            <CardContent className="p-5 flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground">Bokförda inköp</p>
                <p className="text-xl font-bold mt-1">
                  {purchases ? formatSEK(purchases.filter(p => p.status === 'posted').reduce((s, p) => s + Number(p.gross_amount), 0)) : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {purchases?.filter(p => p.status === 'posted').length || 0} poster
                </p>
              </div>
              <Receipt className="w-5 h-5 text-primary-light" />
            </CardContent>
          </Card>
        </div>

        {/* Action items */}
        {actionItems.length > 0 && (
          <Card className="border border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-500" />
                <CardTitle className="text-lg">Kräver åtgärd</CardTitle>
                <span className="text-sm text-muted-foreground ml-auto">{actionItems.length} poster</span>
              </div>
            </CardHeader>
            <CardContent className="pt-0 divide-y divide-border">
              {actionItems.map((item, i) => (
                <Link key={i} to={item.href} className="flex items-center justify-between py-3 hover:bg-muted/30 -mx-6 px-6 transition-colors">
                  <div>
                    <p className="text-sm font-medium text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{item.detail}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground" />
                </Link>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Quick actions */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link to="/accounting/purchases/upload">
            <Card className="border border-border hover:shadow-soft transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <ShoppingCart className="w-8 h-8 text-primary mb-3" />
                <h3 className="font-semibold">Ladda upp inköp</h3>
                <p className="text-sm text-muted-foreground mt-1">Registrera nya leverantörsfakturor</p>
              </CardContent>
            </Card>
          </Link>

          <Link to="/accounting/vat-periods">
            <Card className="border border-border hover:shadow-soft transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <Receipt className="w-8 h-8 text-primary mb-3" />
                <h3 className="font-semibold">Momsdeklaration</h3>
                <p className="text-sm text-muted-foreground mt-1">Granska och lämna in moms</p>
              </CardContent>
            </Card>
          </Link>

          <Link to="/accounting/journal">
            <Card className="border border-border hover:shadow-soft transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <BookOpen className="w-8 h-8 text-primary mb-3" />
                <h3 className="font-semibold">Journal</h3>
                <p className="text-sm text-muted-foreground mt-1">Visa bokförda transaktioner</p>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default AccountingOverview;
