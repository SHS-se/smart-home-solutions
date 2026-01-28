import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { naturalSort } from '@/lib/utils';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Search, Plus, Check } from 'lucide-react';

interface SKU {
  id: string;
  sku: string;
  name: string;
  category: string;
  cost_ex_vat_computed: number | null;
  vat_rate: number;
  sell_price_ex_vat: number | null;
  sell_price_inc_vat: number | null;
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

  // Fetch SKUs with pre-calculated pricing
  const { data: skus = [] } = useQuery({
    queryKey: ['skus'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('skus')
        .select('id, sku, name, category, cost_ex_vat_computed, vat_rate, sell_price_ex_vat, sell_price_inc_vat')
        .order('sku');
      if (error) throw error;
      return data as SKU[];
    },
  });

  // Filter and sort SKUs with natural sorting
  const filteredSkus = useMemo(() => {
    const filtered = skus.filter(sku =>
      sku.sku.toLowerCase().includes(search.toLowerCase()) ||
      sku.name.toLowerCase().includes(search.toLowerCase())
    );
    return naturalSort(filtered, 'sku');
  }, [skus, search]);

  const handleSelect = (sku: SKU) => {
    const quantity = quantities[sku.id] || 1;
    onSelect(sku.id, quantity);
    setQuantities({});
    setSearch('');
  };

  const handleQuantityChange = (skuId: string, value: number) => {
    setQuantities(prev => ({ ...prev, [skuId]: Math.max(1, value) }));
  };

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
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
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs uppercase">SKU</TableHead>
                  <TableHead className="text-xs uppercase">{t('Namn', 'Name')}</TableHead>
                  <TableHead className="text-xs uppercase">{t('Kategori', 'Category')}</TableHead>
                  <TableHead className="text-xs uppercase text-right">{t('Pris inkl', 'Price incl')}</TableHead>
                  <TableHead className="text-xs uppercase text-center">{t('Antal', 'Qty')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSkus.map(sku => {
                  const isAdded = existingSkuIds.includes(sku.id);
                  return (
                    <TableRow key={sku.id} className={isAdded ? 'opacity-50' : ''}>
                      <TableCell className="font-mono">{sku.sku}</TableCell>
                      <TableCell>{sku.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{sku.category}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help">
                              {sku.sell_price_inc_vat ? `${formatPrice(sku.sell_price_inc_vat)} kr` : '—'}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('Ex moms', 'Ex VAT')}: {formatPrice(sku.sell_price_ex_vat)} kr</p>
                          </TooltipContent>
                        </Tooltip>
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
          </TooltipProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SKUSelector;
