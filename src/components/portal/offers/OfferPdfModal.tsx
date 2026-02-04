import React, { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, Download, ExternalLink, Loader2, X } from "lucide-react";
import PdfCanvasViewer from "@/components/portal/quotes/PdfCanvasViewer";
import { supabase } from "@/integrations/supabase/client";

interface OfferPdfModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: string | null;
  quoteNumber: string;
}

const OfferPdfModal: React.FC<OfferPdfModalProps> = ({ 
  open, 
  onOpenChange, 
  quoteId, 
  quoteNumber 
}) => {
  const { t } = useLanguage();
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [downloadBlobUrl, setDownloadBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const downloadUrlRef = useRef<string | null>(null);

  const cleanupDownloadUrl = () => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setDownloadBlobUrl(null);
  };

  // Fetch PDF when modal opens
  useEffect(() => {
    if (!open || !quoteId) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setPdfBytes(null);
    cleanupDownloadUrl();

    (async () => {
      try {
        // Call edge function to get signed URL
        const { data, error: fnError } = await supabase.functions.invoke('get-stripe-quote-pdf', {
          body: { quoteId },
        });

        if (fnError) throw fnError;
        if (!data?.url) throw new Error("No PDF URL returned");

        // Fetch the actual PDF
        const response = await fetch(data.url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to fetch PDF: ${response.status}`);
        }

        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;

        setPdfBytes(new Uint8Array(buffer));

        const url = URL.createObjectURL(blob);
        downloadUrlRef.current = url;
        setDownloadBlobUrl(url);
      } catch (err) {
        if (cancelled) return;
        console.error("Error fetching PDF:", err);
        setError(err instanceof Error ? err.message : "Failed to load PDF");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, quoteId]);

  // Cleanup on close/unmount
  useEffect(() => {
    if (!open) {
      setPdfBytes(null);
      setError(null);
      cleanupDownloadUrl();
    }
  }, [open]);

  useEffect(() => {
    return () => {
      cleanupDownloadUrl();
    };
  }, []);

  const handleDownload = () => {
    if (!downloadBlobUrl) return;
    const link = document.createElement("a");
    link.href = downloadBlobUrl;
    link.download = `offert-${quoteNumber}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[90vh] flex flex-col p-0" hideClose>
        <DialogHeader className="p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle>
              {t('Offert', 'Offer')} #{quoteNumber}
            </DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!downloadBlobUrl}
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
              <span>{t("Laddar PDF...", "Loading PDF...")}</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4 p-6">
              <AlertCircle className="h-12 w-12 text-destructive" />
              <p className="text-center">
                {t("Kunde inte ladda PDF.", "Could not load PDF.")}
              </p>
              <p className="text-sm text-center max-w-md text-muted-foreground">
                {error}
              </p>
            </div>
          ) : pdfBytes ? (
            <PdfCanvasViewer data={pdfBytes} className="h-full" />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {t("Ingen PDF tillgänglig", "No PDF available")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default OfferPdfModal;
