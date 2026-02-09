

# Progressive Onboarding Flow

## Overview
Transform the Contact page into the start of a low-friction onboarding funnel. New visitors submit their inquiry (plus optional home-profile questions), receive a magic link email to verify, set a password on first login, and land directly in the Home Profile page -- all without jargon or "account created" messaging.

## New Database Table

**home_profile_draft_answers** -- temporarily holds pre-verification answers keyed by email

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | gen_random_uuid() |
| email | text NOT NULL | Normalized email (not unique) |
| question_id | uuid NOT NULL FK → home_questions.id | links directly to real question
| answer_text| text NOT NULL | plain text answer
| created_at | timestamptz DEFAULT now() | |

- UNIQUE constraint on `email`, `question_id`
- RLS: no public access. Only the edge function (service role) reads/writes this table. Staff can SELECT for diagnostics.

## New / Modified Edge Functions

### 1. `send-contact-email` (modify)
Add to the existing handler:
- Accept optional array from the request body: [{ question_id, answer_text }] and upsert directly into home_profile_draft_answers.
- After successfully inserting the contact (success path), check if the email exists in `auth.users` using service role
- **If email already exists**: do nothing extra (existing user, normal success message)
- **If email is new**:
  - Save draft answers to `home_profile_draft_answers` (upsert by email)
  - Generate a magic link using `supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: appUrl + '/onboarding/set-password' } })`
  - Send a branded email via Resend with the magic link, using soft onboarding copy (no "account created" language)
  - Return `{ success: true, onboarding: true }` so the frontend knows to show the onboarding prompt
- For duplicate contacts: also check if email is in auth.users. If not, still offer onboarding (they submitted before but never verified)

### 2. `migrate-draft-profile` (new edge function)
Called after a user sets their password (authenticated request):
Behavior:
- Require authenticated user (JWT verified)
- Get auth.user.email
- Fetch all rows from home_profile_draft_answers where email = user.email
- Look up or create the customers row linked to this user
- For each draft row:
  - Upsert into home_answers using:
(customer_id, question_id, answer_text)
- Delete all draft rows for that email
- Return success

There is no mapping by text or keys. Draft answers already belong to real questions.

## New Pages

### `/onboarding/set-password` (new page)
Simple centered card (similar to ResetPassword.tsx):
- Title: "Valj ett losenord for ditt konto" / "Choose a password for your account"
- Two fields: Password, Confirm password
- On submit: `supabase.auth.updateUser({ password })`
- Then call `migrate-draft-profile` edge function
- Then redirect to `/portal/home-profile`
- Detects: user arrived via magic link (has session but is onboarding). Uses a flag in URL or session metadata.
- No "account created" language -- framed as "save your progress"

## Contact Page Changes

### Qustionnaire modifications
Make this modifications to questions here /portal/customers/questionnaire 
- Add a question "type" toggle which can be "boolean" or "text". 
  - boolean should make the answer appear as a checkbox
  - text should allow free form text (safely validate to prevent sql injection)
- Add a toggle to "display on contact form".
- Add column titles so that the "show/hide" toggle and new "display on contact form" can be differentiated.

### Form additions
Add a collapsible/visible section below the message field:
- Heading: "Hjalp oss forsta ditt hem (valfritt)" / "Help us understand your home (optional)"
- When rendering the optional “Help us understand your home” section:
  - Fetch questions from home_questions
  - where display_on_contact_form = true AND is_active = true
  - Before inserting draft answers, validate that avoiding SQL injection means only accepting question_id values that exist in home_questions where display_on_contact_form = true and is_active = true.
  - ordered by sort_order
- On submit, send: [{ question_id, answer_text }]
The send-contact-email edge function must upsert these directly into home_profile_draft_answers.

### Post-submit behavior
- If response includes `onboarding: true`: show a different success screen:
  - "Vill du spara tid? Kolla din e-post for att fylla i din hemprofil." / "Want to save time? Check your email to fill in your home profile."
  - Soft, encouraging copy -- no auth jargon
- If response does not include `onboarding` (existing user or duplicate): show normal "Tack for ditt meddelande!" message as today

## Auth Callback Handling
Update `AuthCallbackHandler` in App.tsx to handle magic link tokens:
- When `type=magiclink` is detected in hash params, redirect to `/onboarding/set-password`

## Route Additions
- `/onboarding/set-password` -- new SetPassword page

## Home Profile Banner
Add a conditional banner at the top of `HomeProfile.tsx`:
- Shown when the user has very few answers filled in (e.g. less than 2)
- Text: "Tack! Om du fyller i hemprofilen och lagger till bilder kan vi hjalpa dig mycket snabbare." / "Thanks! Filling in your home profile and adding photos helps us help you much faster."
- Dismissable (stored in localStorage)

## Security Rules
- **Before magic link verification**: no photo uploads, no home profile access, only minimal draft data stored server-side via service role
- **After verification + password set**: full authenticated access via existing RLS policies
- Draft data is email-keyed and only accessible by the edge function (service role); never exposed to the client
- Honeypot field remains active on the contact form
- Rate limiting remains active

## Files to Create/Modify

| File | Action |
|---|---|
| Migration SQL | New: `home_profile_draft_answers` table + RLS |
| `supabase/functions/send-contact-email/index.ts` | Modify: add draft save + magic link for new emails |
| `supabase/functions/migrate-draft-profile/index.ts` | New: migrate drafts to real answers on first login |
| `src/pages/Contact.tsx` | Modify: add optional home fields + onboarding success screen |
| `src/pages/onboarding/SetPassword.tsx` | New: password setup page for onboarding |
| `src/pages/portal/HomeProfile.tsx` | Modify: add welcome banner for new users |
| `src/App.tsx` | Modify: add route + update AuthCallbackHandler for magiclink type |
| `supabase/config.toml` | Modify: add `[functions.migrate-draft-profile]` (JWT verified, default) |

## Technical Notes
- Magic links use `supabase.auth.admin.generateLink({ type: 'magiclink' })` on the server side, which creates an auth user automatically if one doesn't exist (with email confirmed)
- The `send-contact-email` function already uses service role, so it can check auth.users and generate links
- The existing `AuthContext` auto-link logic (matching customer by email) will handle linking the new auth user to the customer record that staff creates later -- or the `migrate-draft-profile` function can create a customer record proactively
list, the migration function will skip them gracefully
- No changes to existing user flows -- existing customers with accounts see no difference

