
-- ============================================================
-- Home Profile feature: tables, bucket, RLS
-- ============================================================

-- 1. home_questions (staff-managed question list)
CREATE TABLE public.home_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question_text text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.home_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view questions"
  ON public.home_questions FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Staff can insert questions"
  ON public.home_questions FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update questions"
  ON public.home_questions FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete questions"
  ON public.home_questions FOR DELETE
  USING (public.is_staff(auth.uid()));

-- 2. home_answers (one answer per customer per question)
CREATE TABLE public.home_answers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.home_questions(id) ON DELETE CASCADE,
  answer_text text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE(customer_id, question_id)
);

ALTER TABLE public.home_answers ENABLE ROW LEVEL SECURITY;

-- Staff can do everything
CREATE POLICY "Staff can view all answers"
  ON public.home_answers FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert answers"
  ON public.home_answers FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update answers"
  ON public.home_answers FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete answers"
  ON public.home_answers FOR DELETE
  USING (public.is_staff(auth.uid()));

-- Customers can view/insert/update their own
CREATE POLICY "Customers can view own answers"
  ON public.home_answers FOR SELECT
  USING (customer_id = public.get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers can insert own answers"
  ON public.home_answers FOR INSERT
  WITH CHECK (customer_id = public.get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers can update own answers"
  ON public.home_answers FOR UPDATE
  USING (customer_id = public.get_customer_id_for_user(auth.uid()));

-- updated_at trigger
CREATE TRIGGER update_home_answers_updated_at
  BEFORE UPDATE ON public.home_answers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

-- 3. home_photos (installation photos)
CREATE TABLE public.home_photos (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  annotation_text text DEFAULT '',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid,
  visible_to_customer boolean NOT NULL DEFAULT true
);

ALTER TABLE public.home_photos ENABLE ROW LEVEL SECURITY;

-- Staff full access
CREATE POLICY "Staff can view all photos"
  ON public.home_photos FOR SELECT
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can insert photos"
  ON public.home_photos FOR INSERT
  WITH CHECK (public.is_staff(auth.uid()));

CREATE POLICY "Staff can update photos"
  ON public.home_photos FOR UPDATE
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Staff can delete photos"
  ON public.home_photos FOR DELETE
  USING (public.is_staff(auth.uid()));

-- Customer access (only visible photos)
CREATE POLICY "Customers can view own visible photos"
  ON public.home_photos FOR SELECT
  USING (
    customer_id = public.get_customer_id_for_user(auth.uid())
    AND visible_to_customer = true
  );

CREATE POLICY "Customers can insert own photos"
  ON public.home_photos FOR INSERT
  WITH CHECK (customer_id = public.get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers can update own photos"
  ON public.home_photos FOR UPDATE
  USING (customer_id = public.get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers can delete own photos"
  ON public.home_photos FOR DELETE
  USING (customer_id = public.get_customer_id_for_user(auth.uid()));

-- 4. Storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('home-photos', 'home-photos', false);

-- Storage RLS policies
CREATE POLICY "Staff can access all home photos"
  ON storage.objects FOR ALL
  USING (bucket_id = 'home-photos' AND public.is_staff(auth.uid()));

CREATE POLICY "Customers can access own home photos"
  ON storage.objects FOR ALL
  USING (
    bucket_id = 'home-photos'
    AND (storage.foldername(name))[1] = 'customers'
    AND (storage.foldername(name))[2] = public.get_customer_id_for_user(auth.uid())::text
  );
