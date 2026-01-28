import { useEffect, useRef } from 'react';
import mermaid from 'mermaid';
import PortalLayout from '@/components/portal/PortalLayout';
import { useLanguage } from '@/contexts/LanguageContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const erdDiagram = `erDiagram
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

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      er: {
        useMaxWidth: true,
        layoutDirection: 'TB',
      },
    });

    const renderDiagram = async () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
        try {
          const { svg } = await mermaid.render('erd-diagram', erdDiagram);
          containerRef.current.innerHTML = svg;
        } catch (error) {
          console.error('Failed to render Mermaid diagram:', error);
          containerRef.current.innerHTML = '<p class="text-destructive">Failed to render diagram</p>';
        }
      }
    };

    renderDiagram();
  }, []);

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
            <CardTitle>{t('Entity Relationship Diagram', 'Entity Relationship Diagram')}</CardTitle>
            <CardDescription>
              {t(
                'Visar tabeller, kolumner och relationer i databasen.',
                'Shows tables, columns, and relationships in the database.'
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div 
              ref={containerRef} 
              className="overflow-auto max-h-[70vh] p-4 bg-muted/30 rounded-lg"
            />
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default ERDiagram;
