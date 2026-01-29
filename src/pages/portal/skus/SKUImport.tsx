import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Upload, Download, Check, X, FileArchive, FileText, AlertTriangle, Info } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import JSZip, { JSZipObject } from 'jszip';

interface MarginRule {
  category: string;
  margin_percent: number;
  rounding: number;
}

interface ParsedSKU {
  sku: string;
  name: string;
  category: string;
  supplier: string;
  supplier_url: string;
  purchase_price: number;
  purchase_includes_vat: boolean;
  vat_rate: number;
  margin_override_percent: number | null;
  rounding_override_sek: number | null;
  notes: string;
  hasImage: boolean;
  imageFile?: File;
  isValid: boolean;
  errors: string[];
  // Preview calculated values (computed client-side for display only)
  preview_cost_ex_vat: number;
  preview_sell_price_ex_vat: number;
  preview_sell_price_inc_vat: number;
  // For upsert logic
  existsInDb: boolean;
  dbSkuId?: string;
  hasChanges?: boolean;
}

// New columns for VAT-aware pricing
const NEW_REQUIRED_COLUMNS = ['sku', 'name', 'category'];
const NEW_OPTIONAL_COLUMNS = ['supplier', 'supplier_url', 'purchase_price', 'purchase_includes_vat', 'vat_rate', 'margin_override_percent', 'rounding_override_sek', 'notes'];

// Legacy columns for backwards compatibility
const LEGACY_COLUMNS = ['cost_ex_vat', 'default_margin'];

const VALID_VAT_RATES = [0, 0.06, 0.12, 0.25];

const SKUImport: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsedSkus, setParsedSkus] = useState<ParsedSKU[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResults, setImportResults] = useState<{ success: number; failed: number; skipped: number }>({ success: 0, failed: 0, skipped: 0 });
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [fileDeleted, setFileDeleted] = useState(false);
  const [marginRules, setMarginRules] = useState<MarginRule[]>([]);
  const [isLegacyFormat, setIsLegacyFormat] = useState(false);

  // Persist form state in sessionStorage so it survives back-navigation
  const [csvText, setCsvText] = useState<string>(() => {
    try {
      return sessionStorage.getItem('sku-import-csv') || '';
    } catch {
      return '';
    }
  });
  const [allowUpsert, setAllowUpsert] = useState(() => {
    try {
      return sessionStorage.getItem('sku-import-upsert') === 'true';
    } catch {
      return false;
    }
  });

  // Sync csvText to sessionStorage
  useEffect(() => {
    try {
      if (csvText) {
        sessionStorage.setItem('sku-import-csv', csvText);
      } else {
        sessionStorage.removeItem('sku-import-csv');
      }
    } catch {
      // Ignore storage errors
    }
  }, [csvText]);

  // Sync allowUpsert to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('sku-import-upsert', String(allowUpsert));
    } catch {
      // Ignore storage errors
    }
  }, [allowUpsert]);

  // Fetch margin rules from the database
  useEffect(() => {
    const fetchMarginRules = async () => {
      const { data, error } = await supabase
        .from('margin_rules')
        .select('category, margin_percent, rounding');
      
      if (!error && data) {
        setMarginRules(data);
      }
    };
    fetchMarginRules();
  }, []);

  const categories = marginRules.map(r => r.category);

  // Pricing calculation (mirrors DB trigger logic)
  const calculatePreviewPricing = useCallback((
    purchasePrice: number,
    purchaseIncludesVat: boolean,
    vatRate: number,
    category: string,
    marginOverride: number | null,
    roundingOverride: number | null
  ) => {
    const rule = marginRules.find(r => r.category === category);
    if (!rule) {
      return { cost_ex_vat: 0, sell_ex_vat: 0, sell_inc_vat: 0 };
    }

    const costExVat = purchaseIncludesVat 
      ? purchasePrice / (1 + vatRate) 
      : purchasePrice;
    
    const effectiveMargin = marginOverride ?? rule.margin_percent;
    const effectiveRounding = roundingOverride ?? rule.rounding;
    
    const rawPrice = costExVat * (1 + effectiveMargin / 100);
    const sellExVat = Math.ceil(rawPrice / effectiveRounding) * effectiveRounding;
    const sellIncVat = sellExVat * (1 + vatRate);

    return {
      cost_ex_vat: costExVat,
      sell_ex_vat: sellExVat,
      sell_inc_vat: sellIncVat
    };
  }, [marginRules]);

  const downloadTemplate = () => {
    const csvContent = `sku,name,category,supplier,supplier_url,purchase_price,purchase_includes_vat,vat_rate,margin_override_percent,rounding_override_sek,notes
ZBT-2,Zigbee Temperature Sensor,Sensorer,Aqara,https://aqara.com,181.25,false,0.25,,,Requires Zigbee hub
ESP32-RELAY-4,ESP32 4-Channel Relay Module,Reläer,Shelly,,400,true,0.25,35,,
HUB-ZB-PRO,Zigbee Hub Professional,Controllers,Aqara,https://aqara.com,1562.50,false,0.25,,10,`;
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'skus_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseCSV = (csvText: string): string[][] => {
    const lines = csvText.trim().split('\n');
    return lines.map(line => {
      const values: string[] = [];
      let current = '';
      let inQuotes = false;
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      return values;
    });
  };

  // Parse boolean from various formats
  const parseBoolean = (value: string): boolean => {
    const v = value.toLowerCase().trim();
    return v === 'true' || v === '1' || v === 'yes' || v === 'ja';
  };

  // Parse VAT rate from various formats
  const parseVatRate = (value: string): number | null => {
    const v = value.trim().toLowerCase();
    if (!v) return 0.25; // Default
    
    // Handle percentage strings like "25%", "6%"
    if (v.endsWith('%')) {
      const num = parseFloat(v.replace('%', ''));
      if (!isNaN(num)) {
        return num / 100;
      }
    }
    
    // Handle decimal values
    const num = parseFloat(v);
    if (!isNaN(num)) {
      // If it's > 1, assume it's a percentage
      if (num > 1) {
        return num / 100;
      }
      return num;
    }
    
    return null;
  };

  // Validate URL format
  const isValidUrl = (url: string): boolean => {
    if (!url) return true;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  const validateSKU = (sku: Partial<ParsedSKU>, allSkus: string[], index: number): { isValid: boolean; errors: string[] } => {
    const errors: string[] = [];
    
    if (!sku.sku || sku.sku.length === 0) {
      errors.push(t('SKU-kod saknas', 'SKU code missing'));
    } else {
      // Check for duplicates within the batch
      const duplicateIndex = allSkus.findIndex((s, i) => s === sku.sku && i < index);
      if (duplicateIndex !== -1) {
        errors.push(t('Duplicerad SKU i import', 'Duplicate SKU in import'));
      }
    }
    
    if (!sku.name || sku.name.length === 0) {
      errors.push(t('Produktnamn saknas', 'Product name missing'));
    }
    
    if (!sku.category || !categories.includes(sku.category)) {
      errors.push(t('Kategori finns ej i margin_rules', 'Category not in margin_rules'));
    }
    
    if (sku.purchase_price !== undefined && sku.purchase_price < 0) {
      errors.push(t('Inköpspris måste vara >= 0', 'Purchase price must be >= 0'));
    }
    
    if (sku.vat_rate !== undefined && !VALID_VAT_RATES.includes(sku.vat_rate)) {
      errors.push(t('Ogiltig momssats (tillåtna: 0, 0.06, 0.12, 0.25)', 'Invalid VAT rate (allowed: 0, 0.06, 0.12, 0.25)'));
    }
    
    if (sku.rounding_override_sek !== null && sku.rounding_override_sek !== undefined && sku.rounding_override_sek < 1) {
      errors.push(t('Avrundning måste vara >= 1', 'Rounding must be >= 1'));
    }
    
    if (sku.margin_override_percent !== null && sku.margin_override_percent !== undefined && sku.margin_override_percent < 0) {
      errors.push(t('Marginal måste vara >= 0', 'Margin must be >= 0'));
    }
    
    if (sku.supplier_url && !isValidUrl(sku.supplier_url)) {
      errors.push(t('Ogiltig URL', 'Invalid URL'));
    }
    
    return { isValid: errors.length === 0, errors };
  };

  const parseSkuData = useCallback(async (
    headers: string[],
    dataRows: string[][],
    imageFiles: Map<string, File>
  ): Promise<{ skus: ParsedSKU[]; isLegacy: boolean }> => {
    // Check if this is legacy format
    const hasLegacyColumns = headers.includes('cost_ex_vat') || headers.includes('default_margin');
    const hasNewColumns = headers.includes('purchase_price');
    const isLegacy = hasLegacyColumns && !hasNewColumns;

    // Check existing SKUs in database
    const skuCodes = dataRows.map(row => {
      const skuIndex = headers.indexOf('sku');
      return (row[skuIndex] || '').toUpperCase();
    }).filter(Boolean);

    const { data: existingSkus } = await supabase
      .from('skus')
      .select('id, sku, name, category, supplier, supplier_url, purchase_price, purchase_includes_vat, vat_rate, margin_override_percent, rounding_override_sek, notes, image_path')
      .in('sku', skuCodes);

    const existingSkuMap = new Map(existingSkus?.map(s => [s.sku, s]) || []);

    const allSkuCodes = dataRows.map(row => {
      const skuIndex = headers.indexOf('sku');
      return (row[skuIndex] || '').toUpperCase();
    });

    const parsed: ParsedSKU[] = dataRows.map((row, index) => {
      const getData = (col: string) => {
        const idx = headers.indexOf(col);
        return idx >= 0 ? row[idx] || '' : '';
      };

      const skuCode = getData('sku').toUpperCase();
      const existingData = existingSkuMap.get(skuCode);

      let purchasePrice: number;
      let purchaseIncludesVat: boolean;
      let vatRate: number;
      let marginOverride: number | null = null;
      let roundingOverride: number | null = null;

      if (isLegacy) {
        // Map legacy columns to new format
        purchasePrice = parseFloat(getData('cost_ex_vat')) || 0;
        purchaseIncludesVat = false;
        vatRate = 0.25;
        const legacyMargin = getData('default_margin');
        marginOverride = legacyMargin ? parseFloat(legacyMargin) : null;
      } else {
        // Parse new format
        purchasePrice = parseFloat(getData('purchase_price')) || 0;
        purchaseIncludesVat = parseBoolean(getData('purchase_includes_vat'));
        const parsedVat = parseVatRate(getData('vat_rate'));
        vatRate = parsedVat !== null ? parsedVat : 0.25;
        
        const marginStr = getData('margin_override_percent');
        marginOverride = marginStr ? parseFloat(marginStr) : null;
        if (marginOverride !== null && isNaN(marginOverride)) marginOverride = null;
        
        const roundingStr = getData('rounding_override_sek');
        roundingOverride = roundingStr ? parseInt(roundingStr, 10) : null;
        if (roundingOverride !== null && isNaN(roundingOverride)) roundingOverride = null;
      }

      const category = getData('category');
      const imageFile = imageFiles.get(skuCode);

      // Calculate preview pricing
      const pricing = calculatePreviewPricing(
        purchasePrice,
        purchaseIncludesVat,
        vatRate,
        category,
        marginOverride,
        roundingOverride
      );

      const skuData: Partial<ParsedSKU> = {
        sku: skuCode,
        name: getData('name'),
        category,
        supplier: getData('supplier'),
        supplier_url: getData('supplier_url'),
        purchase_price: purchasePrice,
        purchase_includes_vat: purchaseIncludesVat,
        vat_rate: vatRate,
        margin_override_percent: marginOverride,
        rounding_override_sek: roundingOverride,
        notes: getData('notes'),
        hasImage: !!imageFile,
        imageFile,
        existsInDb: !!existingData,
        dbSkuId: existingData?.id,
        preview_cost_ex_vat: pricing.cost_ex_vat,
        preview_sell_price_ex_vat: pricing.sell_ex_vat,
        preview_sell_price_inc_vat: pricing.sell_inc_vat,
      };

      // Check if there are actual changes for upsert
      if (existingData) {
        const hasChanges = 
          existingData.name !== skuData.name ||
          existingData.category !== skuData.category ||
          existingData.supplier !== (skuData.supplier || null) ||
          existingData.supplier_url !== (skuData.supplier_url || null) ||
          existingData.purchase_price !== skuData.purchase_price ||
          existingData.purchase_includes_vat !== skuData.purchase_includes_vat ||
          existingData.vat_rate !== skuData.vat_rate ||
          existingData.margin_override_percent !== skuData.margin_override_percent ||
          existingData.rounding_override_sek !== skuData.rounding_override_sek ||
          existingData.notes !== (skuData.notes || null) ||
          (imageFile && existingData.image_path !== `${skuCode}.${imageFile.name.split('.').pop()}`);
        
        skuData.hasChanges = hasChanges;
      }

      const { isValid, errors } = validateSKU(skuData, allSkuCodes, index);

      // Add error for existing SKU if not in upsert mode
      if (existingData && !allowUpsert) {
        errors.push(t('SKU finns redan', 'SKU already exists'));
      }

      return {
        ...skuData,
        isValid: errors.length === 0,
        errors,
      } as ParsedSKU;
    });

    return { skus: parsed, isLegacy };
  }, [categories, calculatePreviewPricing, t, allowUpsert]);

  const handleCsvTextSubmit = useCallback(async () => {
    if (!csvText.trim()) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Vänligen klistra in CSV-data', 'Please paste CSV data'),
        variant: 'destructive',
      });
      return;
    }

    setIsProcessing(true);
    
    try {
      const rows = parseCSV(csvText);
      
      if (rows.length < 2) {
        throw new Error(t('CSV-data är tom eller saknar rader', 'CSV data is empty or missing rows'));
      }

      const headers = rows[0].map(h => h.toLowerCase().trim());
      const dataRows = rows.slice(1).filter(row => row.some(cell => cell.trim()));

      // Validate required headers
      const missingHeaders = NEW_REQUIRED_COLUMNS.filter(col => !headers.includes(col));
      if (missingHeaders.length > 0) {
        throw new Error(`${t('Saknade kolumner', 'Missing columns')}: ${missingHeaders.join(', ')}`);
      }

      const { skus: parsed, isLegacy } = await parseSkuData(headers, dataRows, new Map());
      
      setParsedSkus(parsed);
      setIsLegacyFormat(isLegacy);
      setUploadedFileName(null);
      setStep(2);
    } catch (error: any) {
      toast({
        title: t('Fel vid tolkning', 'Parse error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsProcessing(false);
    }
  }, [csvText, t, parseSkuData]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFileName(file.name);
    setIsProcessing(true);
    
    try {
      const zip = await JSZip.loadAsync(file);
      
      // Find and parse CSV
      let csvFile: JSZipObject | null = null;
      const imageFiles: Map<string, File> = new Map();
      
      const zipFiles = zip.files;
      for (const path of Object.keys(zipFiles)) {
        const zipEntry = zipFiles[path];
        if (path.endsWith('.csv') && !zipEntry.dir) {
          csvFile = zipEntry;
        } else if (
          (path.startsWith('images/') || path.includes('/images/')) && 
          (path.endsWith('.jpg') || path.endsWith('.png') || path.endsWith('.jpeg'))
        ) {
          const fileName = path.split('/').pop()?.toUpperCase().replace(/\.(JPG|PNG|JPEG)$/i, '') || '';
          const blob = await zipEntry.async('blob');
          imageFiles.set(fileName, new File([blob], path.split('/').pop() || '', { type: 'image/jpeg' }));
        }
      }

      if (!csvFile) {
        throw new Error(t('Ingen CSV-fil hittades i ZIP-arkivet', 'No CSV file found in ZIP archive'));
      }

      const csvContent = await csvFile.async('text');
      const rows = parseCSV(csvContent);
      
      if (rows.length < 2) {
        throw new Error(t('CSV-filen är tom eller saknar data', 'CSV file is empty or missing data'));
      }

      const headers = rows[0].map(h => h.toLowerCase().trim());
      const dataRows = rows.slice(1).filter(row => row.some(cell => cell.trim()));

      // Validate required headers
      const missingHeaders = NEW_REQUIRED_COLUMNS.filter(col => !headers.includes(col));
      if (missingHeaders.length > 0) {
        throw new Error(`${t('Saknade kolumner', 'Missing columns')}: ${missingHeaders.join(', ')}`);
      }

      const { skus: parsed, isLegacy } = await parseSkuData(headers, dataRows, imageFiles);

      setParsedSkus(parsed);
      setIsLegacyFormat(isLegacy);
      setStep(2);
    } catch (error: any) {
      toast({
        title: t('Fel vid import', 'Import error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsProcessing(false);
    }
  }, [t, parseSkuData]);

  const handleImport = async () => {
    setIsProcessing(true);
    let success = 0;
    let failed = 0;
    let skipped = 0;

    const validSkus = parsedSkus.filter(s => s.isValid);

    for (const sku of validSkus) {
      try {
        // Skip if exists and no changes (upsert mode only)
        if (sku.existsInDb && allowUpsert && !sku.hasChanges) {
          skipped++;
          continue;
        }

        // Upload image if present
        let imagePath: string | null = null;
        if (sku.imageFile) {
          const ext = sku.imageFile.name.split('.').pop();
          const fileName = `${sku.sku}.${ext}`;
          const { error: uploadError } = await supabase.storage
            .from('sku-images')
            .upload(fileName, sku.imageFile, { upsert: true });
          
          if (!uploadError) {
            imagePath = fileName;
          }
        }

        if (sku.existsInDb && allowUpsert) {
          // Update existing SKU
          const { error } = await supabase
            .from('skus')
            .update({
              name: sku.name,
              category: sku.category,
              supplier: sku.supplier || null,
              supplier_url: sku.supplier_url || null,
              purchase_price: sku.purchase_price,
              purchase_includes_vat: sku.purchase_includes_vat,
              vat_rate: sku.vat_rate,
              margin_override_percent: sku.margin_override_percent,
              rounding_override_sek: sku.rounding_override_sek,
              notes: sku.notes || null,
              ...(imagePath ? { image_path: imagePath } : {}),
            })
            .eq('id', sku.dbSkuId!);
          
          if (error) throw error;
        } else {
          // Insert new SKU
          const { error } = await supabase
            .from('skus')
            .insert({
              sku: sku.sku,
              name: sku.name,
              category: sku.category,
              supplier: sku.supplier || null,
              supplier_url: sku.supplier_url || null,
              purchase_price: sku.purchase_price,
              purchase_includes_vat: sku.purchase_includes_vat,
              vat_rate: sku.vat_rate,
              margin_override_percent: sku.margin_override_percent,
              rounding_override_sek: sku.rounding_override_sek,
              notes: sku.notes || null,
              ...(imagePath ? { image_path: imagePath } : {}),
            });
          
          if (error) throw error;
        }
        
        success++;
      } catch (err) {
        console.error('Import error for SKU:', sku.sku, err);
        failed++;
      }
    }

    setImportResults({ success, failed, skipped });
    setStep(3);
    setIsProcessing(false);
  };

  // Re-validate when upsert toggle changes
  useEffect(() => {
    if (step === 2 && parsedSkus.length > 0) {
      const revalidated = parsedSkus.map((sku, index) => {
        const allSkuCodes = parsedSkus.map(s => s.sku);
        const baseErrors = sku.errors.filter(e => 
          e !== t('SKU finns redan', 'SKU already exists')
        );
        
        if (sku.existsInDb && !allowUpsert) {
          baseErrors.push(t('SKU finns redan', 'SKU already exists'));
        }
        
        return {
          ...sku,
          errors: baseErrors,
          isValid: baseErrors.length === 0,
        };
      });
      setParsedSkus(revalidated);
    }
  }, [allowUpsert]);

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const validCount = parsedSkus.filter(s => s.isValid).length;
  const invalidCount = parsedSkus.filter(s => !s.isValid).length;
  const existingCount = parsedSkus.filter(s => s.existsInDb).length;
  const unchangedCount = parsedSkus.filter(s => s.existsInDb && !s.hasChanges).length;

  const formatPrice = (price: number) => {
    return price.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <PortalLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal/skus')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Importera SKUs', 'Import SKUs')}</h1>
            <p className="text-muted-foreground">
              {t('Bulkimport av produkter med momskalkylering', 'Bulk import of products with VAT calculations')}
            </p>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-8">
          {[
            { num: 1, title: t('Ladda upp', 'Upload'), sub: 'ZIP/CSV' },
            { num: 2, title: t('Granska', 'Review'), sub: t('Kontrollera data', 'Check data') },
            { num: 3, title: t('Slutför', 'Complete'), sub: t('Import klar', 'Import done') },
          ].map((s, i) => (
            <React.Fragment key={s.num}>
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step >= s.num 
                    ? 'bg-primary text-primary-foreground' 
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {step > s.num ? <Check className="h-4 w-4" /> : s.num}
                </div>
                <div>
                  <p className={`text-sm font-medium ${step >= s.num ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {s.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{s.sub}</p>
                </div>
              </div>
              {i < 2 && <div className="w-16 h-px bg-border" />}
            </React.Fragment>
          ))}
        </div>

        {/* Step 1: Upload */}
        {step === 1 && (
          <div className="space-y-6">
            {/* Instructions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t('Så här fungerar importen', 'How the import works')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium">1</div>
                  <div>
                    <p className="font-medium">{t('Förbered dina filer', 'Prepare your files')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Skapa en ZIP-fil som innehåller', 'Create a ZIP file containing')} <code className="bg-muted px-1 rounded">skus.csv</code> {t('och en', 'and a')} <code className="bg-muted px-1 rounded">/images/</code> {t('mapp med produktbilder', 'folder with product images')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium">2</div>
                  <div>
                    <p className="font-medium">{t('Priskalkylering', 'Price calculation')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Säljpris beräknas automatiskt baserat på inköpspris, moms och marginaler', 'Sell price is calculated automatically based on purchase price, VAT and margins')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium">3</div>
                  <div>
                    <p className="font-medium">{t('Granska & bekräfta', 'Review & confirm')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Kontrollera förhandsvisning av priser innan import', 'Check price preview before import')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            {/* Paste CSV */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  {t('Klistra in CSV-data', 'Paste CSV data')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  placeholder={`sku,name,category,supplier,supplier_url,purchase_price,purchase_includes_vat,vat_rate,margin_override_percent,rounding_override_sek,notes
ZBT-2,Zigbee Temperature Sensor,Sensorer,Aqara,https://aqara.com,181.25,false,0.25,,,Requires Zigbee hub`}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  className="font-mono text-xs min-h-[200px]"
                />
                <Button 
                  onClick={handleCsvTextSubmit} 
                  disabled={isProcessing || !csvText.trim()}
                  className="w-full"
                >
                  {isProcessing ? t('Bearbetar...', 'Processing...') : t('Analysera CSV', 'Parse CSV')}
                </Button>
                <div className="mt-4 text-xs text-muted-foreground space-y-1">
                  <p><strong>{t('Obligatoriska kolumner', 'Required columns')}:</strong> sku, name, category</p>
                  <p><strong>{t('Valfria kolumner', 'Optional columns')}:</strong> supplier, supplier_url, purchase_price, purchase_includes_vat, vat_rate, margin_override_percent, rounding_override_sek, notes</p>
                  <p><strong>purchase_includes_vat:</strong> true/false ({t('accepterar även', 'also accepts')} 1/0, yes/no)</p>
                  <p><strong>vat_rate:</strong> 0, 0.06, 0.12, 0.25 ({t('accepterar även', 'also accepts')} 6%, 12%, 25%)</p>
                  <p><strong>margin_override_percent:</strong> {t('Tomt = använd kategoristandard', 'Empty = use category default')}</p>
                  <p><strong>rounding_override_sek:</strong> {t('Tomt = använd kategoristandard', 'Empty = use category default')}</p>
                  <p><strong>{t('Kategorier', 'Categories')}:</strong> {categories.length > 0 ? categories.join(', ') : t('Laddar...', 'Loading...')}</p>
                </div>
              </CardContent>
            </Card>

            <div className="flex items-center gap-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-sm text-muted-foreground">{t('eller', 'or')}</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Upload ZIP Area */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileArchive className="h-5 w-5" />
                  {t('Ladda upp ZIP-fil', 'Upload ZIP file')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  {t('Använd en ZIP-fil för att inkludera bilder tillsammans med CSV-data', 'Use a ZIP file to include images along with CSV data')}
                </p>
                <label 
                  className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <FileArchive className="h-10 w-10 text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground mb-3">
                    {t('Dra och släpp din ZIP-fil här eller klicka för att välja', 'Drag and drop your ZIP file here or click to select')}
                  </p>
                  <span className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium border border-border bg-card hover:bg-muted hover:border-primary/30 text-foreground h-9 px-4 py-2 cursor-pointer">
                    {isProcessing ? t('Bearbetar...', 'Processing...') : t('Välj fil', 'Choose file')}
                  </span>
                  <input
                    type="file"
                    accept=".zip"
                    className="hidden"
                    onChange={handleFileUpload}
                    disabled={isProcessing}
                  />
                </label>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 2: Review */}
        {step === 2 && (
          <div className="space-y-6">
            {/* Legacy format warning */}
            {isLegacyFormat && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {t(
                    'Legacy CSV-format upptäckt. Kolumnen cost_ex_vat har tolkats som purchase_price ex moms (purchase_includes_vat = false, vat_rate = 0.25).',
                    'Legacy CSV format detected. The cost_ex_vat column has been interpreted as purchase_price ex VAT (purchase_includes_vat = false, vat_rate = 0.25).'
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* Preview info */}
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                {t(
                  'Förhandsgranskning av priser beräknas lokalt. Slutgiltiga priser beräknas av databasen vid import.',
                  'Price preview is calculated locally. Final prices are calculated by the database on import.'
                )}
              </AlertDescription>
            </Alert>

            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex gap-4 flex-wrap">
                <Badge variant="secondary" className="text-sm">
                  {validCount} {t('giltiga', 'valid')}
                </Badge>
                {invalidCount > 0 && (
                  <Badge variant="destructive" className="text-sm">
                    {invalidCount} {t('ogiltiga', 'invalid')}
                  </Badge>
                )}
                {existingCount > 0 && (
                  <Badge variant="outline" className="text-sm">
                    {existingCount} {t('finns redan', 'already exist')}
                  </Badge>
                )}
                {allowUpsert && unchangedCount > 0 && (
                  <Badge variant="secondary" className="text-sm bg-muted">
                    {unchangedCount} {t('oförändrade (hoppas över)', 'unchanged (will skip)')}
                  </Badge>
                )}
              </div>
              <div className="flex gap-4 items-center">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="allow-upsert"
                    checked={allowUpsert}
                    onCheckedChange={setAllowUpsert}
                  />
                  <Label htmlFor="allow-upsert" className="text-sm">
                    {t('Tillåt uppdateringar (upsert)', 'Allow updates (upsert)')}
                  </Label>
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => { setStep(1); setCsvText(''); setParsedSkus([]); setIsLegacyFormat(false); }}>
                {t('Tillbaka', 'Back')}
              </Button>
              <Button onClick={handleImport} disabled={validCount === 0 || isProcessing}>
                {isProcessing ? t('Importerar...', 'Importing...') : t('Importera', 'Import')} ({validCount})
              </Button>
            </div>

            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[100px]">SKU</TableHead>
                      <TableHead className="min-w-[150px]">{t('Namn', 'Name')}</TableHead>
                      <TableHead>{t('Kategori', 'Category')}</TableHead>
                      <TableHead className="text-right">{t('Inköpspris', 'Purchase')}</TableHead>
                      <TableHead className="text-center">{t('Inkl moms', 'Inc VAT')}</TableHead>
                      <TableHead className="text-center">{t('Momssats', 'VAT rate')}</TableHead>
                      <TableHead className="text-right">{t('Marginal', 'Margin')}</TableHead>
                      <TableHead className="text-right">{t('Avrundning', 'Rounding')}</TableHead>
                      <TableHead className="text-center">{t('Bild', 'Image')}</TableHead>
                      <TableHead className="border-l border-border text-right text-muted-foreground text-xs">
                        {t('Kostnad ex moms', 'Cost ex VAT')}*
                      </TableHead>
                      <TableHead className="text-right text-muted-foreground text-xs">
                        {t('Säljpris ex', 'Sell ex')}*
                      </TableHead>
                      <TableHead className="text-right text-muted-foreground text-xs">
                        {t('Säljpris inkl', 'Sell inc')}*
                      </TableHead>
                      <TableHead>{t('Status', 'Status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedSkus.map((sku, i) => (
                      <TableRow key={i} className={!sku.isValid ? 'bg-destructive/10' : sku.existsInDb ? 'bg-muted/30' : ''}>
                        <TableCell className="font-mono text-xs">{sku.sku}</TableCell>
                        <TableCell className="text-sm">{sku.name}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">{sku.category}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatPrice(sku.purchase_price)} kr
                        </TableCell>
                        <TableCell className="text-center">
                          {sku.purchase_includes_vat ? (
                            <Check className="h-4 w-4 text-primary mx-auto" />
                          ) : (
                            <X className="h-4 w-4 text-muted-foreground mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {(sku.vat_rate * 100).toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {sku.margin_override_percent !== null ? `${sku.margin_override_percent}%` : '—'}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {sku.rounding_override_sek !== null ? `${sku.rounding_override_sek} kr` : '—'}
                        </TableCell>
                        <TableCell className="text-center">
                          {sku.hasImage ? (
                            <Check className="h-4 w-4 text-primary mx-auto" />
                          ) : (
                            <X className="h-4 w-4 text-muted-foreground mx-auto" />
                          )}
                        </TableCell>
                        <TableCell className="border-l border-border text-right font-mono text-xs text-muted-foreground">
                          {formatPrice(sku.preview_cost_ex_vat)} kr
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {formatPrice(sku.preview_sell_price_ex_vat)} kr
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {formatPrice(sku.preview_sell_price_inc_vat)} kr
                        </TableCell>
                        <TableCell>
                          {sku.isValid ? (
                            sku.existsInDb ? (
                              sku.hasChanges ? (
                                <Badge variant="outline" className="text-xs">
                                  {t('Uppdateras', 'Update')}
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="bg-muted text-muted-foreground text-xs">
                                  {t('Hoppa över', 'Skip')}
                                </Badge>
                              )
                            ) : (
                              <Badge variant="secondary" className="bg-primary/10 text-primary text-xs">
                                {t('Ny', 'New')}
                              </Badge>
                            )
                          ) : (
                            <Badge variant="destructive" className="text-xs">
                              {sku.errors.join(', ')}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="p-3 border-t border-border bg-muted/30">
                <p className="text-xs text-muted-foreground">
                  * {t('Förhandsgranskning (beräknas i databasen vid import)', 'Preview (calculated by database on import)')}
                </p>
              </div>
            </Card>
          </div>
        )}

        {/* Step 3: Complete */}
        {step === 3 && (
          <Card className="text-center p-8">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Check className="h-8 w-8 text-primary" />
            </div>
            <h2 className="text-xl font-bold mb-2">{t('Import slutförd!', 'Import complete!')}</h2>
            <p className="text-muted-foreground mb-4">
              {importResults.success} {t('SKUs importerade', 'SKUs imported')}
              {importResults.skipped > 0 && `, ${importResults.skipped} ${t('oförändrade (hoppades över)', 'unchanged (skipped)')}`}
              {importResults.failed > 0 && `, ${importResults.failed} ${t('misslyckades', 'failed')}`}
            </p>
            
            {/* Delete file prompt */}
            {uploadedFileName && !fileDeleted && (
              <div className="bg-muted/50 border border-border rounded-lg p-4 mb-6 max-w-md mx-auto">
                <p className="text-sm text-muted-foreground mb-3">
                  {t('Vill du ta bort den uppladdade filen från din enhet?', 'Would you like to delete the uploaded file from your device?')}
                </p>
                <p className="text-xs text-muted-foreground mb-3 font-mono">{uploadedFileName}</p>
                <p className="text-xs text-muted-foreground italic">
                  {t('Tips: Du kan ta bort filen manuellt från din nedladdnings-/filhanterare.', 'Tip: You can delete the file manually from your downloads/file manager.')}
                </p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="mt-3"
                  onClick={() => setFileDeleted(true)}
                >
                  {t('Jag har raderat filen', 'I have deleted the file')}
                </Button>
              </div>
            )}
            
            {fileDeleted && (
              <p className="text-sm text-primary mb-6">
                <Check className="h-4 w-4 inline mr-1" />
                {t('Bra! Filen är markerad som borttagen.', 'Great! File marked as deleted.')}
              </p>
            )}
            
            <Button onClick={() => navigate('/portal/skus')}>
              {t('Visa SKU-katalog', 'View SKU catalog')}
            </Button>
          </Card>
        )}
      </div>
    </PortalLayout>
  );
};

export default SKUImport;
