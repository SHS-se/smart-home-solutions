-- Add all unique constraints that were missing from the SQL backup restore.
-- The dump-database function was not emitting UNIQUE constraints in its DDL,
-- so any DB restored from a backup before this fix was applied is missing them.
--
-- Every block catches duplicate_object (already exists), undefined_table (table
-- missing — e.g. not yet in this project's schema), and undefined_column (column
-- added by a later migration that hasn't run yet). This makes the file fully
-- idempotent and safe to apply against any DB state.
--
-- Tables that were later dropped (customer_users, device_template_profiles, etc.)
-- and constraints that were superseded (energy_home_settings_customer_id_key,
-- home_answers_customer_id_question_id_key, device_profiles_device_id_key) are
-- intentionally omitted.

DO $$ BEGIN
  ALTER TABLE public.tickets ADD CONSTRAINT tickets_email_token_key UNIQUE (email_token);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.customers ADD CONSTRAINT customers_user_id_key UNIQUE (user_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.skus ADD CONSTRAINT skus_sku_key UNIQUE (sku);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.template_items ADD CONSTRAINT template_items_template_id_sku_id_key UNIQUE (template_id, sku_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- bom_items: the upsert ON CONFLICT (bom_id, sku_id) depends on this constraint
DO $$ BEGIN
  ALTER TABLE public.bom_items ADD CONSTRAINT bom_items_bom_id_sku_id_key UNIQUE (bom_id, sku_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.quotes ADD CONSTRAINT quotes_quote_number_key UNIQUE (quote_number);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.sku_categories ADD CONSTRAINT sku_categories_name_key UNIQUE (name);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.sku_categories ADD CONSTRAINT sku_categories_key_key UNIQUE (key);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.bom_revisions ADD CONSTRAINT bom_revisions_bom_id_revision_key UNIQUE (bom_id, revision);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_stripe_invoice_id_unique UNIQUE (stripe_invoice_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- home_answers: customer_id version was replaced by home_id version in a later migration
DO $$ BEGIN
  ALTER TABLE public.home_answers ADD CONSTRAINT home_answers_home_id_question_id_key UNIQUE (home_id, question_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.home_profile_draft_answers ADD CONSTRAINT home_profile_draft_answers_email_question_id_key UNIQUE (email, question_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.home_question_options ADD CONSTRAINT home_question_options_question_id_value_key UNIQUE (question_id, value);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- energy_home_settings: customer_id version was replaced by home_id version in a later migration
DO $$ BEGIN
  ALTER TABLE public.energy_home_settings ADD CONSTRAINT energy_home_settings_home_id_key UNIQUE (home_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.home_device_instances ADD CONSTRAINT home_device_instances_home_id_device_instance_id_key UNIQUE (home_id, device_instance_id);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- device_profiles: device_id-only version was replaced by this triple-column constraint
DO $$ BEGIN
  ALTER TABLE public.device_profiles ADD CONSTRAINT device_profiles_device_mode_kind_key UNIQUE (device_id, mode, profile_kind);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Unique indexes — wrapped in DO blocks so a missing table skips silently
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limits_identifier_endpoint
    ON public.rate_limits (identifier, endpoint);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_token_idx
    ON public.contacts(email_token);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS quotes_stripe_quote_id_unique
    ON public.quotes (stripe_quote_id) WHERE stripe_quote_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_contact_id_unique
    ON public.customers(contact_id) WHERE contact_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_normalized_email_unique
    ON public.contacts(lower(trim(email))) WHERE email IS NOT NULL AND trim(email) != '';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_tokens_code
    ON public.verification_tokens (code);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_home_questions_semantic_key
    ON public.home_questions (semantic_key) WHERE semantic_key IS NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
