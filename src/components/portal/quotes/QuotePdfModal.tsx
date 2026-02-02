import React, { useEffect, useState, useRef } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, X, ExternalLink, Loader2, AlertCircle } from 'lucide-react';

interface QuotePdfModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pdfUrl: string | null;
  quoteNumber: string;
}

const QuotePdfModal: React.FC<QuotePdfModalProps> = ({
  open,
  onOpenChange,
  pdfUrl,
  quoteNumber,
}) => {
  const { t } = useLanguage();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Fetch PDF and create blob URL when pdfUrl changes
  useEffect(() => {
    if (!open || !pdfUrl) {
      return;
    }

    const fetchPdf = async () => {
      setIsLoading(true);
      setError(null);
      
      // Revoke previous blob URL if exists
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }

      try {
        const response = await fetch(pdfUrl);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch PDF: ${response.status}`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
      } catch (err) {
        console.error('Error fetching PDF:', err);
        setError(err instanceof Error ? err.message : 'Failed to load PDF');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPdf();
  }, [open, pdfUrl]);

  // Cleanup blob URL on unmount or modal close
  useEffect(() => {
    if (!open && blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
      setBlobUrl(null);
      setError(null);
    }
  }, [open]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, []);

  const handleDownload = () => {
    const downloadUrl = blobUrl || pdfUrl;
    if (!downloadUrl) return;
    
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `quote-${quoteNumber}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleOpenInNewTab = () => {
    if (!pdfUrl) return;
    window.open(pdfUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[90vh] flex flex-col p-0">
        <DialogHeader className="p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle>
              {t('Förhandsgranska offert', 'Preview Quote')} #{quoteNumber}
            </DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!blobUrl && !pdfUrl}
              >
                <Download className="h-4 w-4 mr-2" />
                {t('Ladda ner', 'Download')}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span>{t('Laddar PDF...', 'Loading PDF...')}</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4 p-6">
              <AlertCircle className="h-12 w-12 text-destructive" />
              <p className="text-center">
                {t('Kunde inte ladda PDF-förhandsgranskning.', 'Could not load PDF preview.')}
              </p>
              <p className="text-sm text-center max-w-md">
                {t(
                  'Din webbläsare kan ha blockerat förhandsgranskningen. Prova att ladda ner filen eller öppna den i en ny flik.',
                  'Your browser may have blocked the preview. Try downloading the file or opening it in a new tab.'
                )}
              </p>
              <div className="flex gap-3 mt-2">
                <Button onClick={handleDownload} disabled={!pdfUrl}>
                  <Download className="h-4 w-4 mr-2" />
                  {t('Ladda ner', 'Download')}
                </Button>
                <Button variant="outline" onClick={handleOpenInNewTab} disabled={!pdfUrl}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('Öppna i ny flik', 'Open in new tab')}
                </Button>
              </div>
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              className="w-full h-full border-0"
              title={`Quote ${quoteNumber} PDF`}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {t('Ingen PDF tillgänglig', 'No PDF available')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuotePdfModal;
