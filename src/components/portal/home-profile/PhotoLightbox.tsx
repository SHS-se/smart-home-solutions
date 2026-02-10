import React, { useState, useRef, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

interface PhotoLightboxProps {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PhotoLightbox: React.FC<PhotoLightboxProps> = ({ src, alt, open, onOpenChange }) => {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const handleOpenChange = (v: boolean) => {
    if (!v) resetView();
    onOpenChange(v);
  };

  const zoomIn = () => setScale(s => Math.min(s * 1.5, 6));
  const zoomOut = () => setScale(s => Math.max(s / 1.5, 0.5));

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (scale > 1) {
      dragging.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setTranslate(t => ({ x: t.x + dx, y: t.y + dy }));
  };

  const handlePointerUp = () => {
    dragging.current = false;
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 bg-background/95 backdrop-blur-sm border-none overflow-hidden [&>button]:hidden">
        <div className="absolute top-2 right-2 z-10 flex gap-1">
          <Button variant="ghost" size="icon" onClick={zoomIn} className="bg-background/60 hover:bg-background/80">
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={zoomOut} className="bg-background/60 hover:bg-background/80">
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={resetView} className="bg-background/60 hover:bg-background/80">
            <RotateCcw className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => handleOpenChange(false)} className="bg-background/60 hover:bg-background/80">
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div
          className="w-full h-[90vh] flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="max-w-full max-h-full object-contain select-none"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transition: dragging.current ? 'none' : 'transform 0.15s ease-out',
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PhotoLightbox;
