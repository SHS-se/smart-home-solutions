import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Package, ChevronRight } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface Template {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  item_count: number;
  estimated_price: number;
}

const TemplatesList: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '' });

  // Fetch templates with item counts and prices
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      // Get templates
      const { data: templateData, error: templateError } = await supabase
        .from('templates')
        .select('*')
        .order('name');
      if (templateError) throw templateError;

      // Get template items with SKU data for each template
      const templatesWithData: Template[] = [];
      for (const template of templateData) {
        const { data: items } = await supabase
          .from('template_items')
          .select('quantity, skus(cost_ex_vat, default_margin, category)')
          .eq('template_id', template.id);

        // Get margin rules
        const { data: marginRules } = await supabase.from('margin_rules').select('*');

        let totalPrice = 0;
        let itemCount = 0;

        if (items) {
          for (const item of items) {
            itemCount += item.quantity;
            const sku = (item as any).skus;
            if (sku?.cost_ex_vat) {
              const rule = marginRules?.find(r => r.category === sku.category);
              const margin = sku.default_margin ?? rule?.margin_percent ?? 0;
              const rounding = rule?.rounding ?? 5;
              const rawPrice = sku.cost_ex_vat * (1 + margin / 100);
              const sellPrice = Math.round(rawPrice / rounding) * rounding;
              totalPrice += sellPrice * item.quantity;
            }
          }
        }

        templatesWithData.push({
          ...template,
          item_count: itemCount,
          estimated_price: totalPrice,
        });
      }

      return templatesWithData;
    },
    enabled: isStaff,
  });

  // Create template mutation
  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const { data: newTemplate, error } = await supabase
        .from('templates')
        .insert({ name: data.name, description: data.description || null })
        .select()
        .single();
      if (error) throw error;
      return newTemplate;
    },
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setIsDialogOpen(false);
      setFormData({ name: '', description: '' });
      navigate(`/portal/templates/${template.id}`);
    },
    onError: () => {
      toast({ title: t('Kunde inte skapa mall', 'Failed to create template'), variant: 'destructive' });
    },
  });

  const handleCreate = () => {
    if (!formData.name.trim()) return;
    createMutation.mutate(formData);
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
            <h1 className="text-2xl font-bold text-foreground">{t('Mallpaket', 'Templates')}</h1>
            <p className="text-muted-foreground">
              {t('Återanvändbara BOM-mallar för vanliga installationer', 'Reusable BOM templates for common installations')}
            </p>
          </div>
          <Button onClick={() => setIsDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('Skapa ny mall', 'Create new template')}
          </Button>
        </div>

        {/* Templates List */}
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">
            {t('Laddar...', 'Loading...')}
          </div>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('Inga mallar ännu', 'No templates yet')}</h3>
              <p className="text-muted-foreground mb-4">
                {t('Skapa en mall för att snabbt lägga till vanliga produktkombinationer i BOM', 
                   'Create a template to quickly add common product combinations to BOMs')}
              </p>
              <Button onClick={() => setIsDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                {t('Skapa första mallen', 'Create first template')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {templates.map(template => (
              <Card key={template.id} className="hover:border-primary/50 transition-colors">
                <Link to={`/portal/templates/${template.id}`}>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
                          <Package className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-lg">{template.name}</h3>
                          <p className="text-muted-foreground text-sm">{template.description}</p>
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="flex gap-8 mt-4 pt-4 border-t border-border">
                      <div>
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">
                          {t('Antal SKUs', 'SKU Count')}
                        </p>
                        <p className="font-medium">{template.item_count} st</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">
                          {t('Uppskattat pris', 'Estimated Price')}
                        </p>
                        <p className="font-medium text-primary">
                          {template.estimated_price.toLocaleString('sv-SE')} kr
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create Template Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Skapa ny mall', 'Create new template')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('Mallnamn', 'Template name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder={t('ex. Startpaket villa', 'e.g. Starter kit villa')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('Beskrivning', 'Description')}</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder={t('ex. Grundläggande smart home-installation för enfamiljshus', 
                               'e.g. Basic smart home installation for single-family houses')}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!formData.name.trim() || createMutation.isPending}>
              {createMutation.isPending ? t('Skapar...', 'Creating...') : t('Skapa mall', 'Create template')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PortalLayout>
  );
};

export default TemplatesList;
