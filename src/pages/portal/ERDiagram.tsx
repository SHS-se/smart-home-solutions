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
        text name
        uuid contact_id FK
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

    %% SKU Catalog
    skus {
        uuid id PK
        uuid category_id FK
        text sku
        text name
        text supplier
        text supplier_url
        numeric purchase_price
        boolean purchase_includes_vat
        numeric vat_rate
        numeric cost_ex_vat_computed
        numeric sell_price_ex_vat
        numeric sell_price_inc_vat
        numeric effective_margin_percent
        int effective_rounding_sek
        numeric margin_override_percent
        int rounding_override_sek
        text image_path
        text notes
        timestamptz pricing_updated_at
        timestamptz created_at
        timestamptz updated_at
    }

    sku_categories {
        uuid id PK
        text key UK "machine identifier"
        text name
        text description
        int sort_order
        timestamptz created_at
        timestamptz updated_at
    }

    margin_rules {
        uuid category_id PK,FK
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

    %% Quotes - LINE ITEMS ARE SOURCE OF TRUTH
    quotes {
        uuid id PK
        uuid customer_id FK
        uuid bom_id FK
        uuid created_by FK
        text quote_number
        text status
        text accept_token_hash
        timestamptz created_at
        timestamptz updated_at
    }

    quote_lines {
        uuid id PK
        uuid quote_id FK
        text section "hardware|labor|travel"
        text description
        numeric quantity "SOURCE OF TRUTH"
        numeric unit_price_ex_vat "SOURCE OF TRUTH"
        numeric vat_rate "SOURCE OF TRUTH"
        uuid sku_id FK
        timestamptz created_at
    }

    quote_computed_totals {
        uuid quote_id FK "VIEW - derived"
        numeric hardware_total "computed"
        numeric labor_total "computed"
        numeric travel_total "computed"
        numeric subtotal_ex_vat "computed"
        numeric vat_total "computed"
        numeric total_inc_vat "computed"
    }

    %% Invoices - LINE ITEMS ARE SOURCE OF TRUTH
    invoices {
        uuid id PK
        uuid customer_id FK
        uuid bom_id FK
        uuid quote_id FK "nullable"
        uuid created_by FK
        text stripe_invoice_id UK "nullable"
        text invoice_number UK
        text currency
        text status
        boolean is_test
        text hosted_invoice_url
        text invoice_pdf_url
        timestamptz issued_at
        date due_date
        timestamptz finalized_at
        timestamptz paid_at
        timestamptz voided_at
        timestamptz created_at
        timestamptz updated_at
    }

    invoice_line_items {
        uuid id PK
        uuid invoice_id FK
        uuid sku_id FK
        text line_type
        text description
        numeric quantity "SOURCE OF TRUTH"
        numeric unit_price "SOURCE OF TRUTH"
        numeric tax_rate "SOURCE OF TRUTH"
        int sort_order
        timestamptz created_at
    }

    invoice_computed_totals {
        uuid invoice_id FK "VIEW - derived"
        numeric subtotal "computed"
        numeric tax "computed"
        numeric total "computed"
    }

    invoice_events {
        uuid id PK
        uuid invoice_id FK
        uuid created_by FK
        text event_type
        jsonb metadata
        timestamptz created_at
    }

    %% Relationships
    customers ||--o{ tickets : "has"
    customers ||--o{ invoices : "billed"
    customers ||--o{ boms : "owns"
    customers ||--o{ quotes : "receives"
    
    quotes |o--o{ invoices : "converts to"
    quotes ||--o{ quote_lines : "contains"
    quote_lines }o--|| quote_computed_totals : "aggregates to"
    
    invoices ||--o{ invoice_line_items : "contains"
    invoices ||--o{ invoice_events : "logs"
    invoice_line_items }o--|| invoice_computed_totals : "aggregates to"
    invoice_line_items }o--o| skus : "references"
    
    sku_categories ||--o{ skus : "categorizes"
    sku_categories ||--o{ margin_rules : "defines margin"

    contacts ||--o{ contact_messages : "has"
    contacts }o--o| customers : "converts to"

    tickets ||--o{ ticket_comments : "has"
    tickets ||--o{ ticket_attachments : "has"
    ticket_comments ||--o{ ticket_attachments : "has"

    templates ||--o{ template_items : "contains"
    template_items }o--|| skus : "references"

    boms ||--o{ bom_items : "contains"
    bom_items }o--|| skus : "references"

    quotes }o--o| boms : "from"
    quote_lines }o--o| skus : "references"
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
      
      // Force all text to be white - Mermaid uses various text elements
      const allTextElements = clonedSvg.querySelectorAll('text, tspan, .entityLabel, .attributeBoxEven, .attributeBoxOdd');
      allTextElements.forEach((el) => {
        (el as SVGElement).setAttribute('fill', '#ffffff');
        (el as SVGElement).style.fill = '#ffffff';
      });
      
      // Also target any text inside foreignObject
      const foreignTexts = clonedSvg.querySelectorAll('foreignObject *');
      foreignTexts.forEach((el) => {
        (el as HTMLElement).style.color = '#ffffff';
      });
      
      // Get the actual bounding box of the SVG content
      const bbox = svgElement.getBBox();
      const padding = 40;
      
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
      
      // Convert SVG to data URL (avoids tainted canvas issue)
      const svgData = new XMLSerializer().serializeToString(clonedSvg);
      const svgBase64 = btoa(unescape(encodeURIComponent(svgData)));
      const svgDataUrl = `data:image/svg+xml;base64,${svgBase64}`;
      
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = 2; // High resolution
        canvas.width = (bbox.width + padding * 2) * scale;
        canvas.height = (bbox.height + padding * 2) * scale;
        
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0);
          
          const link = document.createElement('a');
          link.download = 'database-erd.png';
          link.href = canvas.toDataURL('image/png');
          link.click();
        }
        
        setIsExporting(false);
      };
      
      img.onerror = () => {
        console.error('Failed to load SVG for export');
        setIsExporting(false);
      };
      
      img.src = svgDataUrl;
    } catch (error) {
      console.error('Failed to export diagram:', error);
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
