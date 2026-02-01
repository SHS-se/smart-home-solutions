import React, { useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Upload, History, Info } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { sv, enUS } from 'date-fns/locale';

interface Category {
  id: string;
  name: string;
}

interface SKU {
  id: string;
  sku: string;
  name: string;
  category: string; // deprecated, kept for compatibility
  category_id: string | null;
  supplier: string | null;
  supplier_url: string | null;
  notes: string | null;
  image_path: string | null;
  // VAT-aware pricing fields
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
  // Legacy field (kept for compatibility)
  cost_ex_vat: number | null;
  default_margin: number | null;
}

interface SKUFormProps {
  sku: SKU | null;
  onClose: () => void;
  categories: Category[];
}

const VAT_RATE_OPTIONS = [
  { value: '0', label: '0%' },
  { value: '0.06', label: '6%' },
  { value: '0.12', label: '12%' },
  { value: '0.25', label: '25%' },
];

const ROUNDING_OPTIONS = [1, 5, 10, 50, 100];

const SKUForm: React.FC<SKUFormProps> = ({ sku, onClose, categories }) => {
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  
  const [formData, setFormData] = useState({
    sku: '',
    name: '',
    category_id: '', // Using category_id instead of category text
    supplier: '',
    supplier_url: '',
    notes: '',
    // VAT-aware pricing
    purchase_price: '',
    purchase_includes_vat: false,
    vat_rate: '0.25',
    margin_override_percent: '',
    rounding_override_sek: '',
  });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Update image filename when SKU changes
  useEffect(() => {
    if (imageFile && formData.sku) {
      const newFileName = `${formData.sku}.jpg`;
      if (imageFile.name !== newFileName) {
        const renamedFile = new File([imageFile], newFileName, { type: imageFile.type });
        setImageFile(renamedFile);
      }
    }
  }, [formData.sku]);

  // Fetch margin rules for placeholder values (with category_id join)
  const { data: marginRules = [] } = useQuery({
    queryKey: ['margin_rules_with_categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('margin_rules')
        .select('*, sku_categories!margin_rules_category_id_fkey(id, name)');
      if (error) throw error;
      return data;
    },
  });

  // Fetch price history for this SKU
  const { data: priceHistory = [] } = useQuery({
    queryKey: ['sku_price_history', sku?.id],
    queryFn: async () => {
      if (!sku?.id) return [];
      const { data, error } = await supabase
        .from('sku_price_history')
        .select('*')
        .eq('sku_id', sku.id)
        .order('changed_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!sku?.id,
  });

  useEffect(() => {
    if (sku) {
      setFormData({
        sku: sku.sku,
        name: sku.name,
        category_id: sku.category_id || '',
        supplier: sku.supplier || '',
        supplier_url: sku.supplier_url || '',
        notes: sku.notes || '',
        // VAT-aware pricing
        purchase_price: sku.purchase_price?.toString() || '',
        purchase_includes_vat: sku.purchase_includes_vat || false,
        vat_rate: sku.vat_rate?.toString() || '0.25',
        margin_override_percent: sku.margin_override_percent?.toString() || '',
        rounding_override_sek: sku.rounding_override_sek?.toString() || '',
      });
    }
  }, [sku]);

  // Get category rule for placeholders using category_id
  const categoryRule = marginRules.find(r => r.category_id === formData.category_id);

  // Calculate preview prices (client-side preview, actual calculation happens in DB trigger)
  const calculatePreview = () => {
    const purchasePrice = parseFloat(formData.purchase_price) || 0;
    const vatRate = parseFloat(formData.vat_rate) || 0.25;
    const includesVat = formData.purchase_includes_vat;
    
    // Compute cost ex VAT
    const costExVat = includesVat ? purchasePrice / (1 + vatRate) : purchasePrice;
    
    // Get effective margin and rounding
    const marginOverride = formData.margin_override_percent ? parseFloat(formData.margin_override_percent) : null;
    const roundingOverride = formData.rounding_override_sek ? parseInt(formData.rounding_override_sek) : null;
    const effectiveMargin = marginOverride ?? categoryRule?.margin_percent ?? 0;
    const effectiveRounding = roundingOverride ?? categoryRule?.rounding ?? 5;
    
    // Calculate sell prices with CEILING rounding
    const rawPrice = costExVat * (1 + effectiveMargin / 100);
    const sellPriceExVat = Math.ceil(rawPrice / effectiveRounding) * effectiveRounding;
    const sellPriceIncVat = sellPriceExVat * (1 + vatRate);
    
    return {
      costExVat: costExVat > 0 ? costExVat : null,
      effectiveMargin,
      effectiveRounding,
      sellPriceExVat: costExVat > 0 ? sellPriceExVat : null,
      sellPriceIncVat: costExVat > 0 ? sellPriceIncVat : null,
    };
  };

  const preview = calculatePreview();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate category_id exists in margin_rules
    if (!marginRules.find(r => r.category_id === formData.category_id)) {
      toast({
        title: t('Ogiltig kategori', 'Invalid category'),
        description: t('Kategorin måste finnas i marginalreglerna', 'Category must exist in margin rules'),
        variant: 'destructive',
      });
      return;
    }
    
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

      // Get category name for legacy field
      const selectedCategory = categories.find(c => c.id === formData.category_id);
      
      const skuData = {
        sku: formData.sku,
        name: formData.name,
        category_id: formData.category_id,
        category: selectedCategory?.name || '', // Keep legacy field in sync
        supplier: formData.supplier || null,
        supplier_url: formData.supplier_url || null,
        notes: formData.notes || null,
        image_path: imagePath,
        // VAT-aware pricing fields
        purchase_price: formData.purchase_price ? parseFloat(formData.purchase_price) : 0,
        purchase_includes_vat: formData.purchase_includes_vat,
        vat_rate: parseFloat(formData.vat_rate),
        margin_override_percent: formData.margin_override_percent ? parseFloat(formData.margin_override_percent) : null,
        rounding_override_sek: formData.rounding_override_sek ? parseInt(formData.rounding_override_sek) : null,
        // Legacy field for backwards compatibility
        cost_ex_vat: preview.costExVat,
        default_margin: formData.margin_override_percent ? parseFloat(formData.margin_override_percent) : null,
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
      queryClient.invalidateQueries({ queryKey: ['sku_price_history'] });
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

  const formatPrice = (value: number | null) => {
    if (value === null) return '—';
    return value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <Tabs defaultValue="details" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="details">{t('Detaljer', 'Details')}</TabsTrigger>
        <TabsTrigger value="history" disabled={!sku}>
          <History className="h-4 w-4 mr-2" />
          {t('Pris-historik', 'Price History')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="details">
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
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
              value={formData.category_id} 
              onValueChange={(value) => setFormData(prev => ({ ...prev, category_id: value }))}
              required
            >
              <SelectTrigger>
                <SelectValue placeholder={t('Välj kategori', 'Select category')} />
              </SelectTrigger>
              <SelectContent>
                {categories.map(cat => (
                  <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
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

          {/* VAT-Aware Pricing Section */}
          <div className="border border-border rounded-lg p-4 space-y-4 bg-muted/30">
            <h3 className="font-medium flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" />
              {t('Prissättning', 'Pricing')}
            </h3>

            {/* Purchase Price Row */}
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="purchase_price">{t('Inköpspris', 'Purchase Price')}</Label>
                <div className="relative">
                  <Input
                    id="purchase_price"
                    type="number"
                    step="0.01"
                    value={formData.purchase_price}
                    onChange={(e) => setFormData(prev => ({ ...prev, purchase_price: e.target.value }))}
                    placeholder="0"
                    className="pr-10"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">
                    kr
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('Inkl moms', 'Incl VAT')}</Label>
                <div className="flex items-center h-10">
                  <Switch
                    checked={formData.purchase_includes_vat}
                    onCheckedChange={(checked) => setFormData(prev => ({ ...prev, purchase_includes_vat: checked }))}
                  />
                  <span className="ml-2 text-sm text-muted-foreground">
                    {formData.purchase_includes_vat ? t('Ja', 'Yes') : t('Nej', 'No')}
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('Momssats', 'VAT Rate')}</Label>
                <Select 
                  value={formData.vat_rate} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, vat_rate: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VAT_RATE_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Override Row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="margin_override">{t('Marginal override', 'Margin override')}</Label>
                <div className="relative">
                  <Input
                    id="margin_override"
                    type="number"
                    step="0.1"
                    value={formData.margin_override_percent}
                    onChange={(e) => setFormData(prev => ({ ...prev, margin_override_percent: e.target.value }))}
                    placeholder={String(categoryRule?.margin_percent ?? '')}
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">
                    %
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('Lämna tom för att använda kategoristandard', 'Leave empty to use category default')}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t('Avrundning override', 'Rounding override')}</Label>
                <Select 
                  value={formData.rounding_override_sek || 'none'} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, rounding_override_sek: value === 'none' ? '' : value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={categoryRule?.rounding ? `${categoryRule.rounding} kr` : t('Kategoristandard', 'Category default')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('Kategoristandard', 'Category default')}</SelectItem>
                    {ROUNDING_OPTIONS.map(opt => (
                      <SelectItem key={opt} value={opt.toString()}>{opt} kr</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Calculated Fields (Read-only) */}
            <div className="border-t border-border pt-4 mt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-3">
                {t('Beräknade värden (ej redigerbara)', 'Calculated values (read-only)')}
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('Kostnad ex moms', 'Cost ex VAT')}</Label>
                  <div className="bg-muted px-3 py-2 rounded-md text-sm">
                    {formatPrice(preview.costExVat)} kr
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('Effektiv marginal', 'Effective margin')}</Label>
                  <div className="bg-muted px-3 py-2 rounded-md text-sm">
                    {preview.effectiveMargin}%
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('Säljpris ex moms', 'Sell price ex VAT')}</Label>
                  <div className="bg-muted px-3 py-2 rounded-md text-sm font-medium">
                    {formatPrice(preview.sellPriceExVat)} kr
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">{t('Säljpris inkl moms', 'Sell price incl VAT')}</Label>
                  <div className="bg-muted px-3 py-2 rounded-md text-sm font-medium text-primary">
                    {formatPrice(preview.sellPriceIncVat)} kr
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Image Upload / Paste */}
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
                <div
                  tabIndex={0}
                  className="border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:bg-muted/50 focus:ring-2 focus:ring-primary focus:outline-none transition-colors"
                  onPaste={async (e) => {
                    const items = e.clipboardData?.items;
                    if (!items) return;
                    for (const item of Array.from(items)) {
                      if (item.type.startsWith('image/')) {
                        const blob = item.getAsFile();
                        if (!blob) return;
                        // Convert to JPG via canvas
                        const img = new Image();
                        img.src = URL.createObjectURL(blob);
                        await new Promise((res) => { img.onload = res; });
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return;
                        ctx.drawImage(img, 0, 0);
                        canvas.toBlob((jpgBlob) => {
                          if (!jpgBlob) return;
                          const fileName = `${formData.sku || 'SKU'}.jpg`;
                          const file = new File([jpgBlob], fileName, { type: 'image/jpeg' });
                          setImageFile(file);
                        }, 'image/jpeg', 0.92);
                        URL.revokeObjectURL(img.src);
                        break;
                      }
                    }
                  }}
                >
                  <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-1" />
                  <p className="text-sm text-muted-foreground">
                    {t('Klistra in bild (Ctrl+V) för att byta', 'Paste image (Ctrl+V) to replace')}
                  </p>
                </div>
              </div>
            ) : (
              <div 
                tabIndex={0}
                className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:bg-muted/50 focus:ring-2 focus:ring-primary focus:outline-none transition-colors"
                onPaste={async (e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  for (const item of Array.from(items)) {
                    if (item.type.startsWith('image/')) {
                      const blob = item.getAsFile();
                      if (!blob) return;
                      // Convert to JPG via canvas
                      const img = new Image();
                      img.src = URL.createObjectURL(blob);
                      await new Promise((res) => { img.onload = res; });
                      const canvas = document.createElement('canvas');
                      canvas.width = img.width;
                      canvas.height = img.height;
                      const ctx = canvas.getContext('2d');
                      if (!ctx) return;
                      ctx.drawImage(img, 0, 0);
                      canvas.toBlob((jpgBlob) => {
                        if (!jpgBlob) return;
                        const fileName = `${formData.sku || 'SKU'}.jpg`;
                        const file = new File([jpgBlob], fileName, { type: 'image/jpeg' });
                        setImageFile(file);
                      }, 'image/jpeg', 0.92);
                      URL.revokeObjectURL(img.src);
                      break;
                    }
                  }
                }}
              >
                {!imageFile && (
                  <>
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                    <p className="text-primary text-sm">
                      {t('Klistra in bild från urklipp (Ctrl+V)', 'Paste image from clipboard (Ctrl+V)')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('Bilden sparas automatiskt som', 'Image will be saved as')} {formData.sku || 'SKU'}.jpg
                    </p>
                  </>
                )}
                {imageFile && (
                  <div className="space-y-2">
                    <img
                      src={URL.createObjectURL(imageFile)}
                      alt="Preview"
                      className="max-h-32 mx-auto object-contain rounded border border-border"
                    />
                    <p className="text-sm text-primary">✓ {imageFile.name}</p>
                  </div>
                )}
              </div>
            )}
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
      </TabsContent>

      <TabsContent value="history">
        <div className="mt-4">
          {priceHistory.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              {t('Ingen pris-historik tillgänglig', 'No price history available')}
            </p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('Datum', 'Date')}</TableHead>
                    <TableHead className="text-xs">{t('Orsak', 'Reason')}</TableHead>
                    <TableHead className="text-xs text-right">{t('Inköpspris', 'Purchase')}</TableHead>
                    <TableHead className="text-xs text-right">{t('Kostnad ex', 'Cost ex')}</TableHead>
                    <TableHead className="text-xs text-right">{t('Marginal', 'Margin')}</TableHead>
                    <TableHead className="text-xs text-right">{t('Sälj ex', 'Sell ex')}</TableHead>
                    <TableHead className="text-xs text-right">{t('Sälj ink', 'Sell inc')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {priceHistory.map(record => (
                    <TableRow key={record.id}>
                      <TableCell className="text-sm">
                        {format(new Date(record.changed_at), 'yyyy-MM-dd HH:mm', { locale: language === 'sv' ? sv : enUS })}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{record.change_reason}</TableCell>
                      <TableCell className="text-sm text-right">{record.purchase_price} kr</TableCell>
                      <TableCell className="text-sm text-right">{record.cost_ex_vat?.toFixed(2)} kr</TableCell>
                      <TableCell className="text-sm text-right">{record.effective_margin_percent}%</TableCell>
                      <TableCell className="text-sm text-right">{record.sell_price_ex_vat} kr</TableCell>
                      <TableCell className="text-sm text-right font-medium">{record.sell_price_inc_vat} kr</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
};

export default SKUForm;
