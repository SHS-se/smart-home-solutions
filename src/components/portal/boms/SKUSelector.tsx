import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Search, Plus, Check } from 'lucide-react';

interface SKU {
  id: string;
  sku: string;
  name: string;
  category: string;
  cost_ex_vat: number | null;
  default_margin: number | null;
}

interface SKUSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (skuId: string, quantity: number) => void;
  existingSkuIds?: string[];
}

const SKUSelector: React.FC<SKUSelectorProps> = ({
  open,
  onOpenChange,
  onSelect,
  existingSkuIds = [],
}) => {
  const { t } = useLanguage();
  const [search, setSearch] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // Fetch SKUs
  const { data: skus = [] } = useQuery({
    queryKey: ['skus'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('skus')
        .select('id, sku, name, category, cost_ex_vat, default_margin')
        .order('sku');
      if (error) throw error;
      return data as SKU[];
    },
  });

  // Fetch margin rules
  const { data: marginRules = [] } = useQuery({
    queryKey: ['margin_rules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('margin_rules').select('*');
      if (error) throw error;
      return data;
    },
  });

  // Filter SKUs
  const filteredSkus = skus.filter(sku =>
    sku.sku.toLowerCase().includes(search.toLowerCase()) ||
    sku.name.toLowerCase().includes(search.toLowerCase())
  );

  // Calculate sell price
  const calculateSellPrice = (sku: SKU) => {
    if (!sku.cost_ex_vat) return null;
    const rule = marginRules.find(r => r.category === sku.category);
    const margin = sku.default_margin ?? rule?.margin_percent ?? 0;
    const rounding = rule?.rounding ?? 5;
    const rawPrice = sku.cost_ex_vat * (1 + margin / 100);
    return Math.round(rawPrice / rounding) * rounding;
  };

  const handleSelect = (sku: SKU) => {
    const quantity = quantities[sku.id] || 1;
    onSelect(sku.id, quantity);
    setQuantities({});
    setSearch('');
  };

  const handleQuantityChange = (skuId: string, value: number) => {
    setQuantities(prev => ({ ...prev, [skuId]: Math.max(1, value) }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('Välj SKU', 'Select SKU')}</DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('Sök SKU eller produktnamn...', 'Search SKU or product name...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* SKU List */}
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs uppercase">SKU</TableHead>
                <TableHead className="text-xs uppercase">{t('Namn', 'Name')}</TableHead>
                <TableHead className="text-xs uppercase">{t('Kategori', 'Category')}</TableHead>
                <TableHead className="text-xs uppercase text-right">{t('Pris', 'Price')}</TableHead>
                <TableHead className="text-xs uppercase text-center">{t('Antal', 'Qty')}</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSkus.map(sku => {
                const isAdded = existingSkuIds.includes(sku.id);
                const sellPrice = calculateSellPrice(sku);
                return (
                  <TableRow key={sku.id} className={isAdded ? 'opacity-50' : ''}>
                    <TableCell className="font-mono">{sku.sku}</TableCell>
                    <TableCell>{sku.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{sku.category}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {sellPrice ? `${sellPrice} kr` : '—'}
                    </TableCell>
                    <TableCell className="text-center">
                      <Input
                        type="number"
                        min="1"
                        value={quantities[sku.id] || 1}
                        onChange={(e) => handleQuantityChange(sku.id, parseInt(e.target.value) || 1)}
                        className="w-16 text-center"
                        disabled={isAdded}
                      />
                    </TableCell>
                    <TableCell>
                      {isAdded ? (
                        <Button variant="ghost" size="sm" disabled>
                          <Check className="h-4 w-4 mr-1" />
                          {t('Tillagd', 'Added')}
                        </Button>
                      ) : (
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => handleSelect(sku)}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          {t('Lägg till', 'Add')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SKUSelector;
