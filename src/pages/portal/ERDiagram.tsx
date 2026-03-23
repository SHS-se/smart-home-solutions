import { useEffect, useRef, useState, useCallback } from 'react';
import mermaid from 'mermaid';
import PortalLayout from '@/components/portal/PortalLayout';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, RotateCcw, Download, ArrowRightLeft, ArrowDownUp, Loader2, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const ERDiagram = () => {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  
  const [scale, setScale] = useState(0.8);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [layoutDirection, setLayoutDirection] = useState<'TB' | 'LR'>('TB');
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [erdSource, setErdSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envCheckLoading, setEnvCheckLoading] = useState(false);
  const [envResults, setEnvResults] = useState<{ app_env: string; stripe_key_prefix: string } | null>(null);

  const handleCheckEnv = async () => {
    setEnvCheckLoading(true);
    setEnvResults(null);
    try {
      const response = await supabase.functions.invoke('check-env');
      if (response.error) throw new Error(response.error.message);
      setEnvResults(response.data);
    } catch (err: any) {
      toast.error('Failed to check env: ' + err.message);
    } finally {
      setEnvCheckLoading(false);
    }
  };

  // Fetch ERD from edge function
  const fetchErd = useCallback(async (direction: 'TB' | 'LR') => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await supabase.functions.invoke('get-schema-erd', {
        body: { direction },
      });

      if (response.error) throw new Error(response.error.message);
      if (response.data?.error) throw new Error(response.data.error);
      
      setErdSource(response.data.erd);
    } catch (err: any) {
      console.error('Failed to fetch ERD:', err);
      setError(err.message || 'Failed to load schema');
      toast.error(t('Kunde inte hämta schema', 'Failed to fetch schema'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchErd(layoutDirection);
  }, [layoutDirection, fetchErd]);

  // Render mermaid when source changes
  useEffect(() => {
    if (!erdSource || !diagramRef.current) return;

    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      er: { useMaxWidth: false },
      // Use native SVG text instead of foreignObject HTML so PNG export works
      htmlLabels: false,
    });

    const renderDiagram = async () => {
      if (!diagramRef.current) return;
      diagramRef.current.innerHTML = '';
      try {
        const diagramId = `erd-diagram-${Date.now()}`;
        const { svg } = await mermaid.render(diagramId, erdSource);
        diagramRef.current.innerHTML = svg;
        setRenderedSvg(svg);
      } catch (err) {
        console.error('Failed to render Mermaid diagram:', err);
        diagramRef.current.innerHTML = '<p class="text-destructive">Failed to render diagram</p>';
      }
    };

    renderDiagram();
  }, [erdSource]);

  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.2, 3));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.2, 0.2));
  const handleReset = () => { setScale(0.8); setPosition({ x: 0, y: 0 }); };

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale(prev => Math.min(Math.max(prev + delta, 0.2), 3));
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  }, [isDragging, dragStart]);

  const handleMouseUp = () => setIsDragging(false);
  const handleMouseLeave = () => setIsDragging(false);

  const handleExportSvg = () => {
    if (!renderedSvg) return;

    const blob = new Blob([renderedSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = 'database-erd.svg';
    link.click();

    URL.revokeObjectURL(url);
  };

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">
              {t('Databasschema (ERD)', 'Database Schema (ERD)')}
            </h1>
            <p className="text-muted-foreground">
              {t(
                'Visuell representation av databasstrukturen och relationer — hämtas live från databasen.',
                'Visual representation of the database structure and relationships — fetched live from the database.'
              )}
            </p>
          </div>
          <Button variant="outline" onClick={handleCheckEnv} disabled={envCheckLoading}>
            {envCheckLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Check Env Details
          </Button>
        </div>

        {envResults && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm font-medium mb-1">Current Environment (this edge function instance):</p>
              <div className="font-mono text-sm space-y-1 bg-muted/50 p-3 rounded-md">
                <p><span className="text-muted-foreground">APP_ENV:</span> <span className="font-semibold">{envResults.app_env}</span></p>
                <p><span className="text-muted-foreground">STRIPE_SECRET_KEY:</span> <span className="font-semibold">{envResults.stripe_key_prefix}</span></p>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Note: This shows the secrets for the environment where the edge function is running. 
                To check the other environment, open this page on the {envResults.app_env === 'test' ? 'published (live)' : 'preview (test)'} site.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <CardTitle>{t('Entity Relationship Diagram', 'Entity Relationship Diagram')}</CardTitle>
                <CardDescription>
                  {t(
                    'Använd musen för att panorera. Scrolla för att zooma.',
                    'Use mouse to pan. Scroll to zoom.'
                  )}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="outline" size="icon" onClick={() => fetchErd(layoutDirection)} disabled={isLoading} title={t('Uppdatera', 'Refresh')}>
                  <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                </Button>
                <Button variant="outline" size="icon" onClick={handleZoomOut} title={t('Zooma ut', 'Zoom out')}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground min-w-[4rem] text-center">
                  {Math.round(scale * 100)}%
                </span>
                <Button variant="outline" size="icon" onClick={handleZoomIn} title={t('Zooma in', 'Zoom in')}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={handleReset} title={t('Återställ', 'Reset')}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => setLayoutDirection(prev => prev === 'TB' ? 'LR' : 'TB')}
                  title={layoutDirection === 'TB' ? t('Byt till horisontell layout', 'Switch to horizontal layout') : t('Byt till vertikal layout', 'Switch to vertical layout')}
                >
                  {layoutDirection === 'TB' ? <ArrowRightLeft className="h-4 w-4 mr-2" /> : <ArrowDownUp className="h-4 w-4 mr-2" />}
                  {layoutDirection === 'TB' ? t('Horisontell', 'Horizontal') : t('Vertikal', 'Vertical')}
                </Button>
                <Button variant="outline" onClick={handleExportSvg} disabled={!renderedSvg || isLoading}>
                  <Download className="h-4 w-4 mr-2" />
                  {t('Exportera SVG', 'Export SVG')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div 
              ref={containerRef}
              className="overflow-hidden h-[70vh] bg-muted/30 rounded-lg cursor-grab active:cursor-grabbing"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
            >
              {isLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  <span className="ml-3 text-muted-foreground">{t('Hämtar schema...', 'Fetching schema...')}</span>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center h-full gap-4">
                  <p className="text-destructive">{error}</p>
                  <Button variant="outline" onClick={() => fetchErd(layoutDirection)}>
                    {t('Försök igen', 'Try again')}
                  </Button>
                </div>
              ) : (
                <div
                  ref={diagramRef}
                  className="inline-block origin-top-left transition-transform duration-75"
                  style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
                />
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default ERDiagram;
