import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
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
import { Plus, Upload, Search, Pencil, Trash2, ExternalLink, ImageIcon } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUForm from '@/components/portal/skus/SKUForm';

interface SKU {
  id: string;
  sku: string;
  name: string;
  category: string;
  supplier: string | null;
  supplier_url: string | null;
  cost_ex_vat: number | null;
  default_margin: number | null;
  notes: string | null;
  image_path: string | null;
}

const CATEGORIES = ['Sensorer', 'Controllers', 'Reläer', 'Material', 'Tjänst'];

const SKUCatalog: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSku, setEditingSku] = useState<SKU | null>(null);

  // Fetch SKUs
  const { data: skus = [], isLoading } = useQuery({
    queryKey: ['skus'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('skus')
        .select('*')
        .order('sku');
      if (error) throw error;
      return data as SKU[];
    },
    enabled: isStaff,
  });

  // Fetch margin rules for calculating sell price
  const { data: marginRules = [] } = useQuery({
    queryKey: ['margin_rules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('margin_rules').select('*');
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

  // Calculate sell price based on margin rules
  const calculateSellPrice = (sku: SKU) => {
    if (!sku.cost_ex_vat) return null;
    const rule = marginRules.find(r => r.category === sku.category);
    const margin = sku.default_margin ?? rule?.margin_percent ?? 0;
    const rounding = rule?.rounding ?? 5;
    const rawPrice = sku.cost_ex_vat * (1 + margin / 100);
    return Math.round(rawPrice / rounding) * rounding;
  };

  // Filter SKUs
  const filteredSkus = skus.filter(sku => {
    const matchesSearch = 
      sku.sku.toLowerCase().includes(search.toLowerCase()) ||
      sku.name.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || sku.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

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
              {t('Hantera hårdvarukatalog och standardpriser', 'Manage hardware catalog and standard prices')}
            </p>
          </div>
          <div className="flex gap-2">
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
              {CATEGORIES.map(cat => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-muted-foreground text-xs uppercase">SKU</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Namn', 'Name')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Kategori', 'Category')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">{t('Leverantör', 'Supplier')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Kostnad ex moms', 'Cost ex VAT')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Marginal %', 'Margin %')}</TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Säljpris', 'Sell Price')}</TableHead>
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
                filteredSkus.map((sku) => {
                  const sellPrice = calculateSellPrice(sku);
                  return (
                    <TableRow key={sku.id}>
                      <TableCell className="font-mono text-sm">{sku.sku}</TableCell>
                      <TableCell>{sku.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{sku.category}</Badge>
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
                        {sku.cost_ex_vat ? `${sku.cost_ex_vat} kr` : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {sku.default_margin ? `${sku.default_margin}%` : '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {sellPrice ? `${sellPrice} kr` : '—'}
                      </TableCell>
                      <TableCell className="text-center">
                        {sku.image_path ? (
                          <ImageIcon className="h-4 w-4 text-primary mx-auto" />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={() => handleEdit(sku)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={() => {
                              if (confirm(t('Är du säker på att du vill radera denna SKU?', 'Are you sure you want to delete this SKU?'))) {
                                deleteMutation.mutate(sku.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
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
            categories={CATEGORIES}
          />
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
};

export default SKUCatalog;
