import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { naturalSort } from '@/lib/utils';
import { useTableSort } from '@/hooks/use-table-sort';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Plus, Upload, Search, Settings2, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUForm from '@/components/portal/skus/SKUForm';
import SKUActionsMenu from '@/components/portal/skus/SKUActionsMenu';

interface Category {
  id: string;
  name: string;
}

interface SKU {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  category_name?: string;
  supplier: string | null;
  supplier_url: string | null;
  notes: string | null;
  image_path: string | null;
  purchase_price: number;
  purchase_includes_vat: boolean;
  vat_rate: number;
  cost_ex_vat_computed: number | null;
  margin_override_percent: number | null;
  rounding_override_sek: number | null;
  effective_margin_percent: number | null;
  effective_rounding_sek: number | null;
  sell_price_ex_vat: number | null;
  sell_price_inc_vat: number | null;
  cost_ex_vat: number | null;
  default_margin: number | null;
}

type SortColumn = 'sku' | 'name' | 'category' | 'supplier' | 'cost_ex_vat' | 'margin' | 'sell_price';

const SKUCatalog: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSku, setEditingSku] = useState<SKU | null>(null);
  const { sortColumn, sortDirection, handleSort } = useTableSort<SortColumn>({ defaultColumn: 'sku' });

  // Fetch SKUs with category join
  const { data: skus = [], isLoading } = useQuery({
    queryKey: ['skus'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('skus')
        .select('*, sku_categories!skus_category_id_fkey(id, name)')
        .order('sku');
      if (error) throw error;
      // Map the joined category name
      return (data || []).map(sku => ({
        ...sku,
        category_name: (sku.sku_categories as { id: string; name: string } | null)?.name || 'Unknown',
      })) as SKU[];
    },
    enabled: isStaff,
  });

  // Fetch categories
  const { data: categories = [] } = useQuery({
    queryKey: ['sku_categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sku_categories')
        .select('*')
        .order('sort_order');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Delete SKU mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('skus').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['skus'] });
      toast({ title: t('SKU raderad', 'SKU deleted') });
    },
    onError: () => {
      toast({ title: t('Kunde inte radera SKU', 'Failed to delete SKU'), variant: 'destructive' });
    },
  });

  // Filter and sort SKUs
  const filteredSkus = useMemo(() => {
    // Apply search
    const filtered = skus.filter(sku => {
      const matchesSearch = 
        sku.sku.toLowerCase().includes(search.toLowerCase()) ||
        sku.name.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = categoryFilter === 'all' || sku.category_name === categoryFilter;
      return matchesSearch && matchesCategory;
    });

    // Apply sorting
    let sorted: SKU[];
    switch (sortColumn) {
      case 'sku':
      case 'name':
        sorted = naturalSort(filtered, sortColumn, sortDirection === 'asc');
        break;
      case 'category':
        sorted = naturalSort(filtered, 'category_name', sortDirection === 'asc');
        break;
      case 'supplier':
        sorted = naturalSort(filtered, 'supplier', sortDirection === 'asc');
        break;
      case 'cost_ex_vat':
        sorted = [...filtered].sort((a, b) => {
          const aVal = a.cost_ex_vat_computed ?? 0;
          const bVal = b.cost_ex_vat_computed ?? 0;
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        });
        break;
      case 'margin':
        sorted = [...filtered].sort((a, b) => {
          const aVal = a.effective_margin_percent ?? 0;
          const bVal = b.effective_margin_percent ?? 0;
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        });
        break;
      case 'sell_price':
        sorted = [...filtered].sort((a, b) => {
          const aVal = a.sell_price_inc_vat ?? 0;
          const bVal = b.sell_price_inc_vat ?? 0;
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        });
        break;
      default:
        sorted = filtered;
    }

    return sorted;
  }, [skus, search, categoryFilter, sortColumn, sortDirection]);

  const handleEdit = (sku: SKU) => {
    setEditingSku(sku);
    setIsDialogOpen(true);
  };

  const handleAdd = () => {
    setEditingSku(null);
    setIsDialogOpen(true);
  };

  const handleDialogClose = () => {
    setIsDialogOpen(false);
    setEditingSku(null);
  };

  const formatPrice = (value: number | null | undefined) => {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">SKU-katalog</h1>
            <p className="text-muted-foreground">
              {t('Hantera hårdvarukatalog och prissättning', 'Manage hardware catalog and pricing')}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/portal/skus/categories">
                <Settings2 className="h-4 w-4 mr-2" />
                {t('Kategorier', 'Categories')}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/portal/skus/import">
                <Upload className="h-4 w-4 mr-2" />
                Bulkimport
              </Link>
            </Button>
            <Button onClick={handleAdd}>
              <Plus className="h-4 w-4 mr-2" />
              {t('Lägg till SKU', 'Add SKU')}
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('Sök SKU eller produktnamn...', 'Search SKU or product name...')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder={t('Alla kategorier', 'All categories')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('Alla kategorier', 'All categories')}</SelectItem>
              {categories.map(cat => (
                <SelectItem key={cat.id} value={cat.name}>{cat.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead column="sku" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>SKU</SortableTableHead>
                  <SortableTableHead column="name" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>{t('Namn', 'Name')}</SortableTableHead>
                  <SortableTableHead column="category" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>{t('Kategori', 'Category')}</SortableTableHead>
                  <SortableTableHead column="supplier" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort}>{t('Leverantör', 'Supplier')}</SortableTableHead>
                  <SortableTableHead column="cost_ex_vat" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort} className="text-right">{t('Kostnad ex', 'Cost ex')}</SortableTableHead>
                  <SortableTableHead column="margin" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort} className="text-right">{t('Marginal', 'Margin')}</SortableTableHead>
                  <SortableTableHead column="sell_price" currentColumn={sortColumn} currentDirection={sortDirection} onSort={handleSort} className="text-right">{t('Säljpris inkl', 'Sell incl')}</SortableTableHead>
                  <TableHead className="text-muted-foreground text-xs uppercase text-center">{t('Bild', 'Image')}</TableHead>
                  <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Åtgärder', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      {t('Laddar...', 'Loading...')}
                    </TableCell>
                  </TableRow>
                ) : filteredSkus.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      {t('Inga SKUs hittades', 'No SKUs found')}
                    </TableCell>
                  </TableRow>
                ) : (
                filteredSkus.map((sku) => (
                  <TableRow key={sku.id}>
                    <TableCell className="font-mono text-sm">{sku.sku}</TableCell>
                    <TableCell>{sku.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{sku.category_name}</Badge>
                    </TableCell>
                    <TableCell>
                      {sku.supplier_url ? (
                        <a 
                          href={sku.supplier_url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-primary hover:underline flex items-center gap-1"
                        >
                          {sku.supplier}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        sku.supplier || '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {sku.cost_ex_vat_computed ? `${formatPrice(sku.cost_ex_vat_computed)} kr` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {sku.effective_margin_percent != null ? `${sku.effective_margin_percent}%` : '—'}
                    </TableCell>
                    <TableCell className="text-right font-medium">
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
                      {sku.image_path ? (
                        <img
                          src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/sku-images/${sku.image_path}`}
                          alt={sku.name}
                          className="h-10 w-10 object-contain mx-auto rounded"
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <SKUActionsMenu
                        onEdit={() => handleEdit(sku)}
                        onDelete={() => {
                          if (confirm(t('Är du säker på att du vill radera denna SKU?', 'Are you sure you want to delete this SKU?'))) {
                            deleteMutation.mutate(sku.id);
                          }
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))
                )}
              </TableBody>
            </Table>
          </TooltipProvider>
        </div>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingSku ? t('Redigera SKU', 'Edit SKU') : t('Lägg till SKU', 'Add SKU')}
            </DialogTitle>
          </DialogHeader>
          <SKUForm 
            sku={editingSku} 
            onClose={handleDialogClose}
            categories={categories as Category[]}
          />
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
};

export default SKUCatalog;
