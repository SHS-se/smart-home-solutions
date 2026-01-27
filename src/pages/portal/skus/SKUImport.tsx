import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ArrowLeft, Upload, Download, Check, X, FileArchive } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import JSZip, { JSZipObject } from 'jszip';

interface ParsedSKU {
  sku: string;
  name: string;
  category: string;
  supplier: string;
  supplier_url: string;
  cost_ex_vat: string;
  default_margin: string;
  notes: string;
  hasImage: boolean;
  imageFile?: File;
  isValid: boolean;
  errors: string[];
}

const CATEGORIES = ['Sensorer', 'Controllers', 'Reläer', 'Material', 'Tjänst'];
const REQUIRED_COLUMNS = ['sku', 'name', 'category', 'supplier', 'supplier_url', 'cost_ex_vat', 'default_margin', 'notes'];

const SKUImport: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [parsedSkus, setParsedSkus] = useState<ParsedSKU[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importResults, setImportResults] = useState<{ success: number; failed: number }>({ success: 0, failed: 0 });

  const downloadTemplate = () => {
    const csvContent = `sku,name,category,supplier,supplier_url,cost_ex_vat,default_margin,notes
ZBT-2,Zigbee Temperature Sensor,Sensorer,Aqara,https://aqara.com,145,35,Requires Zigbee hub
ESP32-RELAY-4,ESP32 4-Channel Relay Module,Reläer,Shelly,,320,30,
HUB-ZB-PRO,Zigbee Hub Professional,Controllers,Aqara,https://aqara.com,1250,25,`;
    
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

  const validateSKU = (sku: Partial<ParsedSKU>): { isValid: boolean; errors: string[] } => {
    const errors: string[] = [];
    
    if (!sku.sku || sku.sku.length === 0) {
      errors.push(t('SKU-kod saknas', 'SKU code missing'));
    }
    if (!sku.name || sku.name.length === 0) {
      errors.push(t('Produktnamn saknas', 'Product name missing'));
    }
    if (!sku.category || !CATEGORIES.includes(sku.category)) {
      errors.push(t('Ogiltig kategori', 'Invalid category'));
    }
    
    return { isValid: errors.length === 0, errors };
  };

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

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

      const csvText = await csvFile.async('text');
      const rows = parseCSV(csvText);
      
      if (rows.length < 2) {
        throw new Error(t('CSV-filen är tom eller saknar data', 'CSV file is empty or missing data'));
      }

      const headers = rows[0].map(h => h.toLowerCase().trim());
      const dataRows = rows.slice(1);

      // Validate headers
      const missingHeaders = REQUIRED_COLUMNS.filter(col => !headers.includes(col));
      if (missingHeaders.length > 0) {
        throw new Error(`${t('Saknade kolumner', 'Missing columns')}: ${missingHeaders.join(', ')}`);
      }

      // Parse SKUs
      const parsed: ParsedSKU[] = dataRows.map(row => {
        const skuData: Partial<ParsedSKU> = {};
        headers.forEach((header, i) => {
          (skuData as any)[header] = row[i] || '';
        });

        const skuCode = skuData.sku?.toUpperCase() || '';
        const imageFile = imageFiles.get(skuCode);
        const { isValid, errors } = validateSKU(skuData);

        return {
          ...skuData,
          sku: skuCode,
          hasImage: !!imageFile,
          imageFile,
          isValid,
          errors,
        } as ParsedSKU;
      });

      setParsedSkus(parsed);
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
  }, [t]);

  const handleImport = async () => {
    setIsProcessing(true);
    let success = 0;
    let failed = 0;

    for (const sku of parsedSkus.filter(s => s.isValid)) {
      try {
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

        // Insert SKU
        const { error } = await supabase.from('skus').upsert({
          sku: sku.sku,
          name: sku.name,
          category: sku.category,
          supplier: sku.supplier || null,
          supplier_url: sku.supplier_url || null,
          cost_ex_vat: sku.cost_ex_vat ? parseFloat(sku.cost_ex_vat) : null,
          default_margin: sku.default_margin ? parseFloat(sku.default_margin) : null,
          notes: sku.notes || null,
          image_path: imagePath,
        }, { onConflict: 'sku' });

        if (error) throw error;
        success++;
      } catch {
        failed++;
      }
    }

    setImportResults({ success, failed });
    setStep(3);
    setIsProcessing(false);
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const validCount = parsedSkus.filter(s => s.isValid).length;
  const invalidCount = parsedSkus.filter(s => !s.isValid).length;

  return (
    <PortalLayout>
      <div className="space-y-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal/skus')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('Importera SKUs', 'Import SKUs')}</h1>
            <p className="text-muted-foreground">
              {t('Bulkimport av produkter med bilder från ZIP-fil', 'Bulk import of products with images from ZIP file')}
            </p>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-8">
          {[
            { num: 1, title: t('Ladda upp', 'Upload'), sub: 'ZIP-fil med data' },
            { num: 2, title: t('Granska', 'Review'), sub: 'Kontrollera data' },
            { num: 3, title: t('Slutför', 'Complete'), sub: 'Import klar' },
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
                    <p className="font-medium">{t('Ladda upp ZIP-fil', 'Upload ZIP file')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Systemet extraherar CSV-filen och matchar bilder baserat på SKU-namn', 'The system extracts the CSV file and matches images based on SKU name')}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-medium">3</div>
                  <div>
                    <p className="font-medium">{t('Granska & bekräfta', 'Review & confirm')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('Kontrollera att alla SKUs ser korrekta ut innan import', 'Verify that all SKUs look correct before import')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* CSV Format */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg">CSV-filformat</CardTitle>
                <Button variant="outline" size="sm" onClick={downloadTemplate}>
                  <Download className="h-4 w-4 mr-2" />
                  {t('Ladda ner mall', 'Download template')}
                </Button>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto">
{`sku,name,category,supplier,supplier_url,cost_ex_vat,default_margin,notes
ZBT-2,Zigbee Temperature Sensor,Sensorer,Aqara,https://aqara.com,145,35,Requires Zigbee hub
ESP32-RELAY-4,ESP32 4-Channel Relay Module,Reläer,Shelly,,320,30,
HUB-ZB-PRO,Zigbee Hub Professional,Controllers,Aqara,https://aqara.com,1250,25,`}
                </pre>
                <div className="mt-4 text-sm text-muted-foreground space-y-1">
                  <p><strong>{t('Observera', 'Note')}:</strong> {t('Första raden måste vara rubriker', 'First row must be headers')}</p>
                  <p><strong>{t('Kategorier', 'Categories')}:</strong> {CATEGORIES.join(', ')}</p>
                </div>
              </CardContent>
            </Card>

            {/* Image naming */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t('Bildfilnamn', 'Image filenames')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  {t('Bildfilerna måste ha samma namn som SKU-koden med filformat', 'Image files must have the same name as the SKU code with file extension')} <code className="bg-muted px-1 rounded">.jpg</code> {t('eller', 'or')} <code className="bg-muted px-1 rounded">.png</code>
                </p>
                <div className="space-y-1 text-sm">
                  <p className="text-primary"><Check className="h-3 w-3 inline mr-1" />ZBT-2.jpg</p>
                  <p className="text-primary"><Check className="h-3 w-3 inline mr-1" />ESP32-RELAY-4.png</p>
                  <p className="text-primary"><Check className="h-3 w-3 inline mr-1" />HUB-ZB-PRO.jpg</p>
                  <p className="text-destructive"><X className="h-3 w-3 inline mr-1" />zigbee sensor.jpg {t('(innehåller mellanslag)', '(contains spaces)')}</p>
                  <p className="text-destructive"><X className="h-3 w-3 inline mr-1" />zbt-2.jpg {t('(fel versaler/gemener)', '(wrong case)')}</p>
                </div>
              </CardContent>
            </Card>

            {/* Upload Area */}
            <Card>
              <CardContent className="p-8">
                <label 
                  className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg p-12 cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <FileArchive className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-medium">{t('Ladda upp ZIP-fil', 'Upload ZIP file')}</p>
                  <p className="text-sm text-muted-foreground mb-4">
                    {t('Dra och släpp din ZIP-fil här eller klicka för att välja', 'Drag and drop your ZIP file here or click to select')}
                  </p>
                  <span className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium border border-border bg-card hover:bg-muted hover:border-primary/30 text-foreground h-10 px-5 py-2 cursor-pointer">
                    {isProcessing ? t('Bearbetar...', 'Processing...') : t('Välj fil', 'Choose file')}
                  </span>
                  <p className="text-xs text-muted-foreground mt-2">{t('Maximal filstorlek: 50 MB', 'Maximum file size: 50 MB')}</p>
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
            <div className="flex items-center justify-between">
              <div className="flex gap-4">
                <Badge variant="secondary" className="text-sm">
                  {validCount} {t('giltiga', 'valid')}
                </Badge>
                {invalidCount > 0 && (
                  <Badge variant="destructive" className="text-sm">
                    {invalidCount} {t('ogiltiga', 'invalid')}
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>
                  {t('Tillbaka', 'Back')}
                </Button>
                <Button onClick={handleImport} disabled={validCount === 0 || isProcessing}>
                  {isProcessing ? t('Importerar...', 'Importing...') : t('Importera', 'Import')} ({validCount})
                </Button>
              </div>
            </div>

            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>{t('Namn', 'Name')}</TableHead>
                    <TableHead>{t('Kategori', 'Category')}</TableHead>
                    <TableHead>{t('Kostnad', 'Cost')}</TableHead>
                    <TableHead>{t('Bild', 'Image')}</TableHead>
                    <TableHead>{t('Status', 'Status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedSkus.map((sku, i) => (
                    <TableRow key={i} className={!sku.isValid ? 'bg-destructive/10' : ''}>
                      <TableCell className="font-mono">{sku.sku}</TableCell>
                      <TableCell>{sku.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{sku.category}</Badge>
                      </TableCell>
                      <TableCell>{sku.cost_ex_vat ? `${sku.cost_ex_vat} kr` : '—'}</TableCell>
                      <TableCell>
                        {sku.hasImage ? (
                          <Check className="h-4 w-4 text-primary" />
                        ) : (
                          <X className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        {sku.isValid ? (
                          <Badge variant="secondary" className="bg-primary/10 text-primary">
                            {t('Redo', 'Ready')}
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            {sku.errors.join(', ')}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
            <p className="text-muted-foreground mb-6">
              {importResults.success} {t('SKUs importerade', 'SKUs imported')}
              {importResults.failed > 0 && `, ${importResults.failed} ${t('misslyckades', 'failed')}`}
            </p>
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
