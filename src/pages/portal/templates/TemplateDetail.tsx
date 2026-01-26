import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Pencil, Trash2, Plus } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SKUSelector from '@/components/portal/boms/SKUSelector';

interface TemplateItem {
  id: string;
  sku_id: string;
  quantity: number;
  sku: {
    sku: string;
    name: string;
    cost_ex_vat: number | null;
    default_margin: number | null;
    category: string;
  };
}

const TemplateDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isSKUSelectorOpen, setIsSKUSelectorOpen] = useState(false);
  const [editFormData, setEditFormData] = useState({ name: '', description: '' });

  // Fetch template
  const { data: template, isLoading: templateLoading } = useQuery({
    queryKey: ['template', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: isStaff && !!id,
  });

  // Fetch template items with SKU data
  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['template_items', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('template_items')
        .select('*, skus(*)')
        .eq('template_id', id);
      if (error) throw error;
      return data.map(item => ({
        ...item,
        sku: (item as any).skus,
      })) as TemplateItem[];
    },
    enabled: isStaff && !!id,
  });

  // Fetch margin rules
  const { data: marginRules = [] } = useQuery({
    queryKey: ['margin_rules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('margin_rules').select('*');
      if (error) throw error;
      return data;
    },
    enabled: isStaff,
  });

  // Update template mutation
  const updateMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const { error } = await supabase
        .from('templates')
        .update({ name: data.name, description: data.description || null })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template', id] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setIsEditDialogOpen(false);
      toast({ title: t('Mall uppdaterad', 'Template updated') });
    },
  });

  // Add item mutation
  const addItemMutation = useMutation({
    mutationFn: async (data: { sku_id: string; quantity: number }) => {
      const { error } = await supabase
        .from('template_items')
        .upsert({ 
          template_id: id, 
          sku_id: data.sku_id, 
          quantity: data.quantity 
        }, { onConflict: 'template_id,sku_id' });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template_items', id] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  // Update quantity mutation
  const updateQuantityMutation = useMutation({
    mutationFn: async ({ itemId, quantity }: { itemId: string; quantity: number }) => {
      const { error } = await supabase
        .from('template_items')
        .update({ quantity })
        .eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template_items', id] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  // Delete item mutation
  const deleteItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from('template_items')
        .delete()
        .eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['template_items', id] });
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  // Calculate sell price
  const calculateSellPrice = (item: TemplateItem) => {
    if (!item.sku.cost_ex_vat) return 0;
    const rule = marginRules.find(r => r.category === item.sku.category);
    const margin = item.sku.default_margin ?? rule?.margin_percent ?? 0;
    const rounding = rule?.rounding ?? 5;
    const rawPrice = item.sku.cost_ex_vat * (1 + margin / 100);
    return Math.round(rawPrice / rounding) * rounding;
  };

  // Calculate totals
  const totalPrice = items.reduce((sum, item) => {
    return sum + calculateSellPrice(item) * item.quantity;
  }, 0);

  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

  const handleEditOpen = () => {
    if (template) {
      setEditFormData({ name: template.name, description: template.description || '' });
      setIsEditDialogOpen(true);
    }
  };

  const handleAddSKU = (skuId: string, quantity: number) => {
    addItemMutation.mutate({ sku_id: skuId, quantity });
  };

  // Create BOM from template
  const createBOMFromTemplate = async () => {
    try {
      // Create new BOM
      const { data: bom, error: bomError } = await supabase
        .from('boms')
        .insert({ project_name: `Från mall: ${template?.name}` })
        .select()
        .single();
      if (bomError) throw bomError;

      // Copy template items to BOM
      for (const item of items) {
        const sellPrice = calculateSellPrice(item);
        await supabase.from('bom_items').insert({
          bom_id: bom.id,
          sku_id: item.sku_id,
          quantity: item.quantity,
          cost: item.sku.cost_ex_vat,
          sell_price: sellPrice,
        });
      }

      navigate(`/portal/boms/${bom.id}`);
    } catch (error: any) {
      toast({ title: t('Kunde inte skapa BOM', 'Failed to create BOM'), description: error.message, variant: 'destructive' });
    }
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  if (templateLoading) {
    return (
      <PortalLayout>
        <div className="text-center py-12 text-muted-foreground">
          {t('Laddar...', 'Loading...')}
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Back Link */}
        <Link 
          to="/portal/templates" 
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('Tillbaka till mallar', 'Back to templates')}
        </Link>

        {/* Template Info */}
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold">{template?.name}</h1>
                <p className="text-muted-foreground">{template?.description}</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleEditOpen}>
                <Pencil className="h-4 w-4 mr-2" />
                {t('Redigera mall', 'Edit template')}
              </Button>
            </div>
            <div className="flex gap-8 mt-4 pt-4 border-t border-border">
              <div>
                <p className="text-sm text-muted-foreground">{t('Antal SKUs', 'SKU Count')}</p>
                <p className="text-lg font-medium">{totalItems}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t('Uppskattat pris', 'Estimated Price')}</p>
                <p className="text-lg font-medium text-primary">
                  {totalPrice.toLocaleString('sv-SE')} kr
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Items Table */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>{t('Inkluderade SKUs', 'Included SKUs')}</CardTitle>
            <Button size="sm" onClick={() => setIsSKUSelectorOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('Lägg till SKU', 'Add SKU')}
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-muted-foreground text-xs uppercase">SKU</TableHead>
                  <TableHead className="text-muted-foreground text-xs uppercase">{t('Produktnamn', 'Product Name')}</TableHead>
                  <TableHead className="text-muted-foreground text-xs uppercase text-center">{t('Antal', 'Quantity')}</TableHead>
                  <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Enhetspris', 'Unit Price')}</TableHead>
                  <TableHead className="text-muted-foreground text-xs uppercase text-right">{t('Radtotal', 'Row Total')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      {t('Inga SKUs tillagda ännu', 'No SKUs added yet')}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map(item => {
                    const sellPrice = calculateSellPrice(item);
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono">{item.sku.sku}</TableCell>
                        <TableCell>{item.sku.name}</TableCell>
                        <TableCell className="text-center">
                          <Input
                            type="number"
                            min="1"
                            value={item.quantity}
                            onChange={(e) => {
                              const qty = parseInt(e.target.value) || 1;
                              updateQuantityMutation.mutate({ itemId: item.id, quantity: qty });
                            }}
                            className="w-20 text-center mx-auto"
                          />
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {sellPrice.toLocaleString('sv-SE')} kr
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {(sellPrice * item.quantity).toLocaleString('sv-SE')} kr
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteItemMutation.mutate(item.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>

            {items.length > 0 && (
              <div className="flex justify-end mt-4 pt-4 border-t border-border">
                <div className="text-right">
                  <span className="text-muted-foreground mr-4">{t('Totalt', 'Total')}:</span>
                  <span className="text-xl font-bold text-primary">
                    {totalPrice.toLocaleString('sv-SE')} kr
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Create BOM Button */}
        <Button className="w-full" size="lg" onClick={createBOMFromTemplate} disabled={items.length === 0}>
          {t('Skapa BOM från mall', 'Create BOM from template')}
        </Button>
      </div>

      {/* Edit Template Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Redigera mall', 'Edit template')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('Mallnamn', 'Template name')}</Label>
              <Input
                id="edit-name"
                value={editFormData.name}
                onChange={(e) => setEditFormData(prev => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">{t('Beskrivning', 'Description')}</Label>
              <Textarea
                id="edit-description"
                value={editFormData.description}
                onChange={(e) => setEditFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button onClick={() => updateMutation.mutate(editFormData)} disabled={updateMutation.isPending}>
              {t('Spara', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SKU Selector */}
      <SKUSelector
        open={isSKUSelectorOpen}
        onOpenChange={setIsSKUSelectorOpen}
        onSelect={handleAddSKU}
        existingSkuIds={items.map(i => i.sku_id)}
      />
    </PortalLayout>
  );
};

export default TemplateDetail;
