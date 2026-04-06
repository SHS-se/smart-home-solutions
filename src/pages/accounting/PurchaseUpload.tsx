import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import DocumentPreview from '@/components/accounting/DocumentPreview';
import PurchaseUploadForm from '@/components/accounting/PurchaseUploadForm';
import { extractDocumentContent, type ExtractionResult } from '@/lib/document-extraction';
import { parseInvoiceText, type ParsedInvoice } from '@/lib/invoice-parser';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

const PurchaseUpload: React.FC = () => {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [progress, setProgress] = useState({ message: '', pct: 0 });
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [parsedInvoice, setParsedInvoice] = useState<ParsedInvoice | null>(null);

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setIsExtracting(true);
    setExtractionResult(null);
    setParsedInvoice(null);
    setProgress({ message: 'Analyserar dokument...', pct: 10 });

    try {
      const result = await extractDocumentContent(selectedFile, (msg, pct) => {
        setProgress({ message: msg, pct });
      });
      setExtractionResult(result);

      setProgress({ message: 'Tolkar innehåll...', pct: 90 });
      const parsed = parseInvoiceText(result.rawText);
      setParsedInvoice(parsed);
      setProgress({ message: 'Klar', pct: 100 });
    } catch (err) {
      console.error('Document extraction error:', err);
      setProgress({ message: 'Kunde inte analysera dokumentet', pct: 0 });
    } finally {
      setIsExtracting(false);
    }
  }, []);

  return (
    <AccountingLayout>
      <div className="space-y-4 h-full">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate('/accounting/purchases')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Ladda upp inköp</h1>
            <p className="text-muted-foreground text-sm">Registrera leverantörsfaktura eller kvitto</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6" style={{ minHeight: 'calc(100vh - 240px)' }}>
          <div className="lg:col-span-3 min-h-[400px]">
            <DocumentPreview
              file={file}
              onFileSelect={handleFileSelect}
              ocrWords={extractionResult?.words || []}
              isExtracting={isExtracting}
              extractionProgress={progress}
            />
          </div>
          <div className="lg:col-span-2">
            <PurchaseUploadForm
              file={file}
              parsedInvoice={parsedInvoice}
              extractedText={extractionResult?.rawText || null}
            />
          </div>
        </div>
      </div>
    </AccountingLayout>
  );
};

export default PurchaseUpload;
