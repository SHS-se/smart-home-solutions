import { useEffect, useRef, useState, useCallback } from 'react';
import mermaid from 'mermaid';
import { toPng } from 'html-to-image';
import PortalLayout from '@/components/portal/PortalLayout';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, RotateCcw, Download, ArrowRightLeft, ArrowDownUp } from 'lucide-react';

const getErdDiagram = (direction: 'TB' | 'LR') => `erDiagram
    direction ${direction}
    %% Staff & Auth
    staff_users {
        uuid user_id PK
        text role
        timestamptz created_at
    }

    %% Customers & Contacts
    customers {
        uuid id PK
        uuid user_id FK
        text org_name
        text billing_email
        text phone
        text address
        text site_address
        timestamptz created_at
    }

    contacts {
        uuid id PK
        text name
        text email
        text phone
        text message
        text email_token
        uuid converted_to_customer_id FK
        timestamptz converted_at
        timestamptz created_at
    }

    contact_messages {
        uuid id PK
        uuid contact_id FK
        text body
        text author_email
        text author_type
        text source
        timestamptz created_at
    }

    %% Ticketing System
    tickets {
        uuid id PK
        uuid customer_id FK
        uuid created_by FK
        text ticket_number
        text title
        text status
        text email_token
        timestamptz last_activity_at
        timestamptz created_at
        timestamptz updated_at
    }

    ticket_comments {
        uuid id PK
        uuid ticket_id FK
        uuid author_user_id FK
        text author_email
        text author_type
        text body_markdown
        text source
        timestamptz created_at
    }

    ticket_attachments {
        uuid id PK
        uuid ticket_id FK
        uuid comment_id FK
        text filename
        text storage_path
        text content_type
        bigint size_bytes
        timestamptz created_at
    }

    %% Billing
    invoices {
        uuid id PK
        uuid customer_id FK
        text external_id
        numeric amount
        text currency
        text status
        text pdf_url
        date date
        timestamptz created_at
    }

    %% SKU Catalog
    skus {
        uuid id PK
        text sku
        text name
        text category
        text supplier
        text supplier_url
        numeric cost_ex_vat
        numeric default_margin
        text image_path
        text notes
        timestamptz created_at
        timestamptz updated_at
    }

    sku_categories {
        uuid id PK
        text name
        text description
        int sort_order
        timestamptz created_at
        timestamptz updated_at
    }

    margin_rules {
        text category PK
        numeric margin_percent
        int rounding
        text description
        timestamptz created_at
        timestamptz updated_at
    }

    %% Templates
    templates {
        uuid id PK
        text name
        text description
        timestamptz created_at
        timestamptz updated_at
    }

    template_items {
        uuid id PK
        uuid template_id FK
        uuid sku_id FK
        int quantity
        timestamptz created_at
    }

    %% BOMs (Bill of Materials)
    boms {
        uuid id PK
        uuid customer_id FK
        uuid created_by FK
        text project_name
        int version
        timestamptz created_at
        timestamptz updated_at
    }

    bom_items {
        uuid id PK
        uuid bom_id FK
        uuid sku_id FK
        int quantity
        numeric cost
        numeric sell_price
        timestamptz created_at
    }

    %% Quotes
    quotes {
        uuid id PK
        uuid customer_id FK
        uuid bom_id FK
        uuid created_by FK
        text quote_number
        text status
        text stripe_quote_id
        numeric hardware_total
        numeric labor_total
        numeric travel_total
        timestamptz created_at
        timestamptz updated_at
    }

    quote_lines {
        uuid id PK
        uuid quote_id FK
        text section
        text description
        numeric quantity
        numeric unit_price
        timestamptz created_at
    }

    %% Relationships
    customers ||--o{ tickets : "has"
    customers ||--o{ invoices : "billed"
    customers ||--o{ boms : "owns"
    customers ||--o{ quotes : "receives"

    contacts ||--o{ contact_messages : "has"
    contacts }o--o| customers : "converts to"

    tickets ||--o{ ticket_comments : "has"
    tickets ||--o{ ticket_attachments : "has"
    ticket_comments ||--o{ ticket_attachments : "has"

    templates ||--o{ template_items : "contains"
    template_items }o--|| skus : "references"

    boms ||--o{ bom_items : "contains"
    bom_items }o--|| skus : "references"

    quotes ||--o{ quote_lines : "contains"
    quotes }o--o| boms : "from"
    quotes }o--o| customers : "for"
`;

const ERDiagram = () => {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  
  // Zoom and pan state
  const [scale, setScale] = useState(0.8);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [layoutDirection, setLayoutDirection] = useState<'TB' | 'LR'>('TB');

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      er: {
        useMaxWidth: false,
      },
    });

    const renderDiagram = async () => {
      if (diagramRef.current) {
        diagramRef.current.innerHTML = '';
        try {
          const diagramId = `erd-diagram-${layoutDirection}-${Date.now()}`;
          const { svg } = await mermaid.render(diagramId, getErdDiagram(layoutDirection));
          diagramRef.current.innerHTML = svg;
        } catch (error) {
          console.error('Failed to render Mermaid diagram:', error);
          diagramRef.current.innerHTML = '<p class="text-destructive">Failed to render diagram</p>';
        }
      }
    };

    renderDiagram();
  }, [layoutDirection]);

  // Zoom handlers
  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.2, 3));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.2, 0.2));
  const handleReset = () => {
    setScale(0.8);
    setPosition({ x: 0, y: 0 });
  };

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale(prev => Math.min(Math.max(prev + delta, 0.2), 3));
  }, []);

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) { // Left click only
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  }, [isDragging, dragStart]);

  const handleMouseUp = () => setIsDragging(false);
  const handleMouseLeave = () => setIsDragging(false);

  // Export to PNG
  const handleExport = async () => {
    if (!diagramRef.current) return;
    
    const svgElement = diagramRef.current.querySelector('svg');
    if (!svgElement) return;
    
    setIsExporting(true);
    try {
      // Clone the SVG to avoid modifying the original
      const clonedSvg = svgElement.cloneNode(true) as SVGSVGElement;
      
      // Inline all text styles to ensure visibility in export
      const textElements = clonedSvg.querySelectorAll('text, tspan');
      textElements.forEach((el) => {
        const computed = window.getComputedStyle(el as Element);
        (el as SVGElement).style.fill = computed.fill || '#ffffff';
        (el as SVGElement).style.fontSize = computed.fontSize;
        (el as SVGElement).style.fontFamily = computed.fontFamily;
      });
      
      // Get the actual bounding box of the SVG content
      const bbox = svgElement.getBBox();
      const padding = 20;
      
      // Set viewBox to crop to actual content
      clonedSvg.setAttribute('viewBox', `${bbox.x - padding} ${bbox.y - padding} ${bbox.width + padding * 2} ${bbox.height + padding * 2}`);
      clonedSvg.setAttribute('width', String(bbox.width + padding * 2));
      clonedSvg.setAttribute('height', String(bbox.height + padding * 2));
      
      // Add background rect
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('x', String(bbox.x - padding));
      bgRect.setAttribute('y', String(bbox.y - padding));
      bgRect.setAttribute('width', String(bbox.width + padding * 2));
      bgRect.setAttribute('height', String(bbox.height + padding * 2));
      bgRect.setAttribute('fill', '#1e1e2e');
      clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);
      
      // Create a temporary container
      const container = document.createElement('div');
      container.appendChild(clonedSvg);
      document.body.appendChild(container);
      
      const dataUrl = await toPng(clonedSvg as unknown as HTMLElement, {
        pixelRatio: 2,
      });
      
      // Cleanup
      document.body.removeChild(container);
      
      const link = document.createElement('a');
      link.download = 'database-erd.png';
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error('Failed to export diagram:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <PortalLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">
            {t('Databasschema (ERD)', 'Database Schema (ERD)')}
          </h1>
          <p className="text-muted-foreground">
            {t(
              'Visuell representation av databasstrukturen och relationer.',
              'Visual representation of the database structure and relationships.'
            )}
          </p>
        </div>

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
              <div className="flex items-center gap-2">
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
                  {layoutDirection === 'TB' ? (
                    <ArrowRightLeft className="h-4 w-4 mr-2" />
                  ) : (
                    <ArrowDownUp className="h-4 w-4 mr-2" />
                  )}
                  {layoutDirection === 'TB' ? t('Horisontell', 'Horizontal') : t('Vertikal', 'Vertical')}
                </Button>
                <Button variant="outline" onClick={handleExport} disabled={isExporting}>
                  <Download className="h-4 w-4 mr-2" />
                  {isExporting ? t('Exporterar...', 'Exporting...') : t('Exportera PNG', 'Export PNG')}
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
              <div
                ref={diagramRef}
                className="inline-block origin-top-left transition-transform duration-75"
                style={{
                  transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default ERDiagram;
