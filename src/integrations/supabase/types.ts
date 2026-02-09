export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      billing_events: {
        Row: {
          created_at: string
          created_by: string | null
          event_type: string
          id: string
          metadata: Json | null
          quote_id: string | null
          stripe_invoice_id: string | null
          stripe_quote_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          event_type: string
          id?: string
          metadata?: Json | null
          quote_id?: string | null
          stripe_invoice_id?: string | null
          stripe_quote_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          event_type?: string
          id?: string
          metadata?: Json | null
          quote_id?: string | null
          stripe_invoice_id?: string | null
          stripe_quote_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_events_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "billing_events_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      bom_events: {
        Row: {
          actor_email: string | null
          actor_type: string | null
          bom_id: string
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
        }
        Insert: {
          actor_email?: string | null
          actor_type?: string | null
          bom_id: string
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
        }
        Update: {
          actor_email?: string | null
          actor_type?: string | null
          bom_id?: string
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "bom_events_bom_id_fkey"
            columns: ["bom_id"]
            isOneToOne: false
            referencedRelation: "boms"
            referencedColumns: ["id"]
          },
        ]
      }
      bom_items: {
        Row: {
          bom_id: string
          cost_ex_vat_at_time: number | null
          created_at: string
          id: string
          quantity: number
          sku_id: string
        }
        Insert: {
          bom_id: string
          cost_ex_vat_at_time?: number | null
          created_at?: string
          id?: string
          quantity?: number
          sku_id: string
        }
        Update: {
          bom_id?: string
          cost_ex_vat_at_time?: number | null
          created_at?: string
          id?: string
          quantity?: number
          sku_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bom_items_bom_id_fkey"
            columns: ["bom_id"]
            isOneToOne: false
            referencedRelation: "boms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bom_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      boms: {
        Row: {
          bom_group_id: string
          created_at: string
          created_by: string | null
          customer_id: string | null
          id: string
          project_name: string
          revision_created_at: string | null
          revision_created_by: string | null
          revision_reason_note: string | null
          revision_reason_type: string | null
          updated_at: string
          version: number
        }
        Insert: {
          bom_group_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          project_name: string
          revision_created_at?: string | null
          revision_created_by?: string | null
          revision_reason_note?: string | null
          revision_reason_type?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          bom_group_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          project_name?: string
          revision_created_at?: string | null
          revision_created_by?: string | null
          revision_reason_note?: string | null
          revision_reason_type?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "boms_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "boms_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_intake_events: {
        Row: {
          created_at: string
          email: string
          email_normalized: string
          error: Json | null
          id: string
          matched_entity_id: string | null
          matched_entity_type: string | null
          name: string
          payload: Json
          phone: string | null
          result: string
          source: string
        }
        Insert: {
          created_at?: string
          email: string
          email_normalized: string
          error?: Json | null
          id?: string
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          name: string
          payload?: Json
          phone?: string | null
          result: string
          source?: string
        }
        Update: {
          created_at?: string
          email?: string
          email_normalized?: string
          error?: Json | null
          id?: string
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          name?: string
          payload?: Json
          phone?: string | null
          result?: string
          source?: string
        }
        Relationships: []
      }
      contact_messages: {
        Row: {
          author_email: string
          author_type: string
          body: string
          contact_id: string
          created_at: string
          id: string
          source: string
        }
        Insert: {
          author_email: string
          author_type: string
          body: string
          contact_id: string
          created_at?: string
          id?: string
          source?: string
        }
        Update: {
          author_email?: string
          author_type?: string
          body?: string
          contact_id?: string
          created_at?: string
          id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          converted_at: string | null
          converted_to_customer_id: string | null
          created_at: string
          email: string
          email_token: string
          id: string
          message: string
          name: string
          phone: string | null
        }
        Insert: {
          converted_at?: string | null
          converted_to_customer_id?: string | null
          created_at?: string
          email: string
          email_token?: string
          id?: string
          message: string
          name: string
          phone?: string | null
        }
        Update: {
          converted_at?: string | null
          converted_to_customer_id?: string | null
          created_at?: string
          email?: string
          email_token?: string
          id?: string
          message?: string
          name?: string
          phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_converted_to_customer_id_fkey"
            columns: ["converted_to_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_converted_to_customer_id_fkey"
            columns: ["converted_to_customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          billing_city: string | null
          billing_postcode: string | null
          billing_same_as_site: boolean | null
          billing_street: string | null
          contact_id: string | null
          created_at: string
          id: string
          is_test: boolean
          site_city: string | null
          site_postcode: string | null
          site_street: string | null
          user_id: string | null
        }
        Insert: {
          billing_city?: string | null
          billing_postcode?: string | null
          billing_same_as_site?: boolean | null
          billing_street?: string | null
          contact_id?: string | null
          created_at?: string
          id?: string
          is_test?: boolean
          site_city?: string | null
          site_postcode?: string | null
          site_street?: string | null
          user_id?: string | null
        }
        Update: {
          billing_city?: string | null
          billing_postcode?: string | null
          billing_same_as_site?: boolean | null
          billing_street?: string | null
          contact_id?: string | null
          created_at?: string
          id?: string
          is_test?: boolean
          site_city?: string | null
          site_postcode?: string | null
          site_street?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      document_sequences: {
        Row: {
          key: string
          next_value: number
        }
        Insert: {
          key: string
          next_value?: number
        }
        Update: {
          key?: string
          next_value?: number
        }
        Relationships: []
      }
      invoice_events: {
        Row: {
          created_at: string
          created_by: string | null
          event_type: string
          id: string
          invoice_id: string
          metadata: Json | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          event_type: string
          id?: string
          invoice_id: string
          metadata?: Json | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          event_type?: string
          id?: string
          invoice_id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_computed_totals"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "invoice_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          category: string | null
          created_at: string
          description: string
          id: string
          invoice_id: string
          line_type: string
          quantity: number
          sku: string | null
          sku_id: string | null
          sort_order: number
          tax_rate: number
          unit: string | null
          unit_price: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          line_type: string
          quantity?: number
          sku?: string | null
          sku_id?: string | null
          sort_order?: number
          tax_rate?: number
          unit?: string | null
          unit_price?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          line_type?: string
          quantity?: number
          sku?: string | null
          sku_id?: string | null
          sort_order?: number
          tax_rate?: number
          unit?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoice_computed_totals"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount: number | null
          bom_id: string | null
          bom_version: number | null
          created_at: string
          created_by: string | null
          currency: string | null
          customer_id: string
          due_date: string | null
          finalized_at: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_number: string | null
          invoice_pdf_url: string | null
          is_test: boolean
          issued_at: string | null
          last_emailed_at: string | null
          last_emailed_to: string | null
          last_emailed_type: string | null
          paid_at: string | null
          pdf_url: string | null
          quote_id: string | null
          quote_number: string | null
          status: string | null
          stripe_invoice_id: string | null
          updated_at: string | null
          voided_at: string | null
        }
        Insert: {
          amount?: number | null
          bom_id?: string | null
          bom_version?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          customer_id: string
          due_date?: string | null
          finalized_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          invoice_pdf_url?: string | null
          is_test?: boolean
          issued_at?: string | null
          last_emailed_at?: string | null
          last_emailed_to?: string | null
          last_emailed_type?: string | null
          paid_at?: string | null
          pdf_url?: string | null
          quote_id?: string | null
          quote_number?: string | null
          status?: string | null
          stripe_invoice_id?: string | null
          updated_at?: string | null
          voided_at?: string | null
        }
        Update: {
          amount?: number | null
          bom_id?: string | null
          bom_version?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          customer_id?: string
          due_date?: string | null
          finalized_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_number?: string | null
          invoice_pdf_url?: string | null
          is_test?: boolean
          issued_at?: string | null
          last_emailed_at?: string | null
          last_emailed_to?: string | null
          last_emailed_type?: string | null
          paid_at?: string | null
          pdf_url?: string | null
          quote_id?: string | null
          quote_number?: string | null
          status?: string | null
          stripe_invoice_id?: string | null
          updated_at?: string | null
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_bom_id_fkey"
            columns: ["bom_id"]
            isOneToOne: false
            referencedRelation: "boms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "invoices_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      margin_rules: {
        Row: {
          category_id: string
          created_at: string
          description: string | null
          margin_percent: number
          rounding: number
          updated_at: string
        }
        Insert: {
          category_id: string
          created_at?: string
          description?: string | null
          margin_percent?: number
          rounding?: number
          updated_at?: string
        }
        Update: {
          category_id?: string
          created_at?: string
          description?: string | null
          margin_percent?: number
          rounding?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "margin_rules_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: true
            referencedRelation: "sku_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_emails: {
        Row: {
          body: string
          email_type: string
          id: string
          invoice_id: string | null
          quote_id: string
          recipient_email: string
          sent_at: string
          sent_by: string | null
          subject: string
        }
        Insert: {
          body: string
          email_type: string
          id?: string
          invoice_id?: string | null
          quote_id: string
          recipient_email: string
          sent_at?: string
          sent_by?: string | null
          subject: string
        }
        Update: {
          body?: string
          email_type?: string
          id?: string
          invoice_id?: string | null
          quote_id?: string
          recipient_email?: string
          sent_at?: string
          sent_by?: string | null
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_emails_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quote_emails_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_events: {
        Row: {
          actor_email: string | null
          actor_type: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          quote_id: string
        }
        Insert: {
          actor_email?: string | null
          actor_type?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          quote_id: string
        }
        Update: {
          actor_email?: string | null
          actor_type?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          quote_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_events_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quote_events_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_lines: {
        Row: {
          cost_ex_vat_at_time: number | null
          created_at: string
          description: string
          id: string
          original_sku_code: string | null
          original_sku_name: string | null
          pricing_source: string | null
          quantity: number
          quote_id: string
          section: string
          sku_id: string | null
          source_bom_id: string | null
          source_bom_item_id: string | null
          source_bom_version: number | null
          unit_price: number
          unit_price_ex_vat: number | null
          unit_price_inc_vat: number | null
          vat_rate: number | null
        }
        Insert: {
          cost_ex_vat_at_time?: number | null
          created_at?: string
          description: string
          id?: string
          original_sku_code?: string | null
          original_sku_name?: string | null
          pricing_source?: string | null
          quantity?: number
          quote_id: string
          section: string
          sku_id?: string | null
          source_bom_id?: string | null
          source_bom_item_id?: string | null
          source_bom_version?: number | null
          unit_price?: number
          unit_price_ex_vat?: number | null
          unit_price_inc_vat?: number | null
          vat_rate?: number | null
        }
        Update: {
          cost_ex_vat_at_time?: number | null
          created_at?: string
          description?: string
          id?: string
          original_sku_code?: string | null
          original_sku_name?: string | null
          pricing_source?: string | null
          quantity?: number
          quote_id?: string
          section?: string
          sku_id?: string | null
          source_bom_id?: string | null
          source_bom_item_id?: string | null
          source_bom_version?: number | null
          unit_price?: number
          unit_price_ex_vat?: number | null
          unit_price_inc_vat?: number | null
          vat_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_lines_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quote_lines_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_lines_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_lines_source_bom_id_fkey"
            columns: ["source_bom_id"]
            isOneToOne: false
            referencedRelation: "boms"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_messages: {
        Row: {
          author_email: string | null
          author_name: string | null
          author_type: string
          body_markdown: string
          created_at: string
          id: string
          quote_id: string
          source: string
        }
        Insert: {
          author_email?: string | null
          author_name?: string | null
          author_type: string
          body_markdown: string
          created_at?: string
          id?: string
          quote_id: string
          source?: string
        }
        Update: {
          author_email?: string | null
          author_name?: string | null
          author_type?: string
          body_markdown?: string
          created_at?: string
          id?: string
          quote_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_messages_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quote_messages_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          accept_token_expires_at: string | null
          accept_token_hash: string | null
          accepted_at: string | null
          accepted_by_email: string | null
          accepted_by_name: string | null
          accepted_ip: string | null
          accepted_user_agent: string | null
          bom_id: string | null
          bom_version: number | null
          cancelled_at: string | null
          cancelled_by_user_id: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          declined_at: string | null
          expires_at: string | null
          id: string
          invoice_due_date: string | null
          invoice_hosted_url: string | null
          invoice_number: string | null
          invoice_pdf_url: string | null
          invoice_status: string | null
          invoice_subtotal: number | null
          invoice_total: number | null
          invoice_vat: number | null
          is_latest: boolean
          is_test: boolean
          last_viewed_at: string | null
          parent_quote_id: string | null
          quote_number: string | null
          sent_at: string | null
          status: string
          status_reason: string | null
          stripe_invoice_id: string | null
          stripe_quote_id: string | null
          stripe_status: string | null
          superseded_at: string | null
          superseded_by_quote_id: string | null
          supersedes_quote_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          accept_token_expires_at?: string | null
          accept_token_hash?: string | null
          accepted_at?: string | null
          accepted_by_email?: string | null
          accepted_by_name?: string | null
          accepted_ip?: string | null
          accepted_user_agent?: string | null
          bom_id?: string | null
          bom_version?: number | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          declined_at?: string | null
          expires_at?: string | null
          id?: string
          invoice_due_date?: string | null
          invoice_hosted_url?: string | null
          invoice_number?: string | null
          invoice_pdf_url?: string | null
          invoice_status?: string | null
          invoice_subtotal?: number | null
          invoice_total?: number | null
          invoice_vat?: number | null
          is_latest?: boolean
          is_test?: boolean
          last_viewed_at?: string | null
          parent_quote_id?: string | null
          quote_number?: string | null
          sent_at?: string | null
          status?: string
          status_reason?: string | null
          stripe_invoice_id?: string | null
          stripe_quote_id?: string | null
          stripe_status?: string | null
          superseded_at?: string | null
          superseded_by_quote_id?: string | null
          supersedes_quote_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          accept_token_expires_at?: string | null
          accept_token_hash?: string | null
          accepted_at?: string | null
          accepted_by_email?: string | null
          accepted_by_name?: string | null
          accepted_ip?: string | null
          accepted_user_agent?: string | null
          bom_id?: string | null
          bom_version?: number | null
          cancelled_at?: string | null
          cancelled_by_user_id?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          declined_at?: string | null
          expires_at?: string | null
          id?: string
          invoice_due_date?: string | null
          invoice_hosted_url?: string | null
          invoice_number?: string | null
          invoice_pdf_url?: string | null
          invoice_status?: string | null
          invoice_subtotal?: number | null
          invoice_total?: number | null
          invoice_vat?: number | null
          is_latest?: boolean
          is_test?: boolean
          last_viewed_at?: string | null
          parent_quote_id?: string | null
          quote_number?: string | null
          sent_at?: string | null
          status?: string
          status_reason?: string | null
          stripe_invoice_id?: string | null
          stripe_quote_id?: string | null
          stripe_status?: string | null
          superseded_at?: string | null
          superseded_by_quote_id?: string | null
          supersedes_quote_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "quotes_bom_id_fkey"
            columns: ["bom_id"]
            isOneToOne: false
            referencedRelation: "boms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_parent_quote_id_fkey"
            columns: ["parent_quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quotes_parent_quote_id_fkey"
            columns: ["parent_quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_superseded_by_quote_id_fkey"
            columns: ["superseded_by_quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quotes_superseded_by_quote_id_fkey"
            columns: ["superseded_by_quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_supersedes_quote_id_fkey"
            columns: ["supersedes_quote_id"]
            isOneToOne: false
            referencedRelation: "quote_computed_totals"
            referencedColumns: ["quote_id"]
          },
          {
            foreignKeyName: "quotes_supersedes_quote_id_fkey"
            columns: ["supersedes_quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          identifier: string
          request_count: number
          window_start: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          identifier: string
          request_count?: number
          window_start?: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          identifier?: string
          request_count?: number
          window_start?: string
        }
        Relationships: []
      }
      sku_categories: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      sku_price_history: {
        Row: {
          category: string
          change_reason: string
          changed_at: string
          changed_by: string | null
          cost_ex_vat: number
          effective_margin_percent: number
          effective_rounding_sek: number
          id: string
          margin_override_percent: number | null
          purchase_includes_vat: boolean
          purchase_price: number
          rounding_override_sek: number | null
          rule_margin_percent: number
          rule_rounding_sek: number
          sell_price_ex_vat: number
          sell_price_inc_vat: number
          sku_id: string
          vat_rate: number
        }
        Insert: {
          category: string
          change_reason: string
          changed_at?: string
          changed_by?: string | null
          cost_ex_vat: number
          effective_margin_percent: number
          effective_rounding_sek: number
          id?: string
          margin_override_percent?: number | null
          purchase_includes_vat: boolean
          purchase_price: number
          rounding_override_sek?: number | null
          rule_margin_percent: number
          rule_rounding_sek: number
          sell_price_ex_vat: number
          sell_price_inc_vat: number
          sku_id: string
          vat_rate: number
        }
        Update: {
          category?: string
          change_reason?: string
          changed_at?: string
          changed_by?: string | null
          cost_ex_vat?: number
          effective_margin_percent?: number
          effective_rounding_sek?: number
          id?: string
          margin_override_percent?: number | null
          purchase_includes_vat?: boolean
          purchase_price?: number
          rounding_override_sek?: number | null
          rule_margin_percent?: number
          rule_rounding_sek?: number
          sell_price_ex_vat?: number
          sell_price_inc_vat?: number
          sku_id?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "sku_price_history_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      skus: {
        Row: {
          category_id: string
          cost_ex_vat: number | null
          cost_ex_vat_computed: number | null
          created_at: string
          default_margin: number | null
          effective_margin_percent: number | null
          effective_rounding_sek: number | null
          id: string
          image_path: string | null
          is_test: boolean
          margin_override_percent: number | null
          name: string
          notes: string | null
          pricing_updated_at: string | null
          purchase_includes_vat: boolean
          purchase_price: number
          rounding_override_sek: number | null
          sell_price_ex_vat: number | null
          sell_price_inc_vat: number | null
          sku: string
          supplier: string | null
          supplier_url: string | null
          updated_at: string
          vat_rate: number
        }
        Insert: {
          category_id: string
          cost_ex_vat?: number | null
          cost_ex_vat_computed?: number | null
          created_at?: string
          default_margin?: number | null
          effective_margin_percent?: number | null
          effective_rounding_sek?: number | null
          id?: string
          image_path?: string | null
          is_test?: boolean
          margin_override_percent?: number | null
          name: string
          notes?: string | null
          pricing_updated_at?: string | null
          purchase_includes_vat?: boolean
          purchase_price?: number
          rounding_override_sek?: number | null
          sell_price_ex_vat?: number | null
          sell_price_inc_vat?: number | null
          sku: string
          supplier?: string | null
          supplier_url?: string | null
          updated_at?: string
          vat_rate?: number
        }
        Update: {
          category_id?: string
          cost_ex_vat?: number | null
          cost_ex_vat_computed?: number | null
          created_at?: string
          default_margin?: number | null
          effective_margin_percent?: number | null
          effective_rounding_sek?: number | null
          id?: string
          image_path?: string | null
          is_test?: boolean
          margin_override_percent?: number | null
          name?: string
          notes?: string | null
          pricing_updated_at?: string | null
          purchase_includes_vat?: boolean
          purchase_price?: number
          rounding_override_sek?: number | null
          sell_price_ex_vat?: number | null
          sell_price_inc_vat?: number | null
          sku?: string
          supplier?: string | null
          supplier_url?: string | null
          updated_at?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "skus_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "sku_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_users: {
        Row: {
          created_at: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      template_items: {
        Row: {
          created_at: string
          id: string
          quantity: number
          sku_id: string
          template_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          quantity?: number
          sku_id: string
          template_id: string
        }
        Update: {
          created_at?: string
          id?: string
          quantity?: number
          sku_id?: string
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "template_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      ticket_attachments: {
        Row: {
          comment_id: string | null
          content_type: string
          created_at: string
          filename: string
          id: string
          size_bytes: number
          storage_path: string
          ticket_id: string
        }
        Insert: {
          comment_id?: string | null
          content_type: string
          created_at?: string
          filename: string
          id?: string
          size_bytes: number
          storage_path: string
          ticket_id: string
        }
        Update: {
          comment_id?: string | null
          content_type?: string
          created_at?: string
          filename?: string
          id?: string
          size_bytes?: number
          storage_path?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_attachments_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "ticket_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_attachments_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_comments: {
        Row: {
          author_email: string | null
          author_type: string
          author_user_id: string | null
          body_markdown: string
          created_at: string
          id: string
          source: string
          ticket_id: string
        }
        Insert: {
          author_email?: string | null
          author_type: string
          author_user_id?: string | null
          body_markdown: string
          created_at?: string
          id?: string
          source?: string
          ticket_id: string
        }
        Update: {
          author_email?: string | null
          author_type?: string
          author_user_id?: string | null
          body_markdown?: string
          created_at?: string
          id?: string
          source?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_comments_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          created_at: string
          created_by: string | null
          customer_id: string
          email_token: string
          id: string
          last_activity_at: string
          status: string
          ticket_number: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          customer_id: string
          email_token?: string
          id?: string
          last_activity_at?: string
          status?: string
          ticket_number?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          customer_id?: string
          email_token?: string
          id?: string
          last_activity_at?: string
          status?: string
          ticket_number?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      customers_with_identity: {
        Row: {
          billing_city: string | null
          billing_email: string | null
          billing_postcode: string | null
          billing_same_as_site: boolean | null
          billing_street: string | null
          contact_email: string | null
          contact_id: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string | null
          id: string | null
          is_test: boolean | null
          name: string | null
          phone: string | null
          site_city: string | null
          site_postcode: string | null
          site_street: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_computed_totals: {
        Row: {
          invoice_id: string | null
          subtotal: number | null
          tax: number | null
          total: number | null
        }
        Relationships: []
      }
      quote_computed_totals: {
        Row: {
          hardware_total: number | null
          labor_total: number | null
          quote_id: string | null
          subtotal_ex_vat: number | null
          total_inc_vat: number | null
          travel_total: number | null
          vat_total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      can_access_ticket_storage: {
        Args: { storage_path: string }
        Returns: boolean
      }
      generate_next_quote_number: { Args: never; Returns: string }
      get_customer_id_for_user: { Args: { _user_id: string }; Returns: string }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
      is_staff_table_empty: { Args: never; Returns: boolean }
      set_app_environment: { Args: { env: string }; Returns: undefined }
      sku_compute_pricing: {
        Args: {
          p_category_id: string
          p_margin_override_percent: number
          p_purchase_includes_vat: boolean
          p_purchase_price: number
          p_rounding_override_sek: number
          p_vat_rate: number
        }
        Returns: {
          cost_ex_vat_computed: number
          effective_margin_percent: number
          effective_rounding_sek: number
          rule_margin_percent: number
          rule_rounding_sek: number
          sell_price_ex_vat: number
          sell_price_inc_vat: number
        }[]
      }
      sku_insert_price_history: {
        Args: {
          p_category_id: string
          p_change_reason: string
          p_cost_ex_vat: number
          p_effective_margin_percent: number
          p_effective_rounding_sek: number
          p_margin_override_percent: number
          p_purchase_includes_vat: boolean
          p_purchase_price: number
          p_rounding_override_sek: number
          p_rule_margin_percent: number
          p_rule_rounding_sek: number
          p_sell_price_ex_vat: number
          p_sell_price_inc_vat: number
          p_sku_id: string
          p_vat_rate: number
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
