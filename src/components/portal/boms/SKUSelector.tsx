import React, { useState, useMemo, useCallback, useEffect } from 'react';
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
import { Search, Plus, X } from 'lucide-react';

interface SKU {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  category_name?: string;
  cost_ex_vat_computed: number | null;
  vat_rate: number;
  sell_price_ex_vat: number | null;
  sell_price_inc_vat: number | null;
}

interface SKUSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (skuId: string, quantity: number) => void;
  onRemove?: (skuId: string) => void;
  onQuantityChange?: (skuId: string, quantity: number) => void;
  existingSkuIds?: string[];
  existingQuantities?: Record<string, number>;
}

const SKUSelector: React.FC<SKUSelectorProps> = ({
  open,
  onOpenChange,
  onSelect,
  onRemove,
  onQuantityChange,
  existingSkuIds = [],
  existingQuantities = {},
}) => {
  const { t } = useLanguage();
  const [search, setSearch] = useState('');
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  // Track pending quantity changes for existing items to flush on close
  const [pendingChanges, setPendingChanges] = useState<Record<string, number>>({});
  // Optimistic local adds — show SKU as added immediately before server confirms
  const [localAddedIds, setLocalAddedIds] = useState<Set<string>>(new Set());

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPendingChanges({});
      setQuantities({});
      setLocalAddedIds(new Set());
    }
  }, [open]);

  // Fetch SKUs with pre-calculated pricing and category join
  const { data: skus = [] } = useQuery({
    queryKey: ['skus_for_selector'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('skus')
        .select('id, sku, name, category_id, cost_ex_vat_computed, vat_rate, sell_price_ex_vat, sell_price_inc_vat, sku_categories!skus_category_id_fkey(id, name)')
        .order('sku');
      if (error) throw error;
      return (data || []).map(sku => ({
        ...sku,
        category_name: (sku.sku_categories as { id: string; name: string } | null)?.name || 'Unknown',
      })) as SKU[];
    },
  });

  const filteredSkus = useMemo(() => {
    const filtered = skus.filter(sku =>
      sku.sku.toLowerCase().includes(search.toLowerCase()) ||
      sku.name.toLowerCase().includes(search.toLowerCase())
    );
    return naturalSort(filtered, 'sku');
  }, [skus, search]);

  const handleSelect = (sku: SKU) => {
    const quantity = quantities[sku.id] || 1;
    // Optimistically mark as added so the row flips to Remove immediately
    setLocalAddedIds(prev => new Set([...prev, sku.id]));
    onSelect(sku.id, quantity);
  };

  const handleRemove = (sku: SKU) => {
    onRemove?.(sku.id);
    // Remove from pending changes since it's been removed
    setPendingChanges(prev => {
      const next = { ...prev };
      delete next[sku.id];
      return next;
    });
  };

  const handleQuantityChange = (skuId: string, value: number, isExisting: boolean) => {
    const qty = Math.max(1, value);
    if (isExisting) {
      setPendingChanges(prev => ({ ...prev, [skuId]: qty }));
    } else {
      setQuantities(prev => ({ ...prev, [skuId]: qty }));
    }
  };

  const getDisplayQuantity = (skuId: string, isExisting: boolean) => {
    if (isExisting) {
      return pendingChanges[skuId] ?? existingQuantities[skuId] ?? 1;
    }
    return quantities[skuId] || 1;
  };

  // Flush pending quantity changes when closing
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && onQuantityChange) {
      // Flush all pending quantity changes
      Object.entries(pendingChanges).forEach(([skuId, qty]) => {
        const originalQty = existingQuantities[skuId];
        if (originalQty !== qty) {
          onQuantityChange(skuId, qty);
        }
      });
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, onQuantityChange, pendingChanges, existingQuantities]);

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  };

  return (
    <TooltipProvider>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-3xl h-[80vh] flex flex-col"
        onEscapeKeyDown={() => handleOpenChange(false)}
      >
        <DialogHeader>
          <DialogTitle>{t('Välj SKU', 'Select SKU')}</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            data-testid="sku-selector-search-input"
            placeholder={t('Sök SKU eller produktnamn...', 'Search SKU or product name...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex-1 overflow-auto min-h-0">
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
                  const isAdded = existingSkuIds.includes(sku.id) || localAddedIds.has(sku.id);
                  return (
                    <TableRow key={sku.id} data-testid="sku-selector-row" data-sku-id={sku.id} data-sku-code={sku.sku}>
                      <TableCell className="font-mono">{sku.sku}</TableCell>
                      <TableCell>{sku.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{sku.category_name}</Badge>
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
                          value={getDisplayQuantity(sku.id, isAdded)}
                          onChange={(e) => handleQuantityChange(sku.id, parseInt(e.target.value) || 1, isAdded)}
                          className="w-16 text-center"
                        />
                      </TableCell>
                      <TableCell>
                        {isAdded ? (
                          <Button 
                            variant="destructive" 
                            size="sm"
                            onClick={() => handleRemove(sku)}
                            disabled={!onRemove}
                          >
                            <X className="h-4 w-4 mr-1" />
                            {t('Ta bort', 'Remove')}
                          </Button>
                        ) : (
                          <Button 
                            data-testid="sku-selector-add-button"
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
    </TooltipProvider>
  );
};

export default SKUSelector;
