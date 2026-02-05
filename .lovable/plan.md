

# Customer Detail: Offerter (Quotes) Integration

## Overview

Add a complete Offers/Quotes section to the internal staff Customer Detail view, including a dashboard card, a customer-scoped offers list, and a full offer detail page with timeline, messaging, and integration with the existing quote editor.

## What will be built

### 1. "Offerter" Card on Customer Dashboard

Add a fourth card to the existing 3-column grid on `/portal/customers/:customerId/overview`:

- **Title**: "Offerter" / "Quotes"
- **Primary number**: Count of quotes requiring action (`revision_requested` status)
- **Subtitle**: "X att hantera av Y totalt" / "X to handle of Y total"
- **Link**: "Visa alla" -> `/portal/customers/:customerId/offers`

Data fetched alongside existing ticket/invoice stats using queries on the `quotes` table filtered by `customer_id`.

### 2. Customer-Scoped Offers List Page

**Route**: `/portal/customers/:customerId/offers`

**New file**: `src/pages/portal/customer-view/CustomerViewOffers.tsx`

Following the exact pattern of `CustomerViewTickets.tsx` and `CustomerViewBilling.tsx`:

- Uses `CustomerViewLayout` wrapper
- Back link to customers list
- Status filter dropdown (All / Draft / Sent / Revision Requested / Accepted / Declined / etc.)
- Search by quote number or project name
- Table columns:
  - Quote number (mono font, with version badge if v > 1)
  - Project name (from BOM)
  - Status badge (reusing existing badge style from `QuotesList.tsx`)
  - Total inc VAT (from `quote_computed_totals` view)
  - Last activity (from `updated_at`)
  - Action indicator: amber dot/badge for `revision_requested`
- Rows are clickable, navigating to the offer detail page
- Sorted newest first by default

### 3. Offer Detail Page

**Route**: `/portal/customers/:customerId/offers/:quoteId`

**New file**: `src/pages/portal/customer-view/CustomerViewOfferDetail.tsx`

#### A) Summary Header
- Quote number + status badge
- Customer name
- Project name (from BOM)
- Key timestamps: Created, Sent, Viewed, Accepted/Declined (only those that exist)
- Total inc VAT, VAT breakdown, subtotal

#### B) Action Banner (conditional)
When `status === 'revision_requested'`:
- Amber alert banner: "Kunden har begart andringar -- uppdatera offerten och skicka igen."
- Primary CTA button: "Redigera & skicka igen" -> navigates to `/portal/quotes/:quoteId`

#### C) Staff Action Buttons
- **"Oppna i offertredigeraren"** -- always available, navigates to existing `/portal/quotes/:quoteId`
- **"Skicka igen"** -- calls the existing `send-quote-email` edge function, re-logs `sent` event
- **"Skapa ny revision"** (when status is `accepted`) -- duplicates quote + quote_lines into a new quote with incremented version, `parent_quote_id` set to current quote, status `draft`, then navigates to the new quote in the editor

For `declined`/`expired`/`cancelled` quotes: show "Duplicera som ny" which creates a fresh copy as a new draft.

#### D) Timeline (Event Log)
Reuse the existing `QuoteEventLog` component pattern but embedded directly in this page. Queries `quote_events` for this quote, renders a chronological timeline with icons and Swedish labels (same mapping already in `QuoteEventLog.tsx`).

#### E) Messages Section
- Query `quote_messages` for this quote, ordered by `created_at` ascending
- Render as a threaded conversation:
  - Customer messages (author_type=customer): left-aligned, distinct styling
  - Staff messages (author_type=staff): right-aligned
- Staff can compose and send a new message:
  - Textarea + Send button
  - Inserts into `quote_messages` with `author_type='staff'`, `source='portal'`
  - Also logs a `quote_events` entry with `event_type='message_posted'`

### 4. Editing Rules (enforced in UI)

| Current Status | Available Actions |
|---|---|
| `draft` / `sent` / `viewed` / `revision_requested` | Open editor, Resend email |
| `accepted` | "Skapa ny revision" (duplicates as new draft) |
| `invoiced` | View only |
| `declined` / `expired` / `cancelled` | "Duplicera som ny" (fresh copy) |

### 5. Routing

Add three new routes to `App.tsx` inside the "Staff viewing customer portal" section:

```text
/portal/customers/:customerId/offers          -> CustomerViewOffers
/portal/customers/:customerId/offers/:quoteId -> CustomerViewOfferDetail
```

Both wrapped in `CustomerViewWrapper` (same as existing customer view routes).

### 6. No Database Migration Needed

- `parent_quote_id` already exists on `quotes` table with FK to `quotes.id`
- `quote_events` and `quote_messages` tables already exist with proper schema
- `quote_computed_totals` view already provides aggregated totals
- RLS policies for `quotes`, `quote_events`, `quote_messages` already allow staff access
- No new columns or tables required

## Technical Details

### New Files
1. `src/pages/portal/customer-view/CustomerViewOffers.tsx` -- Offers list page
2. `src/pages/portal/customer-view/CustomerViewOfferDetail.tsx` -- Offer detail page

### Modified Files
1. `src/pages/portal/customer-view/CustomerViewDashboard.tsx` -- Add "Offerter" card + stats fetching
2. `src/App.tsx` -- Add 2 new routes

### Data Queries

**Dashboard stats** (added to existing `fetchStats`):
```sql
-- Total quotes + revision_requested count
SELECT status FROM quotes WHERE customer_id = :customerId AND is_latest = true
```

**Offers list**:
```sql
SELECT q.*, boms(project_name), quote_computed_totals(total_inc_vat)
FROM quotes q
WHERE q.customer_id = :customerId
ORDER BY q.created_at DESC
```

**Offer detail**:
```sql
-- Quote with customer + BOM
SELECT * FROM quotes WHERE id = :quoteId

-- Events timeline
SELECT * FROM quote_events WHERE quote_id = :quoteId ORDER BY created_at DESC

-- Messages thread
SELECT * FROM quote_messages WHERE quote_id = :quoteId ORDER BY created_at ASC
```

**Staff message insert**:
```sql
INSERT INTO quote_messages (quote_id, author_type, author_email, author_name, body_markdown, source)
VALUES (:quoteId, 'staff', :staffEmail, :staffName, :body, 'portal')

INSERT INTO quote_events (quote_id, event_type, actor_type, actor_email)
VALUES (:quoteId, 'message_posted', 'staff', :staffEmail)
```

### "Create New Revision" Logic (client-side)
1. Fetch current quote + quote_lines
2. Insert new quote row with: `parent_quote_id = current.id`, `version = current.version + 1`, `status = 'draft'`, `customer_id`, `bom_id` carried over, `is_latest = true`
3. Update current quote: `is_latest = false`
4. Copy all `quote_lines` from current quote to new quote
5. Navigate to `/portal/quotes/:newQuoteId`

### Resend Logic
Call `supabase.functions.invoke('send-quote-email', { body: { quote_id } })` -- the existing edge function handles token generation, email sending, status update, and event logging.

### Status Badge Helper
Extract the `getStatusBadge` function from `QuotesList.tsx` into a shared utility or import pattern to avoid duplication across the new pages.

### Grid Layout Update
The dashboard card grid changes from `md:grid-cols-3` to `md:grid-cols-2 lg:grid-cols-4` to accommodate the fourth card while remaining responsive.

