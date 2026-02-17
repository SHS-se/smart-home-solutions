
-- Phase 1.1: Add primary_home_id to customers
ALTER TABLE public.customers ADD COLUMN primary_home_id uuid REFERENCES public.homes(id);

-- Create homes for the 3 customers that don't have one
INSERT INTO public.homes (customer_id, name)
SELECT c.id, 'My home'
FROM public.customers c
WHERE NOT EXISTS (SELECT 1 FROM public.homes h WHERE h.customer_id = c.id);

-- Set primary_home_id for ALL customers (first home by created_at)
UPDATE public.customers c
SET primary_home_id = (
  SELECT h.id FROM public.homes h
  WHERE h.customer_id = c.id
  ORDER BY h.created_at
  LIMIT 1
)
WHERE primary_home_id IS NULL;

-- Phase 1.2: Add home_id to home_answers (nullable first)
ALTER TABLE public.home_answers ADD COLUMN home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE;

-- Backfill home_id from customer's primary_home_id
UPDATE public.home_answers ha
SET home_id = c.primary_home_id
FROM public.customers c
WHERE c.id = ha.customer_id AND ha.home_id IS NULL;

-- Set NOT NULL
ALTER TABLE public.home_answers ALTER COLUMN home_id SET NOT NULL;

-- Drop old unique constraint
ALTER TABLE public.home_answers DROP CONSTRAINT home_answers_customer_id_question_id_key;

-- Add new unique constraint
ALTER TABLE public.home_answers ADD CONSTRAINT home_answers_home_id_question_id_key UNIQUE (home_id, question_id);

-- Phase 1.3: Add home_id to tariff_instances
ALTER TABLE public.tariff_instances ADD COLUMN home_id uuid REFERENCES public.homes(id) ON DELETE CASCADE;

-- Phase 1.4: Update RLS policies on home_answers
-- Drop existing customer policies
DROP POLICY "Customers can view own answers" ON public.home_answers;
DROP POLICY "Customers can insert own answers" ON public.home_answers;
DROP POLICY "Customers can update own answers" ON public.home_answers;

-- Create new home-scoped customer policies
CREATE POLICY "Customers can view own answers" ON public.home_answers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.homes
      WHERE homes.id = home_answers.home_id
      AND homes.customer_id = get_customer_id_for_user(auth.uid())
    )
  );

CREATE POLICY "Customers can insert own answers" ON public.home_answers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.homes
      WHERE homes.id = home_answers.home_id
      AND homes.customer_id = get_customer_id_for_user(auth.uid())
    )
  );

CREATE POLICY "Customers can update own answers" ON public.home_answers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.homes
      WHERE homes.id = home_answers.home_id
      AND homes.customer_id = get_customer_id_for_user(auth.uid())
    )
  );
