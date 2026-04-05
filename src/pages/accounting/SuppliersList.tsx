import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SuppliersList: React.FC = () => {
  const { data: suppliers } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => {
      const { data } = await supabase.from('acc_suppliers').select('*').order('name');
      return data || [];
    },
  });

  const SUPPLIER_TYPE_LABELS: Record<string, string> = {
    domestic: 'Sverige',
    eu: 'EU',
    non_eu: 'Utanför EU',
  };

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Leverantörer</h1>
          <p className="text-muted-foreground mt-1">Leverantörsregister</p>
        </div>

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">Namn</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Org.nummer</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Momsnummer</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Typ</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">Land</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                      Inga leverantörer registrerade. Leverantörer skapas automatiskt vid inköpsregistrering.
                    </TableCell>
                  </TableRow>
                ) : suppliers?.map(s => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium text-sm">{s.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.org_number || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.vat_number || '—'}</TableCell>
                    <TableCell className="text-sm">{SUPPLIER_TYPE_LABELS[s.supplier_type] || s.supplier_type}</TableCell>
                    <TableCell className="text-sm">{s.country}</TableCell>
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

export default SuppliersList;
