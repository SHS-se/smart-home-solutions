

## Fix: Allow anonymous visitors to see contact form questions

### The Problem
The contact page fetches `home_questions` from the client, but the current RLS policy only allows **authenticated** users to SELECT. Anonymous visitors (who are the primary audience of the contact form) get empty results -- the optional home profile questions simply don't appear.

### Is the "leaking logic" concern valid?
Not really for this use case. The `home_questions` table contains plain question text like "Do you have a heat pump?" -- there are no scoring rules, hidden logic, or sensitive business data. Exposing active, public-facing questions to anonymous visitors is the intended behavior.

### The Fix
Replace the current SELECT policy with two policies:

1. **Anonymous visitors** can read only the minimal fields needed, and only for questions explicitly marked as public (`display_on_contact_form = true AND is_active = true`)
2. **Authenticated users** can read all active questions (for the Home Profile page)
3. **Staff** already have full access via the existing staff policy (INSERT/UPDATE/DELETE)

### Database Migration

```sql
-- Drop the overly broad authenticated-only policy
DROP POLICY "Authenticated users can view questions" ON public.home_questions;

-- Anon + authenticated can see contact-form questions
CREATE POLICY "Anyone can view contact form questions"
  ON public.home_questions FOR SELECT
  TO anon, authenticated
  USING (is_active = true AND display_on_contact_form = true);

-- Authenticated users can also see all active questions (for Home Profile)
CREATE POLICY "Authenticated users can view active questions"
  ON public.home_questions FOR SELECT
  TO authenticated
  USING (is_active = true);
```

This way:
- Anonymous contact form visitors see only the questions meant for them
- Logged-in customers see all active questions on their Home Profile
- Staff retain full CRUD via existing policies
- Inactive or internal-only questions are never exposed to non-staff

### Code Changes
None required. The existing `Contact.tsx` query already filters by `is_active = true` and `display_on_contact_form = true`, which aligns perfectly with the new anon policy.

