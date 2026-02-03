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

interface InvoicePdfModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stripeInvoiceId: string | null;
  invoiceNumber: string;
}

const InvoicePdfModal: React.FC<InvoicePdfModalProps> = ({ 
  open, 
  onOpenChange, 
  stripeInvoiceId, 
  invoiceNumber 
}) => {
  const { t } = useLanguage();
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
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

  // Fetch PDF bytes when modal opens and stripeInvoiceId is present.
  useEffect(() => {
    if (!open || !stripeInvoiceId) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setPdfBytes(null);
    setPdfUrl(null);
    cleanupDownloadUrl();

    (async () => {
      try {
        // Call edge function to get signed URL
        const { data, error: fnError } = await supabase.functions.invoke('get-stripe-invoice-pdf', {
          body: { stripe_invoice_id: stripeInvoiceId },
        });

        if (fnError) throw fnError;
        if (data?.error) throw new Error(data.error);

        const signedUrl = data.url;
        if (!signedUrl) throw new Error("No PDF URL returned");

        if (cancelled) return;
        setPdfUrl(signedUrl);

        // Fetch the PDF bytes
        const response = await fetch(signedUrl, { cache: "no-store" });
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
  }, [open, stripeInvoiceId]);

  // Cleanup on close/unmount
  useEffect(() => {
    if (!open) {
      setPdfBytes(null);
      setPdfUrl(null);
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
    const url = downloadBlobUrl || pdfUrl;
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = `invoice-${invoiceNumber}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleOpenInNewTab = () => {
    if (!pdfUrl) return;
    window.open(pdfUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[90vh] flex flex-col p-0" hideClose>
        <DialogHeader className="p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle>
              {t('Förhandsgranska faktura', 'Preview Invoice')} #{invoiceNumber}
            </DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!downloadBlobUrl && !pdfUrl}
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
                {t("Kunde inte ladda PDF-förhandsgranskning.", "Could not load PDF preview.")}
              </p>
              <p className="text-sm text-center max-w-md">
                {t(
                  "Din webbläsare kan ha blockerat förhandsgranskningen. Prova att ladda ner filen eller öppna den i en ny flik.",
                  "Your browser may have blocked the preview. Try downloading the file or opening it in a new tab."
                )}
              </p>
              <div className="flex gap-3 mt-2">
                <Button onClick={handleDownload} disabled={!pdfUrl}>
                  <Download className="h-4 w-4 mr-2" />
                  {t("Ladda ner", "Download")}
                </Button>
                <Button variant="outline" onClick={handleOpenInNewTab} disabled={!pdfUrl}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t("Öppna i ny flik", "Open in new tab")}
                </Button>
              </div>
            </div>
          ) : pdfBytes ? (
            <PdfCanvasViewer data={pdfBytes} className="h-full" />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {stripeInvoiceId
                ? t("Laddar PDF...", "Loading PDF...")
                : t("Ingen PDF tillgänglig", "No PDF available")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InvoicePdfModal;
