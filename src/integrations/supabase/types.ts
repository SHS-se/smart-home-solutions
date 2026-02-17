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
          primary_home_id: string | null
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
          primary_home_id?: string | null
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
          primary_home_id?: string | null
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
          {
            foreignKeyName: "customers_primary_home_id_fkey"
            columns: ["primary_home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
        ]
      }
      device_template_profiles: {
        Row: {
          created_at: string
          created_by: string | null
          data: Json
          device_template_id: string
          id: string
          is_active: boolean
          notes: string | null
          profile_kind: string
          resolution_seconds: number
          source: string | null
          unit_power: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          data?: Json
          device_template_id: string
          id?: string
          is_active?: boolean
          notes?: string | null
          profile_kind: string
          resolution_seconds?: number
          source?: string | null
          unit_power?: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          data?: Json
          device_template_id?: string
          id?: string
          is_active?: boolean
          notes?: string | null
          profile_kind?: string
          resolution_seconds?: number
          source?: string | null
          unit_power?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "device_template_profiles_device_template_id_fkey"
            columns: ["device_template_id"]
            isOneToOne: false
            referencedRelation: "device_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      device_templates: {
        Row: {
          category: string
          controllable_default: boolean
          created_at: string
          created_by: string | null
          device_kind: string
          device_type: string
          display_name: string
          id: string
          is_deleted: boolean
          make: string
          max_electrical_power_w: number
          min_operating_temp_c: number | null
          model: string
          name: string
          scop: number | null
          shiftable_default: boolean
          specs: Json
        }
        Insert: {
          category: string
          controllable_default?: boolean
          created_at?: string
          created_by?: string | null
          device_kind?: string
          device_type: string
          display_name?: string
          id?: string
          is_deleted?: boolean
          make?: string
          max_electrical_power_w: number
          min_operating_temp_c?: number | null
          model?: string
          name: string
          scop?: number | null
          shiftable_default?: boolean
          specs?: Json
        }
        Update: {
          category?: string
          controllable_default?: boolean
          created_at?: string
          created_by?: string | null
          device_kind?: string
          device_type?: string
          display_name?: string
          id?: string
          is_deleted?: boolean
          make?: string
          max_electrical_power_w?: number
          min_operating_temp_c?: number | null
          model?: string
          name?: string
          scop?: number | null
          shiftable_default?: boolean
          specs?: Json
        }
        Relationships: []
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
      energy_devices: {
        Row: {
          controllable: boolean
          created_at: string
          device_template_id: string
          home_id: string
          id: string
          max_power_override_w: number | null
          name: string
          priority: number
          quantity: number
          shiftable: boolean
          updated_at: string
        }
        Insert: {
          controllable?: boolean
          created_at?: string
          device_template_id: string
          home_id: string
          id?: string
          max_power_override_w?: number | null
          name: string
          priority?: number
          quantity?: number
          shiftable?: boolean
          updated_at?: string
        }
        Update: {
          controllable?: boolean
          created_at?: string
          device_template_id?: string
          home_id?: string
          id?: string
          max_power_override_w?: number | null
          name?: string
          priority?: number
          quantity?: number
          shiftable?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "energy_devices_device_template_id_fkey"
            columns: ["device_template_id"]
            isOneToOne: false
            referencedRelation: "device_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "energy_devices_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
        ]
      }
      energy_home_settings: {
        Row: {
          created_at: string
          customer_id: string
          derived: Json
          home_id: string
          id: string
          overrides: Json
          tariff_instance_id: string | null
          thermal_capacity_class: string | null
          ua_w_per_k: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          derived?: Json
          home_id: string
          id?: string
          overrides?: Json
          tariff_instance_id?: string | null
          thermal_capacity_class?: string | null
          ua_w_per_k?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          derived?: Json
          home_id?: string
          id?: string
          overrides?: Json
          tariff_instance_id?: string | null
          thermal_capacity_class?: string | null
          ua_w_per_k?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "energy_home_settings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "energy_home_settings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "energy_home_settings_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: true
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "energy_home_settings_tariff_instance_id_fkey"
            columns: ["tariff_instance_id"]
            isOneToOne: false
            referencedRelation: "tariff_instances"
            referencedColumns: ["id"]
          },
        ]
      }
      energy_normalized_series: {
        Row: {
          created_at: string
          end_ts: string
          id: string
          quality: Json | null
          raw_upload_id: string | null
          series_kind: string
          start_ts: string
          step_seconds: number
          timezone: string
          values_w: Json
        }
        Insert: {
          created_at?: string
          end_ts: string
          id?: string
          quality?: Json | null
          raw_upload_id?: string | null
          series_kind: string
          start_ts: string
          step_seconds?: number
          timezone?: string
          values_w?: Json
        }
        Update: {
          created_at?: string
          end_ts?: string
          id?: string
          quality?: Json | null
          raw_upload_id?: string | null
          series_kind?: string
          start_ts?: string
          step_seconds?: number
          timezone?: string
          values_w?: Json
        }
        Relationships: [
          {
            foreignKeyName: "energy_normalized_series_raw_upload_id_fkey"
            columns: ["raw_upload_id"]
            isOneToOne: false
            referencedRelation: "energy_raw_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      energy_raw_uploads: {
        Row: {
          created_at: string
          detected_columns: Json | null
          device_id: string | null
          file_path: string
          file_type: string | null
          house_id: string | null
          id: string
          template_id: string | null
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          detected_columns?: Json | null
          device_id?: string | null
          file_path: string
          file_type?: string | null
          house_id?: string | null
          id?: string
          template_id?: string | null
          uploaded_by: string
        }
        Update: {
          created_at?: string
          detected_columns?: Json | null
          device_id?: string | null
          file_path?: string
          file_type?: string | null
          house_id?: string | null
          id?: string
          template_id?: string | null
          uploaded_by?: string
        }
        Relationships: []
      }
      home_answers: {
        Row: {
          answer_text: string
          answer_value: Json | null
          customer_id: string
          home_id: string
          id: string
          question_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          answer_text?: string
          answer_value?: Json | null
          customer_id: string
          home_id: string
          id?: string
          question_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          answer_text?: string
          answer_value?: Json | null
          customer_id?: string
          home_id?: string
          id?: string
          question_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "home_answers_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "home_answers_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "home_answers_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "home_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "home_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      home_photos: {
        Row: {
          annotation_text: string | null
          customer_id: string
          height: number | null
          home_id: string | null
          id: string
          original_filename: string | null
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
          visible_to_customer: boolean
          width: number | null
        }
        Insert: {
          annotation_text?: string | null
          customer_id: string
          height?: number | null
          home_id?: string | null
          id?: string
          original_filename?: string | null
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
          visible_to_customer?: boolean
          width?: number | null
        }
        Update: {
          annotation_text?: string | null
          customer_id?: string
          height?: number | null
          home_id?: string | null
          id?: string
          original_filename?: string | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
          visible_to_customer?: boolean
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "home_photos_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "home_photos_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "home_photos_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
        ]
      }
      home_profile_draft_answers: {
        Row: {
          answer_text: string
          answer_value: Json | null
          created_at: string
          email: string
          id: string
          question_id: string
        }
        Insert: {
          answer_text: string
          answer_value?: Json | null
          created_at?: string
          email: string
          id?: string
          question_id: string
        }
        Update: {
          answer_text?: string
          answer_value?: Json | null
          created_at?: string
          email?: string
          id?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "home_profile_draft_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "home_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      home_question_display_rules: {
        Row: {
          compare_value: Json | null
          created_at: string
          depends_on_question_id: string
          id: string
          logic_group: number
          operator: string
          question_id: string
        }
        Insert: {
          compare_value?: Json | null
          created_at?: string
          depends_on_question_id: string
          id?: string
          logic_group?: number
          operator: string
          question_id: string
        }
        Update: {
          compare_value?: Json | null
          created_at?: string
          depends_on_question_id?: string
          id?: string
          logic_group?: number
          operator?: string
          question_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "home_question_display_rules_depends_on_question_id_fkey"
            columns: ["depends_on_question_id"]
            isOneToOne: false
            referencedRelation: "home_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "home_question_display_rules_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "home_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      home_question_options: {
        Row: {
          created_at: string
          id: string
          label_en: string
          label_sv: string
          order_index: number
          question_id: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          label_en?: string
          label_sv: string
          order_index?: number
          question_id: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          label_en?: string
          label_sv?: string
          order_index?: number
          question_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "home_question_options_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "home_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      home_questions: {
        Row: {
          allow_other: boolean
          created_at: string
          display_on_contact_form: boolean
          id: string
          is_active: boolean
          order_index: number
          parent_question_id: string | null
          question_text: string
          question_text_en: string
          question_type: string
          semantic_key: string | null
          sort_order: number
        }
        Insert: {
          allow_other?: boolean
          created_at?: string
          display_on_contact_form?: boolean
          id?: string
          is_active?: boolean
          order_index?: number
          parent_question_id?: string | null
          question_text: string
          question_text_en?: string
          question_type?: string
          semantic_key?: string | null
          sort_order?: number
        }
        Update: {
          allow_other?: boolean
          created_at?: string
          display_on_contact_form?: boolean
          id?: string
          is_active?: boolean
          order_index?: number
          parent_question_id?: string | null
          question_text?: string
          question_text_en?: string
          question_type?: string
          semantic_key?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "home_questions_parent_question_id_fkey"
            columns: ["parent_question_id"]
            isOneToOne: false
            referencedRelation: "home_questions"
            referencedColumns: ["id"]
          },
        ]
      }
      homes: {
        Row: {
          address_text: string | null
          created_at: string
          customer_id: string
          id: string
          name: string
        }
        Insert: {
          address_text?: string | null
          created_at?: string
          customer_id: string
          id?: string
          name: string
        }
        Update: {
          address_text?: string | null
          created_at?: string
          customer_id?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "homes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
        ]
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
      model_runs: {
        Row: {
          created_at: string
          customer_id: string
          device_snapshot: Json
          home_id: string | null
          id: string
          inputs_snapshot: Json
          mode: string
          profile_snapshot: Json
          results_summary: Json
          scenario: string
          step_seconds: number
          tariff_snapshot: Json
          timeseries: Json | null
        }
        Insert: {
          created_at?: string
          customer_id: string
          device_snapshot?: Json
          home_id?: string | null
          id?: string
          inputs_snapshot?: Json
          mode: string
          profile_snapshot?: Json
          results_summary?: Json
          scenario: string
          step_seconds?: number
          tariff_snapshot?: Json
          timeseries?: Json | null
        }
        Update: {
          created_at?: string
          customer_id?: string
          device_snapshot?: Json
          home_id?: string | null
          id?: string
          inputs_snapshot?: Json
          mode?: string
          profile_snapshot?: Json
          results_summary?: Json
          scenario?: string
          step_seconds?: number
          tariff_snapshot?: Json
          timeseries?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "model_runs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "model_runs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "model_runs_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
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
      tariff_instances: {
        Row: {
          created_at: string
          customer_id: string
          energy_price_model: string
          energy_price_sek_per_kwh: number
          fixed_monthly_fee_sek: number
          home_id: string | null
          id: string
          is_active: boolean
          network_price_sek_per_w_month: number
          tariff_rule_id: string | null
          title: string | null
        }
        Insert: {
          created_at?: string
          customer_id: string
          energy_price_model?: string
          energy_price_sek_per_kwh?: number
          fixed_monthly_fee_sek?: number
          home_id?: string | null
          id?: string
          is_active?: boolean
          network_price_sek_per_w_month?: number
          tariff_rule_id?: string | null
          title?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string
          energy_price_model?: string
          energy_price_sek_per_kwh?: number
          fixed_monthly_fee_sek?: number
          home_id?: string | null
          id?: string
          is_active?: boolean
          network_price_sek_per_w_month?: number
          tariff_rule_id?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tariff_instances_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tariff_instances_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers_with_identity"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tariff_instances_home_id_fkey"
            columns: ["home_id"]
            isOneToOne: false
            referencedRelation: "homes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tariff_instances_tariff_rule_id_fkey"
            columns: ["tariff_rule_id"]
            isOneToOne: false
            referencedRelation: "tariff_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      tariff_rules: {
        Row: {
          created_at: string
          effective_from: string | null
          effective_to: string | null
          id: string
          is_active: boolean
          name: string
          params: Json
          provider: string
          rule_type: string
        }
        Insert: {
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          name: string
          params?: Json
          provider: string
          rule_type: string
        }
        Update: {
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          name?: string
          params?: Json
          provider?: string
          rule_type?: string
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
      verification_tokens: {
        Row: {
          code: string
          created_at: string
          email: string | null
          expires_at: string
          id: string
          redirect_path: string
          token_hash: string
          type: string
          used_at: string | null
        }
        Insert: {
          code: string
          created_at?: string
          email?: string | null
          expires_at: string
          id?: string
          redirect_path: string
          token_hash: string
          type: string
          used_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          redirect_path?: string
          token_hash?: string
          type?: string
          used_at?: string | null
        }
        Relationships: []
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
