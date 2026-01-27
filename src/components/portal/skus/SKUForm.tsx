import React, { useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Upload } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

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

interface SKUFormProps {
  sku: SKU | null;
  onClose: () => void;
  categories: string[];
}

const SKUForm: React.FC<SKUFormProps> = ({ sku, onClose, categories }) => {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  
  const [formData, setFormData] = useState({
    sku: '',
    name: '',
    category: '',
    supplier: '',
    supplier_url: '',
    cost_ex_vat: '',
    default_margin: '',
    notes: '',
  });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch margin rules for auto-calculating sell price
  const { data: marginRules = [] } = useQuery({
    queryKey: ['margin_rules'],
    queryFn: async () => {
      const { data, error } = await supabase.from('margin_rules').select('*');
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (sku) {
      setFormData({
        sku: sku.sku,
        name: sku.name,
        category: sku.category,
        supplier: sku.supplier || '',
        supplier_url: sku.supplier_url || '',
        cost_ex_vat: sku.cost_ex_vat?.toString() || '',
        default_margin: sku.default_margin?.toString() || '',
        notes: sku.notes || '',
      });
    }
  }, [sku]);

  // Calculate sell price for display
  const calculateSellPrice = () => {
    const cost = parseFloat(formData.cost_ex_vat);
    if (isNaN(cost)) return null;
    
    const rule = marginRules.find(r => r.category === formData.category);
    const margin = formData.default_margin 
      ? parseFloat(formData.default_margin) 
      : (rule?.margin_percent ?? 0);
    const rounding = rule?.rounding ?? 5;
    
    const rawPrice = cost * (1 + margin / 100);
    return Math.round(rawPrice / rounding) * rounding;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      let imagePath = sku?.image_path || null;

      // Upload image if provided
      if (imageFile) {
        const fileName = `${formData.sku}.${imageFile.name.split('.').pop()}`;
        const { error: uploadError } = await supabase.storage
          .from('sku-images')
          .upload(fileName, imageFile, { upsert: true });
        
        if (uploadError) throw uploadError;
        imagePath = fileName;
      }

      const skuData = {
        sku: formData.sku,
        name: formData.name,
        category: formData.category,
        supplier: formData.supplier || null,
        supplier_url: formData.supplier_url || null,
        cost_ex_vat: formData.cost_ex_vat ? parseFloat(formData.cost_ex_vat) : null,
        default_margin: formData.default_margin ? parseFloat(formData.default_margin) : null,
        notes: formData.notes || null,
        image_path: imagePath,
      };

      if (sku) {
        const { error } = await supabase
          .from('skus')
          .update(skuData)
          .eq('id', sku.id);
        if (error) throw error;
        toast({ title: t('SKU uppdaterad', 'SKU updated') });
      } else {
        const { error } = await supabase.from('skus').insert(skuData);
        if (error) throw error;
        toast({ title: t('SKU skapad', 'SKU created') });
      }

      queryClient.invalidateQueries({ queryKey: ['skus'] });
      onClose();
    } catch (error: any) {
      toast({ 
        title: t('Ett fel uppstod', 'An error occurred'), 
        description: error.message,
        variant: 'destructive' 
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const sellPrice = calculateSellPrice();

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* SKU Code */}
      <div className="space-y-2">
        <Label htmlFor="sku">
          SKU <span className="text-destructive">*</span>
        </Label>
        <Input
          id="sku"
          value={formData.sku}
          onChange={(e) => setFormData(prev => ({ ...prev, sku: e.target.value.toUpperCase() }))}
          placeholder="ex. ZBT-2"
          required
        />
        <p className="text-xs text-muted-foreground">
          {t('Unik produktkod. Används även som filnamn för bild (ex. ZBT-2.jpg)', 
             'Unique product code. Also used as image filename (e.g. ZBT-2.jpg)')}
        </p>
      </div>

      {/* Product Name */}
      <div className="space-y-2">
        <Label htmlFor="name">
          {t('Produktnamn', 'Product Name')} <span className="text-destructive">*</span>
        </Label>
        <Input
          id="name"
          value={formData.name}
          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
          placeholder="ex. Zigbee Temperature Sensor"
          required
        />
      </div>

      {/* Category */}
      <div className="space-y-2">
        <Label>
          {t('Kategori', 'Category')} <span className="text-destructive">*</span>
        </Label>
        <Select 
          value={formData.category} 
          onValueChange={(value) => setFormData(prev => ({ ...prev, category: value }))}
          required
        >
          <SelectTrigger>
            <SelectValue placeholder={t('Välj kategori', 'Select category')} />
          </SelectTrigger>
          <SelectContent>
            {categories.map(cat => (
              <SelectItem key={cat} value={cat}>{cat}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Supplier */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="supplier">{t('Leverantör', 'Supplier')}</Label>
          <Input
            id="supplier"
            value={formData.supplier}
            onChange={(e) => setFormData(prev => ({ ...prev, supplier: e.target.value }))}
            placeholder="ex. Aqara"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="supplier_url">{t('Leverantör URL', 'Supplier URL')}</Label>
          <Input
            id="supplier_url"
            type="url"
            value={formData.supplier_url}
            onChange={(e) => setFormData(prev => ({ ...prev, supplier_url: e.target.value }))}
            placeholder="https://..."
          />
        </div>
      </div>

      {/* Pricing */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cost_ex_vat">{t('Kostnad ex moms (kr)', 'Cost ex VAT (kr)')}</Label>
          <Input
            id="cost_ex_vat"
            type="number"
            step="0.01"
            value={formData.cost_ex_vat}
            onChange={(e) => setFormData(prev => ({ ...prev, cost_ex_vat: e.target.value }))}
            placeholder="145"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="default_margin">{t('Standard marginal (%)', 'Default margin (%)')}</Label>
          <Input
            id="default_margin"
            type="number"
            step="0.1"
            value={formData.default_margin}
            onChange={(e) => setFormData(prev => ({ ...prev, default_margin: e.target.value }))}
            placeholder="35"
          />
        </div>
        <div className="space-y-2">
          <Label>{t('Säljpris (kr)', 'Sell Price (kr)')}</Label>
          <Input
            value={sellPrice ?? '—'}
            readOnly
            className="bg-muted"
          />
        </div>
      </div>

      {/* Image Upload */}
      <div className="space-y-2">
        <Label>{t('Produktbild', 'Product Image')}</Label>
        {(sku?.image_path && !imageFile) ? (
          <div className="space-y-3">
            <div className="border border-border rounded-lg p-4 bg-muted/30">
              <img
                src={`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/sku-images/${sku.image_path}`}
                alt={sku.name}
                className="max-h-40 mx-auto object-contain rounded"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => document.getElementById('image-upload')?.click()}
              className="w-full"
            >
              <Upload className="h-4 w-4 mr-2" />
              {t('Byt bild', 'Change image')}
            </Button>
          </div>
        ) : (
          <div 
            className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={() => document.getElementById('image-upload')?.click()}
          >
            <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-primary text-sm">
              {t('Klicka för att ladda upp bild', 'Click to upload image')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('Filnamn måste vara', 'Filename must be')} {formData.sku || 'SKU'}.jpg
            </p>
            {imageFile && (
              <p className="text-sm text-primary mt-2">{imageFile.name}</p>
            )}
          </div>
        )}
        <input
          id="image-upload"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => setImageFile(e.target.files?.[0] || null)}
        />
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes">{t('Anteckningar', 'Notes')}</Label>
        <Textarea
          id="notes"
          value={formData.notes}
          onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
          placeholder="ex. Requires Zigbee hub"
          rows={3}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-4">
        <Button type="submit" className="flex-1" disabled={isSubmitting}>
          {isSubmitting 
            ? t('Sparar...', 'Saving...') 
            : sku 
              ? t('Spara ändringar', 'Save changes') 
              : t('Lägg till SKU', 'Add SKU')
          }
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('Avbryt', 'Cancel')}
        </Button>
      </div>
    </form>
  );
};

export default SKUForm;
