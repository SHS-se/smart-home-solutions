import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, X } from 'lucide-react';

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

  const handleDownload = () => {
    if (!pdfUrl) return;
    
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = `quote-${quoteNumber}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
                disabled={!pdfUrl}
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
          {pdfUrl ? (
            <iframe
              src={pdfUrl}
              className="w-full h-full border-0"
              title={`Quote ${quoteNumber} PDF`}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {t('Laddar PDF...', 'Loading PDF...')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuotePdfModal;
