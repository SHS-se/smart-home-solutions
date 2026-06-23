import React, { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, Download, Loader2, X } from "lucide-react";
import PdfCanvasViewer from "@/components/portal/quotes/PdfCanvasViewer";
import { supabase } from "@/integrations/supabase/client";

interface InvoicePdfModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string | null;
  invoiceNumber: string;
  /** Optional public token for unauthenticated access */
  publicToken?: string;
}

const InvoicePdfModal: React.FC<InvoicePdfModalProps> = ({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  publicToken,
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

  useEffect(() => {
    if (!open || !invoiceId) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setPdfBytes(null);
    cleanupDownloadUrl();

    (async () => {
      try {
        // Build the URL for get-invoice-pdf — supports both authenticated and public token
        const supabaseUrl = (supabase as unknown as { supabaseUrl?: string }).supabaseUrl || import.meta.env.VITE_SUPABASE_URL;
        let url = `${supabaseUrl}/functions/v1/get-invoice-pdf?invoice_id=${encodeURIComponent(invoiceId)}`;
        if (publicToken) {
          url += `&token=${encodeURIComponent(publicToken)}`;
        }

        const headers: Record<string, string> = {};
        if (!publicToken) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.access_token) {
            headers['Authorization'] = `Bearer ${session.access_token}`;
          }
        }
        headers['apikey'] = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

        const response = await fetch(url, { headers, cache: "no-store" });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to generate PDF: ${response.status}`);
        }

        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;

        setPdfBytes(new Uint8Array(buffer));

        const blobUrl = URL.createObjectURL(blob);
        downloadUrlRef.current = blobUrl;
        setDownloadBlobUrl(blobUrl);
      } catch (err) {
        if (cancelled) return;
        console.error("Error fetching PDF:", err);
        setError(err instanceof Error ? err.message : "Failed to load PDF");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, invoiceId, publicToken]);

  useEffect(() => {
    if (!open) {
      setPdfBytes(null);
      setError(null);
      cleanupDownloadUrl();
    }
  }, [open]);

  useEffect(() => {
    return () => { cleanupDownloadUrl(); };
  }, []);

  const handleDownload = () => {
    if (!downloadBlobUrl) return;
    const link = document.createElement("a");
    link.href = downloadBlobUrl;
    link.download = `Faktura-${invoiceNumber}.pdf`;
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
              {t('Förhandsgranska faktura', 'Preview Invoice')} #{invoiceNumber}
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
                {t("Kunde inte ladda PDF-förhandsgranskning.", "Could not load PDF preview.")}
              </p>
              <Button onClick={handleDownload} disabled={!downloadBlobUrl}>
                <Download className="h-4 w-4 mr-2" />
                {t("Ladda ner", "Download")}
              </Button>
            </div>
          ) : pdfBytes ? (
            <PdfCanvasViewer data={pdfBytes} className="h-full" />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {invoiceId
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
