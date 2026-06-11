import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SuppliersList: React.FC = () => {
  const { t } = useLanguage();

  const { data: suppliers } = useQuery({
    queryKey: ['acc-suppliers'],
    queryFn: async () => { const { data } = await supabase.from('acc_suppliers').select('*').order('name'); return data || []; },
  });

  const SUPPLIER_TYPE_LABELS: Record<string, string> = {
    domestic: t('Sverige', 'Sweden'),
    eu: 'EU',
    non_eu: t('Utanför EU', 'Outside EU'),
  };

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('Leverantörer', 'Suppliers')}</h1>
          <p className="text-muted-foreground mt-1">{t('Leverantörsregister', 'Supplier registry')}</p>
        </div>

        <Card className="border border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Namn', 'Name')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Org.nummer', 'Reg. number')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Momsnummer', 'VAT number')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Typ', 'Type')}</TableHead>
                  <TableHead className="text-xs uppercase text-muted-foreground">{t('Land', 'Country')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                      {t('Inga leverantörer registrerade. Leverantörer skapas automatiskt vid inköpsregistrering.', 'No suppliers registered. Suppliers are created automatically when registering purchases.')}
                    </TableCell>
                  </TableRow>
                ) : suppliers?.map(s => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium text-sm">
                      <Link to={`/accounting/purchases?supplier=${s.id}`} className="text-primary hover:underline">
                        {s.name}
                      </Link>
                    </TableCell>
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
    </>
  );
};

export default SuppliersList;
