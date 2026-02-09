

# Home Profile Feature

## Overview
Add a "Home Profile" concept to the portal: a set of staff-defined questions with plain-text answers per customer, plus installation photos with annotations. Both customers and staff can view/edit.

## Database

### Tables

**home_questions** -- staff-managed question list
- `id` uuid PK
- `question_text` text NOT NULL
- `sort_order` int NOT NULL DEFAULT 0
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz DEFAULT now()

**home_answers** -- one answer per customer per question
- `id` uuid PK
- `customer_id` uuid FK -> customers(id) ON DELETE CASCADE
- `question_id` uuid FK -> home_questions(id) ON DELETE CASCADE
- `answer_text` text NOT NULL DEFAULT ''
- `updated_at` timestamptz DEFAULT now()
- `updated_by` uuid (auth user id)
- UNIQUE(customer_id, question_id)

**home_photos** -- installation photos
- `id` uuid PK
- `customer_id` uuid FK -> customers(id) ON DELETE CASCADE
- `storage_path` text NOT NULL
- `annotation_text` text DEFAULT ''
- `uploaded_at` timestamptz DEFAULT now()
- `uploaded_by` uuid
- `visible_to_customer` boolean DEFAULT true

### Storage
- New bucket `home-photos` (private)
- Path pattern: `customers/{customer_id}/{photo_id}.ext`
- RLS: staff can access all; customers can access their own (where visible_to_customer = true)

### RLS Policies
- **home_questions**: SELECT for authenticated users; INSERT/UPDATE/DELETE for staff only
- **home_answers**: SELECT/INSERT/UPDATE for staff + owning customer; DELETE for staff
- **home_photos**: SELECT for staff + owning customer (with visibility check); INSERT/UPDATE/DELETE for staff + owning customer; staff can toggle visibility

## Routes

| Route | Component | Who |
|---|---|---|
| `/portal/home-profile` | CustomerHomeProfile | Customer |
| `/portal/customers/questionnaire` | QuestionnaireManager | Staff |
| `/portal/customers/:customerId/home-profile` | CustomerViewHomeProfile | Staff (customer view) |

## UI Components

### 1. Customer Dashboard Card (Dashboard.tsx)
Add a "Home Profile" card in the customer dashboard grid (between Account and Billing). The entire card is clickable and navigates to `/portal/home-profile`. Shows:
- Title with Home icon
- Description text
- "Questions answered: X / Y"
- "Photos uploaded: N"
- No button -- whole card is the click target

### 2. Staff Customer View Card (CustomerViewDashboard.tsx)
Add a "Home Profile" card in the staff customer view grid. Clickable, navigates to `/portal/customers/:customerId/home-profile`. Same stats.

### 3. Customer Home Profile Page (`/portal/home-profile`)
Two stacked cards:

**Card 1 -- Your Home & Devices**
- Lists all active questions ordered by sort_order
- Each question: label + textarea for the answer
- "Save answers" button at the bottom
- Upserts into home_answers

**Card 2 -- Installation Photos**
- "Upload photo" button in card header
- 3-column grid of photo cards
- Each card: thumbnail (signed URL), annotation text, upload date, edit (pencil) icon for annotation
- Upload flow: file picker -> upload to storage -> insert home_photos row

### 4. Staff Question Manager (`/portal/customers/questionnaire`)
- List of all questions with drag-to-reorder or up/down arrows
- Each row: question text (editable inline or via modal), active/inactive toggle
- "Add question" button
- Staff-only page (redirect non-staff)

### 5. Staff Customer View Home Profile (`/portal/customers/:customerId/home-profile`)
Same layout as customer page but:
- Staff can edit answers
- Staff can toggle `visible_to_customer` per photo
- Wrapped in CustomerViewLayout with back navigation

## Files to Create/Modify

| File | Action |
|---|---|
| `supabase/migrations/...` | New migration: 3 tables + bucket + RLS |
| `src/pages/portal/HomeProfile.tsx` | New: customer home profile page |
| `src/pages/portal/customer-view/CustomerViewHomeProfile.tsx` | New: staff view of customer home profile |
| `src/pages/portal/settings/QuestionnaireManager.tsx` | New: staff question management |
| `src/pages/portal/Dashboard.tsx` | Add Home Profile card to customer grid + fetch stats |
| `src/pages/portal/customer-view/CustomerViewDashboard.tsx` | Add Home Profile card + fetch stats |
| `src/App.tsx` | Add 3 new routes |

## Technical Details

- Photos use signed URLs via `supabase.storage.from('home-photos').createSignedUrl(path, 3600)`
- Answer save uses upsert with `onConflict: 'customer_id,question_id'`
- Question reordering updates `sort_order` for affected rows
- The `updated_at` trigger on home_answers uses the existing `update_simple_updated_at` function
- Stats queries for the dashboard cards: count active questions, count answers for the customer, count photos for the customer
- All text is bilingual using the existing `t()` pattern

