import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Upload, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Eye, EyeOff, Trash2 } from 'lucide-react';
import type { WordPosition } from '@/lib/document-extraction';
import { computeFitScale, effectiveScaleFor } from '@/lib/document-preview-zoom';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Props {
  file?: File | null;
  fileUrl?: string | null;
  fileName?: string | null;
  onFileSelect?: (file: File) => void;
  onFilesSelect?: (files: File[]) => void;
  onFileClear?: () => void;
  ocrWords?: WordPosition[];
  isExtracting?: boolean;
  extractionProgress?: { message: string; pct: number };
  allowMultiple?: boolean;
}

const DocumentPreview: React.FC<Props> = ({
  file = null,
  fileUrl: externalFileUrl = null,
  fileName = null,
  onFileSelect,
  onFilesSelect,
  onFileClear,
  ocrWords = [],
  isExtracting = false,
  extractionProgress = { message: '', pct: 0 },
  allowMultiple = false,
}) => {
  const { t } = useLanguage();
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [autoScale, setAutoScale] = useState(true);
  const [showOverlay, setShowOverlay] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [pageSize, setPageSize] = useState({ w: 0, h: 0 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const resolvedFileName = file?.name || fileName || externalFileUrl || '';
  const isPdf = file?.type === 'application/pdf' || resolvedFileName.toLowerCase().endsWith('.pdf');
  const canSelectFile = !!onFileSelect || !!onFilesSelect;
  const canClearFile = !!onFileClear;

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setFileUrl(url);
      setCurrentPage(1);
      setScale(1.0);
      setAutoScale(true);
      return () => URL.revokeObjectURL(url);
    }

    setFileUrl(externalFileUrl);
    setCurrentPage(1);
    setScale(1.0);
    setAutoScale(true);
  }, [file, externalFileUrl]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    const updateSize = () => {
      setContainerSize({
        w: element.clientWidth,
        h: element.clientHeight,
      });
    };

    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fileUrl]);

  const contentSize = isPdf ? pageSize : naturalSize;
  const fitScale = autoScale ? computeFitScale(containerSize, contentSize) : null;
  const effectiveScale = effectiveScaleFor(autoScale, fitScale, scale);
  const displayedImageWidth = naturalSize.w > 0 ? naturalSize.w * effectiveScale : undefined;
  const displayedPdfWidth = pageSize.w > 0 ? Math.max(1, Math.floor(pageSize.w * effectiveScale)) : undefined;

  const handleZoomOut = () => {
    setAutoScale(false);
    setScale(Math.max(0.5, effectiveScale - 0.25));
  };

  const handleZoomIn = () => {
    setAutoScale(false);
    setScale(Math.min(3, effectiveScale + 0.25));
  };

  const handleAutoScale = () => {
    setAutoScale(true);
  };

  const handleSelectedFiles = useCallback((selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;
    if (selectedFiles.length > 1 && onFilesSelect) {
      onFilesSelect(selectedFiles);
      return;
    }
    if (selectedFiles[0] && onFileSelect) onFileSelect(selectedFiles[0]);
  }, [onFileSelect, onFilesSelect]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!onFileSelect && !onFilesSelect) return;
    e.preventDefault();
    handleSelectedFiles(Array.from(e.dataTransfer.files || []));
  }, [handleSelectedFiles, onFileSelect, onFilesSelect]);
  const triggerFileInput = () => document.getElementById('doc-upload-input')?.click();

  const fileInput = canSelectFile ? (
    <input id="doc-upload-input" type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" multiple={allowMultiple}
      onChange={(e) => { handleSelectedFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
  ) : null;

  if (!fileUrl) {
    return (
      <div className={`flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-16 h-full min-h-[400px] transition-colors ${canSelectFile ? 'cursor-pointer hover:border-primary/40 hover:bg-muted/30' : ''}`}
        onDragOver={(e) => canSelectFile && e.preventDefault()} onDrop={onDrop} onClick={() => canSelectFile && triggerFileInput()}>
        <Upload className="w-12 h-12 text-muted-foreground mb-4" />
        <p className="text-sm font-medium text-foreground">
          {allowMultiple
            ? t('Dra och släpp dokument här', 'Drag and drop documents here')
            : t('Dra och släpp dokument här', 'Drag and drop document here')}
        </p>
        <p className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG {t('eller', 'or')} HEIC</p>
        {fileInput}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border border-border rounded-xl overflow-hidden bg-muted/20">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background shrink-0">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleZoomOut}><ZoomOut className="h-3.5 w-3.5" /></Button>
          <span className="text-xs w-10 text-center tabular-nums text-muted-foreground">{Math.round(effectiveScale * 100)}%</span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleZoomIn}><ZoomIn className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant={autoScale ? 'outline' : 'ghost'} className="h-7 px-2 text-xs" onClick={handleAutoScale}>
            {t('Auto', 'Auto')}
          </Button>
        </div>
        {isPdf && numPages > 1 && (
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={currentPage <= 1} onClick={() => setCurrentPage(p => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <span className="text-xs tabular-nums text-muted-foreground">{currentPage} / {numPages}</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={currentPage >= numPages} onClick={() => setCurrentPage(p => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
          </div>
        )}
        <div className="flex items-center gap-1">
          {!isPdf && ocrWords.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setShowOverlay(!showOverlay)}>
              {showOverlay ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showOverlay ? t('Dölj text', 'Hide text') : t('Visa text', 'Show text')}
            </Button>
          )}
          {canClearFile && (
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onFileClear}>
              <Trash2 className="h-3 w-3" /> {t('Rensa fil', 'Clear file')}
            </Button>
          )}
        </div>
        {fileInput}
      </div>

      <div ref={containerRef} className="flex-1 overflow-auto flex items-start justify-center p-4 relative min-h-0">
        {isExtracting && (
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center gap-3">
            <div className="animate-pulse"><p className="text-sm font-medium text-foreground">{extractionProgress.message || t('Analyserar dokument...', 'Analyzing document...')}</p></div>
            <Progress value={extractionProgress.pct} className="w-48 h-2" />
          </div>
        )}
        {isPdf ? (
          <Document file={fileUrl} onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            loading={<p className="text-sm text-muted-foreground p-8">{t('Laddar PDF...', 'Loading PDF...')}</p>}
            error={<p className="text-sm text-destructive p-8">{t('Kunde inte ladda PDF', 'Could not load PDF')}</p>}>
            <Page
              pageNumber={currentPage}
              width={displayedPdfWidth}
              renderTextLayer={true}
              renderAnnotationLayer={false}
              loading={null}
              onLoadSuccess={(page) => {
                setPageSize({
                  w: page.originalWidth || page.width,
                  h: page.originalHeight || page.height,
                });
              }}
            />
          </Document>
        ) : (
          <div className="relative inline-block" style={{ width: displayedImageWidth ? `${displayedImageWidth}px` : undefined }}>
            <img src={fileUrl} alt={t('Dokument', 'Document')}
              onLoad={(e) => { const img = e.target as HTMLImageElement; setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight }); }}
              className="block w-full select-none" draggable={false} />
            {ocrWords.length > 0 && naturalSize.w > 0 && (
              <div className="absolute inset-0" style={{ pointerEvents: 'auto' }}>
                {ocrWords.map((word, i) => (
                  <span key={i} className="absolute select-text cursor-text" style={{
                    left: `${(word.x / naturalSize.w) * 100}%`, top: `${(word.y / naturalSize.h) * 100}%`,
                    width: `${(word.width / naturalSize.w) * 100}%`, height: `${(word.height / naturalSize.h) * 100}%`,
                    fontSize: `${Math.max(8, word.height * 0.75)}px`, lineHeight: 1,
                    color: showOverlay ? 'hsl(var(--foreground) / 0.8)' : 'transparent',
                    backgroundColor: showOverlay ? 'hsl(var(--primary) / 0.1)' : 'transparent',
                    pointerEvents: 'auto',
                  }}>{word.text}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DocumentPreview;
