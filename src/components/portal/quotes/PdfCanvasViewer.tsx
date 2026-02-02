import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

// pdfjs-dist v4+ ships ESM worker.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";

// Configure worker once per bundle.
// Vite can resolve node_modules paths via new URL(..., import.meta.url).
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

type Props = {
  data: Uint8Array;
  className?: string;
};

const PdfCanvasViewer: React.FC<Props> = ({ data, className }) => {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  const dataKey = useMemo(() => {
    // Create a stable-ish key to rerun rendering when bytes change.
    // (Using length + a few bytes avoids expensive hashing.)
    const len = data?.length ?? 0;
    const a = len > 0 ? data[0] : 0;
    const b = len > 1 ? data[1] : 0;
    const c = len > 2 ? data[2] : 0;
    return `${len}-${a}-${b}-${c}`;
  }, [data]);

  useEffect(() => {
    const handleResize = () => {
      // Debounce by next frame
      requestAnimationFrame(() => setRenderTick((v) => v + 1));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: PDFDocumentProxy | null = null;

    const clearContainer = () => {
      const el = containerRef.current;
      if (!el) return;
      // Remove canvases to free memory.
      el.replaceChildren();
    };

    const render = async () => {
      setIsRendering(true);
      setError(null);
      clearContainer();

      try {
        const loadingTask = getDocument({ data });
        pdfDoc = await loadingTask.promise;
        if (cancelled) return;

        setNumPages(pdfDoc.numPages);

        const host = containerRef.current;
        if (!host) return;

        const hostWidth = Math.max(320, host.clientWidth || 0);

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
          if (cancelled) return;

          const page = await pdfDoc.getPage(pageNum);
          const viewport1 = page.getViewport({ scale: 1 });
          const scale = hostWidth / viewport1.width;
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.className = "w-full rounded-md border border-border";

          const ctx = canvas.getContext("2d");
          if (!ctx) continue;

          host.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "Failed to render PDF";
        setError(message);
      } finally {
        if (!cancelled) setIsRendering(false);
      }
    };

    render();

    return () => {
      cancelled = true;
      try {
        pdfDoc?.destroy();
      } catch {
        // noop
      }
      clearContainer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, renderTick]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground p-6 h-full">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div className="text-center">
          <p>{t("Kunde inte rendera PDF.", "Could not render PDF.")}</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col overflow-hidden ${className ?? ""}`}>
      {isRendering && (
        <div className="flex-shrink-0 z-10 bg-background/80 backdrop-blur border-b border-border px-4 py-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            {t("Renderar PDF...", "Rendering PDF...")}
            {typeof numPages === "number" ? ` (${numPages} ${t("sidor", "pages")})` : ""}
          </span>
        </div>
      )}
      <div ref={containerRef} className="flex-1 p-4 space-y-4 overflow-y-auto" />
    </div>
  );
};

export default PdfCanvasViewer;
