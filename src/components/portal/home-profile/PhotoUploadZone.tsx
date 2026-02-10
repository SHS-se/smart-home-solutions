import React, { useCallback, useRef, useState } from 'react';
import { Upload, Loader2, Camera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { processImage, ACCEPTED_IMAGE_TYPES, ACCEPTED_MIME_TYPES } from '@/lib/image-processing';
import { cn } from '@/lib/utils';

interface UploadingFile {
  id: string;
  name: string;
  thumbnailUrl?: string;
  progress: 'processing' | 'uploading' | 'done' | 'error';
  error?: string;
}

interface PhotoUploadZoneProps {
  onFileProcessed: (blob: Blob, width: number, height: number, originalFilename: string) => Promise<void>;
  disabled?: boolean;
}

const PhotoUploadZone: React.FC<PhotoUploadZoneProps> = ({ onFileProcessed, disabled }) => {
  const { t } = useLanguage();
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f =>
      ACCEPTED_MIME_TYPES.includes(f.type) ||
      f.name.toLowerCase().match(/\.(jpg|jpeg|png|heic|heif|webp)$/)
    );
    if (fileArray.length === 0) return;

    const newEntries: UploadingFile[] = fileArray.map(f => ({
      id: crypto.randomUUID(),
      name: f.name,
      progress: 'processing' as const,
    }));
    setUploadingFiles(prev => [...prev, ...newEntries]);

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      const entry = newEntries[i];
      try {
        const { blob, width, height, originalFilename } = await processImage(file);

        // Create thumbnail preview
        const thumbUrl = URL.createObjectURL(blob);
        setUploadingFiles(prev =>
          prev.map(u => u.id === entry.id ? { ...u, thumbnailUrl: thumbUrl, progress: 'uploading' } : u)
        );

        await onFileProcessed(blob, width, height, originalFilename);

        setUploadingFiles(prev =>
          prev.map(u => u.id === entry.id ? { ...u, progress: 'done' } : u)
        );

        // Remove after short delay
        setTimeout(() => {
          setUploadingFiles(prev => prev.filter(u => u.id !== entry.id));
          URL.revokeObjectURL(thumbUrl);
        }, 1500);
      } catch (err: any) {
        console.error('Image processing error:', err);
        setUploadingFiles(prev =>
          prev.map(u => u.id === entry.id ? { ...u, progress: 'error', error: err.message } : u)
        );
        // Remove error after a few seconds
        setTimeout(() => {
          setUploadingFiles(prev => prev.filter(u => u.id !== entry.id));
        }, 4000);
      }
    }
  }, [onFileProcessed]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (!disabled && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, [disabled, processFiles]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  };

  const isProcessing = uploadingFiles.some(u => u.progress === 'processing' || u.progress === 'uploading');

  if (isMobile) {
    return (
      <div className="space-y-3">
        <input
          type="file"
          accept={ACCEPTED_IMAGE_TYPES}
          multiple
          ref={fileInputRef}
          className="hidden"
          onChange={handleInputChange}
        />
        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isProcessing}
          className="w-full"
        >
          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Camera className="w-4 h-4 mr-2" />}
          {t('Ladda upp foton', 'Upload photos')}
        </Button>
        {uploadingFiles.length > 0 && (
          <UploadThumbnails files={uploadingFiles} onRemove={(id) => setUploadingFiles(prev => prev.filter(u => u.id !== id))} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple
        ref={fileInputRef}
        className="hidden"
        onChange={handleInputChange}
      />
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
          isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-muted/30',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t(
            'Dra och släpp foton här, eller klicka för att välja',
            'Drag and drop photos here, or click to select'
          )}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          JPG, PNG, HEIC, WebP
        </p>
      </div>
      {uploadingFiles.length > 0 && (
        <UploadThumbnails files={uploadingFiles} onRemove={(id) => setUploadingFiles(prev => prev.filter(u => u.id !== id))} />
      )}
    </div>
  );
};

const UploadThumbnails: React.FC<{ files: UploadingFile[]; onRemove: (id: string) => void }> = ({ files, onRemove }) => {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap gap-2">
      {files.map(f => (
        <div key={f.id} className="relative w-16 h-16 rounded-md border bg-muted overflow-hidden">
          {f.thumbnailUrl ? (
            <img src={f.thumbnailUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {f.progress === 'uploading' && (
            <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
            </div>
          )}
          {f.progress === 'done' && (
            <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
              <span className="text-primary text-lg">✓</span>
            </div>
          )}
          {f.progress === 'error' && (
            <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center cursor-pointer" onClick={() => onRemove(f.id)}>
              <X className="w-4 h-4 text-destructive" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default PhotoUploadZone;
