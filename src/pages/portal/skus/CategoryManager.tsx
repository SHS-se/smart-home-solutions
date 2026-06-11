import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
} from '@/components/ui/dialog';
import { ArrowLeft, Plus, Pencil, Trash2, GripVertical } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Category {
  id: string;
  key: string;
  name: string;
  description: string | null;
  sort_order: number;
}

const CategoryManager: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [formData, setFormData] = useState({ name: '', description: '' });

  // Fetch categories
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['sku_categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sku_categories')
        .select('*')
        .order('sort_order');
      if (error) throw error;
      return data as Category[];
    },
    enabled: isStaff,
  });

  // Generate machine key from name (lowercase, underscores)
  const generateKey = (name: string) => 
    name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

  // Create category mutation
  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const maxOrder = categories.length > 0 
        ? Math.max(...categories.map(c => c.sort_order)) 
        : 0;
      const { error } = await supabase
        .from('sku_categories')
        .insert({ 
          key: generateKey(data.name),
          name: data.name, 
          description: data.description || null,
          sort_order: maxOrder + 1 
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sku_categories'] });
      toast({ title: t('Kategori skapad', 'Category created') });
      handleCloseDialog();
    },
    onError: (error: Error) => {
      if (error.message.includes('duplicate')) {
        toast({ title: t('Kategorinamn finns redan', 'Category name already exists'), variant: 'destructive' });
      } else {
        toast({ title: t('Kunde inte skapa kategori', 'Failed to create category'), variant: 'destructive' });
      }
    },
  });

  // Update category mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name: string; description: string } }) => {
      const { error } = await supabase
        .from('sku_categories')
        .update({ name: data.name, description: data.description || null })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sku_categories'] });
      queryClient.invalidateQueries({ queryKey: ['skus'] });
      toast({ title: t('Kategori uppdaterad', 'Category updated') });
      handleCloseDialog();
    },
    onError: (error: Error) => {
      if (error.message.includes('duplicate')) {
        toast({ title: t('Kategorinamn finns redan', 'Category name already exists'), variant: 'destructive' });
      } else {
        toast({ title: t('Kunde inte uppdatera kategori', 'Failed to update category'), variant: 'destructive' });
      }
    },
  });

  // Delete category mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('sku_categories')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sku_categories'] });
      toast({ title: t('Kategori raderad', 'Category deleted') });
    },
    onError: () => {
      toast({ 
        title: t('Kunde inte radera kategori', 'Failed to delete category'),
        description: t('Kategorin kan vara kopplad till SKUs', 'Category may be linked to SKUs'),
        variant: 'destructive' 
      });
    },
  });

  const handleOpenAdd = () => {
    setEditingCategory(null);
    setFormData({ name: '', description: '' });
    setIsDialogOpen(true);
  };

  const handleOpenEdit = (category: Category) => {
    setEditingCategory(category);
    setFormData({ name: category.name, description: category.description || '' });
    setIsDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setIsDialogOpen(false);
    setEditingCategory(null);
    setFormData({ name: '', description: '' });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    
    if (editingCategory) {
      updateMutation.mutate({ id: editingCategory.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (category: Category) => {
    if (confirm(t(
      `Är du säker på att du vill radera kategorin "${category.name}"?`,
      `Are you sure you want to delete the category "${category.name}"?`
    ))) {
      deleteMutation.mutate(category.id);
    }
  };

  if (!authLoading && !isStaff) {
    return null;
  }

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/portal/skus">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              <h1 className="text-2xl font-bold text-foreground">
                {t('Kategorier', 'Categories')}
              </h1>
            </div>
            <p className="text-muted-foreground ml-12">
              {t('Hantera produktkategorier för SKU-katalogen', 'Manage product categories for the SKU catalog')}
            </p>
          </div>
          <Button onClick={handleOpenAdd}>
            <Plus className="h-4 w-4 mr-2" />
            {t('Lägg till kategori', 'Add category')}
          </Button>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12"></TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">
                  {t('Namn', 'Name')}
                </TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase">
                  {t('Beskrivning', 'Description')}
                </TableHead>
                <TableHead className="text-muted-foreground text-xs uppercase text-right">
                  {t('Åtgärder', 'Actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    {t('Laddar...', 'Loading...')}
                  </TableCell>
                </TableRow>
              ) : categories.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    {t('Inga kategorier hittades', 'No categories found')}
                  </TableCell>
                </TableRow>
              ) : (
                categories.map((category) => (
                  <TableRow key={category.id}>
                    <TableCell>
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell className="font-medium">{category.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {category.description || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => handleOpenEdit(category)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => handleDelete(category)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingCategory 
                ? t('Redigera kategori', 'Edit category') 
                : t('Lägg till kategori', 'Add category')}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Namn', 'Name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder={t('T.ex. Sensorer', 'E.g. Sensors')}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('Beskrivning', 'Description')}</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder={t('Valfri beskrivning...', 'Optional description...')}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={handleCloseDialog}>
                {t('Avbryt', 'Cancel')}
              </Button>
              <Button 
                type="submit" 
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {editingCategory ? t('Spara', 'Save') : t('Skapa', 'Create')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CategoryManager;
